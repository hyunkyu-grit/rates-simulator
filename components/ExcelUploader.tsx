'use client';

import React from 'react';
import * as XLSX from 'xlsx';
import { differenceInDays } from 'date-fns';

interface ExcelUploaderProps {
  onDataLoaded: (data: any[]) => void;
  onParRatesLoaded?: (parRates: { t: number; rate: number }[]) => void;
  baseDate?: string;
}

// 엑셀 날짜 안전 파싱 함수
const parseExcelDate = (excelDate: any) => {
  if (!excelDate) return new Date();
  if (typeof excelDate === 'number') {
    return new Date(Math.round((excelDate - 25569) * 86400 * 1000));
  }
  return new Date(excelDate);
};

// KRD 기둥 (4Y, 7Y 포함)
const pillars = [
  { name: '1D', y: 1/365 }, { name: '3M', y: 0.25 }, { name: '6M', y: 0.5 }, { name: '9M', y: 0.75 },
  { name: '1Y', y: 1 }, { name: '1.5Y', y: 1.5 }, { name: '2Y', y: 2 },
  { name: '3Y', y: 3 }, { name: '4Y', y: 4 }, { name: '5Y', y: 5 },
  { name: '7Y', y: 7 }, { name: '10Y', y: 10 }
];

export default function ExcelUploader({ onDataLoaded, onParRatesLoaded, baseDate = '2026-03-24' }: ExcelUploaderProps) {
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });

        // 변동표 파싱
        const bondShockSheet = wb.SheetNames.find(n => n.includes('채권 변동표'));
        const swapShockSheet = wb.SheetNames.find(n => n.includes('스왑 변동표'));

        // 테너(문자열)를 연 단위(숫자)로 변환하는 헬퍼 함수
        const parseTenorToYears = (tenor: string) => {
          const t = String(tenor).toUpperCase().replace('년', 'Y').replace('개월', 'M').replace('일', 'D').trim();
          if (t.includes('Y')) return parseFloat(t) || 0;
          if (t.includes('M')) return (parseFloat(t) || 0) / 12;
          if (t.includes('D')) return (parseFloat(t) || 0) / 365;
          return parseFloat(t) || 0;
        };

        // [채권 전용 다중 섹터 커브 파서]
        const buildBondShockCurves = (sheetName: string | undefined) => {
          if (!sheetName) return {};
          const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]);
          const curves: { [key: string]: { t: number, val: number }[] } = {};
          
          if (data.length === 0) return curves;
          const keys = Object.keys(data[0] as any);
          const tenorKey = keys.find(k => String(k).includes('연물') || String(k).includes('테너')) || keys[0];

          // '테너', '금리' 열을 제외한 모든 열을 크레딧 섹터로 인식하여 배열 초기화
          keys.forEach(k => {
            if (k !== tenorKey && !String(k).includes('금리') && !String(k).includes('Mid')) {
              curves[k] = [];
            }
          });

          // 데이터 채우기
          data.forEach((row: any) => {
            const t = parseTenorToYears(String(row[tenorKey] || ''));
            if (t <= 0) return;
            Object.keys(curves).forEach(sectorKey => {
              const val = Number(row[sectorKey]);
              if (!isNaN(val)) curves[sectorKey].push({ t, val });
            });
          });

          // 각 커브 t 기준으로 정렬
          Object.keys(curves).forEach(k => curves[k].sort((a, b) => a.t - b.t));
          return curves;
        };

        // 스왑용 단일 커브 파서 (기존 로직 유지)
        const buildShockCurve = (sheetName: string | undefined, type: 'bond' | 'swap') => {
          if (!sheetName) return [];
          const data = XLSX.utils.sheet_to_json(wb.Sheets[sheetName]); 
          const curve: { t: number, val: number }[] = [];
          
          data.forEach((row: any) => {
            const keys = Object.keys(row);
            if (keys.length === 0) return;
            
            const tenorKey = keys.find(k => String(k).includes('연물') || String(k).includes('테너')) || keys[0];
            let t_str = String(row[tenorKey] || '');
            let val = 0;
            
            if (type === 'swap') {
              const shockKey = keys.find(k => String(k).includes('전일비') || String(k).includes('bp'));
              if (!shockKey) return;
              val = Number(row[shockKey]) || 0;
            } else {
              const shockKey = keys.find(k => String(k).includes('국채'));
              if (!shockKey) return;
              val = Number(row[shockKey]) || 0;
            }
            
            const t = parseTenorToYears(t_str);
            if (t > 0 && !isNaN(val)) curve.push({ t, val });
          });
          return curve.sort((a, b) => a.t - b.t);
        };

        const bondShockCurves = buildBondShockCurves(bondShockSheet); // { '국채': [...], '은행채': [...], '카드채': [...] }
        const swapShockCurve = buildShockCurve(swapShockSheet, 'swap'); // 스왑은 기존 단일 커브 로직 유지

        
        // 특정 시점(t)의 변동폭(bp)을 선형 보간하는 함수
        const getInterpolatedShock = (targetYears: number, curve: { t: number, val: number }[]) => {
          if (curve.length === 0) return 0;
          if (targetYears <= curve[0].t) return curve[0].val;
          if (targetYears >= curve[curve.length - 1].t) return curve[curve.length - 1].val;
          
          for (let i = 0; i < curve.length - 1; i++) {
            if (targetYears >= curve[i].t && targetYears <= curve[i+1].t) {
              const range = curve[i+1].t - curve[i].t;
              const weight = (targetYears - curve[i].t) / range;
              return curve[i].val * (1 - weight) + curve[i+1].val * weight;
            }
          }
          return 0;
        };

        // 1. 현물 채권 파싱
        const bondSheetName = wb.SheetNames.find(n => n.includes('채권')) || wb.SheetNames[0];
        const bondSheet = wb.Sheets[bondSheetName];
        const bondData = XLSX.utils.sheet_to_json(bondSheet);

        const parsedBonds = bondData.map((row: any, index: number) => {
          const remainingDays = Math.round(Number(row['잔존일수']) || 0);
          const years = remainingDays / 365;

          // [수정1] 10,000으로 나누어 정확한 1bp(PVBP) 가치로 환산!
          const rawPvbp = Number(row['Duration가중 평가액']) || 0;
          const pvbp = rawPvbp / 10000; 

          // [수정] 상품소분류명을 활용한 직관적이고 정확한 섹터 맵핑
          const subClass = String(row['상품소분류명'] || '').trim();
          let mappedSector = '기타';

          switch (subClass) {
            case '국고채':
              mappedSector = '국고채'; 
              break;
            case '통안채':
              mappedSector = '통안채'; 
              break;
            case '특수은행채':
              mappedSector = '특은채'; 
              break;
            case '일반은행채':
              mappedSector = '시은채';
              break;
            case '공사공단채':
            case '비금융특수채':
            case '지방공사특수채':
              mappedSector = '공사채'; 
              break;
            case '금융회사채': // 카드/캐피탈 등 여신전문금융사
              mappedSector = '여전채'; 
              break;
            case '일반사채':
              mappedSector = '회사채'; 
              break;
            default:
              mappedSector = '기타';
          }

          // 잔존일수에 따른 테너(KRD 버킷) 맵핑 (10년 초과 구간은 30Y로 통합)
          let tenor = '30Y'; // 10년을 초과하는 만기는 기본값인 30Y로 맵핑
          if (years <= 0.25) tenor = '3M';
          else if (years <= 0.5) tenor = '6M';
          else if (years <= 0.75) tenor = '9M';
          else if (years <= 1) tenor = '1Y';
          else if (years <= 1.5) tenor = '1.5Y';
          else if (years <= 2) tenor = '2Y';
          else if (years <= 3) tenor = '3Y';
          else if (years <= 4) tenor = '4Y';
          else if (years <= 5) tenor = '5Y';
          else if (years <= 7) tenor = '7Y';
          else if (years <= 10) tenor = '10Y';
          // 10년을 초과하면 조건문에 걸리지 않고 기본값인 '30Y'가 유지됨

          const krdMap: { [key: string]: number } = {};
          krdMap[tenor] = pvbp;

          const bondMaturityDate = new Date(new Date(baseDate).getTime() + remainingDays * 86400000);
          const bondMaturityStr = `${bondMaturityDate.getFullYear()}-${String(bondMaturityDate.getMonth()+1).padStart(2,'0')}-${String(bondMaturityDate.getDate()).padStart(2,'0')}`;

          return {
            id: `bond-${index}`,
            name: String(row['종목명'] || ''),
            book: String(row['펀드명'] || 'RP Fund'),
            bondType: 'cash',
            sector: mappedSector, // 맵핑된 섹터 사용
            maturityDate: bondMaturityStr,
            notional: (Number(row['결제장부수량(만)']) || 0) * 10000,
            evaluationAmount: Number(row['평가금액']) || 0,
            remainingDays,
            tenor,
            pvbp,
            entryYield: Number(row['매수수익율']) || 0,
            mtmYield: Number(row['민평수익율']) || 0, // MTM 관행 민평수익율
            duration: Number(row['듀레이션']) || 0,
            krdMap
          };

          // 채권 섹터 -> 엑셀 헤더 매핑 로직
          let curveKey = '국채';
          if (mappedSector.includes('국고') || mappedSector.includes('통안')) curveKey = '국채';
          else if (mappedSector.includes('시은')) curveKey = '은행채';
          else if (mappedSector.includes('특은') || mappedSector.includes('공사')) curveKey = bondShockCurves['특은채'] ? '특은채' : '은행채';
          else if (mappedSector.includes('여전')) curveKey = '카드채';
          else if (mappedSector.includes('회사')) curveKey = '회사채';

          // 매핑된 커브가 없으면 안전하게 국채 커브로 Fallback
          const targetCurve = bondShockCurves[curveKey] || bondShockCurves['국채'] || [];

          let expectedDeltaPnL = 0;
          Object.entries(krdMap).forEach(([tenor, pvbp]) => {
            const t_years = parseTenorToYears(tenor);
            const shockBp = getInterpolatedShock(t_years, targetCurve);
            expectedDeltaPnL += pvbp * (-shockBp); 
          });

          return {
            id: `bond-${index}`,
            name: String(row['종목명'] || ''),
            book: String(row['펀드명'] || 'RP Fund'),
            bondType: 'cash',
            sector: mappedSector, // 맵핑된 섹터 사용
            notional: (Number(row['결제장부수량(만)']) || 0) * 10000,
            evaluationAmount: Number(row['평가금액']) || 0,
            remainingDays,
            tenor,
            pvbp,
            entryYield: Number(row['매수수익율']) || 0,
            mtmYield: Number(row['민평수익율']) || 0, // MTM 관행 민평수익율
            expectedDeltaPnL, // 예상 델타 손익
            duration: Number(row['듀레이션']) || 0,
            krdMap
          };
        });

        // 2. IRS Par Rate 시트 파싱 (원장만 — 연산 없이 백엔드로 전달)
        let irsParRates: { t: number; rate: number }[] = [];
        const parRateSheetName = wb.SheetNames.find(
          n => n.toLowerCase().includes('par rate') || n.toLowerCase().includes('zero curve')
        );
        if (parRateSheetName) {
          const prData = XLSX.utils.sheet_to_json(wb.Sheets[parRateSheetName]);
          irsParRates = (prData as any[]).map((row: any) => {
            const keys = Object.keys(row);
            const tenorKey = keys.find(k => String(k).includes('테너') || String(k).includes('연물')) || keys[0];
            const rateKey  = keys.find(k => String(k).includes('당일') || String(k).includes('mid') || String(k).includes('금리'));
            const t = parseTenorToYears(String(row[tenorKey] || ''));
            const rate = rateKey ? Number(row[rateKey]) / 100 : 0;
            return { t, rate };
          }).filter(item => item.t > 0 && !isNaN(item.rate));
          if (onParRatesLoaded) onParRatesLoaded(irsParRates);
        }

        // 3. 파생상품(IRS) 파싱
        let parsedIRS: any[] = [];
        const irsSheetName = wb.SheetNames.find(n => n.includes('IRS'));
        
        if (irsSheetName) {
          const irsSheet = wb.Sheets[irsSheetName];
          const irsData = XLSX.utils.sheet_to_json(irsSheet);

          parsedIRS = irsData.map((row: any, index: number) => {
  const rawBook = String(row['PORTFOLIO명'] || '').trim();
  const bookName = rawBook.includes('파생') ? 'RP Fund' : rawBook;

  // 엑셀에서 날짜 파싱 (기존 로직 유지하되 Fixing Date 추가)
  const pricingDate = new Date(baseDate);
  const maturityDate = parseExcelDate(row['만기일']);
  const nextCouponDate = parseExcelDate(row['차기지급일자']);
  // 정확한 일수(ACT/365) 기반 연수 계산
  const daysToMaturity = Math.max(0, differenceInDays(maturityDate, pricingDate));
  const t_maturity = daysToMaturity / 365;

  const notional = Number(row['현재액면(원화)']) || 0;
  const sector = String(row['기초자산1']).includes('CD') ? 'IRS' : 'OIS';
  // 딜링룸 관행에 맞춘 부호: 수취(+) = 1, 지급(-) = -1
  const direction = String(row['지급 수취']).trim() === '수취' ? 1 : -1; 

  // 금리 파싱 — % 단위로 저장 (백엔드 quant_engine 단위 규약 일치)
  const fixedRateStr = row['구조화쿠폰'] || row['계약이율'] || row['표면이율'] || row['고정금리'] || row['이율'];
  const couponRate = fixedRateStr ? Number(fixedRateStr) : 3.5;  // % 단위, e.g. 3.50

  const floatRateStr = row['변동쿠폰'] || row['변동금리'];
  const currentFloatRate = floatRateStr ? Number(floatRateStr) : 2.81;  // % 단위, e.g. 2.81

  // PVBP / krdMap / Delta / Theta는 백엔드(QuantLib)에서 산출 — 프론트는 원장만 전달

  const irsMaturityStr = `${maturityDate.getFullYear()}-${String(maturityDate.getMonth()+1).padStart(2,'0')}-${String(maturityDate.getDate()).padStart(2,'0')}`;

  // 최종 객체 반환
  return {
    id: `irs-${index}`,
    name: String(row['종목명']) || '',
    book: bookName,
    bondType: 'swap',
    sector: sector,
    maturityDate: irsMaturityStr,
    notional: notional,
    evaluationAmount: Number(row['평가금액']) || 0,
    remainingDays: Math.round(t_maturity * 365),
    tenor: '10Y',
    couponRate,           // 고정금리 (% 단위) — 백엔드 PVBP 산출용
    direction,             // +1=receive-fixed, -1=pay-fixed
    currentFloatRate,      // 변동금리 (% 단위) — 백엔드 PVBP 산출용
    pvbp: 0,
    entryYield: 0,
    duration: t_maturity * 0.95 * direction,
    krdMap: {},
    nextFixingDate: nextCouponDate,
    expectedDeltaPnL: 0,
    expectedThetaPnL: 0
  };
}).filter(Boolean);
        }

        const validPositions = [...parsedBonds, ...parsedIRS];
        onDataLoaded(validPositions);

      } catch (error) {
        console.error('엑셀 파싱 오류:', error);
        alert('파일 파싱 중 오류가 발생했습니다. 파일 형식을 확인해주세요.');
      }
    };
    reader.readAsBinaryString(file);
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6 shadow-xl flex flex-col justify-center items-center h-full min-h-[120px]">
      <h2 className="text-lg font-semibold text-blue-300 mb-4">포트폴리오 업로드</h2>
      <label className="cursor-pointer bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded transition">
        <span>엑셀 파일 선택</span>
        <input type="file" accept=".xlsx, .xls, .csv" onChange={handleFileUpload} className="hidden" />
      </label>
    </div>
  );
}
