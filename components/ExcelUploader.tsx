'use client';

import React from 'react';
import * as XLSX from 'xlsx';
import { differenceInDays } from 'date-fns';

interface ExcelUploaderProps {
  onDataLoaded: (data: any[]) => void;
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

export default function ExcelUploader({ onDataLoaded, baseDate = '2026-03-24' }: ExcelUploaderProps) {
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
          const remainingDays = Number(row['잔존일수']) || 0;
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

        // 1. Par Rate 시트 파싱 (시트명 동적 인식)
        const parRateSheetName = wb.SheetNames.find(n => n.toLowerCase().includes('par rate') || n.toLowerCase().includes('zero curve'));
        let parCurve: { t: number, rate: number }[] = [];

        if (parRateSheetName) {
          const prData = XLSX.utils.sheet_to_json(wb.Sheets[parRateSheetName]);
          parCurve = prData.map((row: any) => {
            const keys = Object.keys(row);
            const tenorKey = keys.find(k => String(k).includes('테너') || String(k).includes('연물')) || keys[0];
            const rateKey = keys.find(k => String(k).includes('당일') || String(k).includes('mid') || String(k).includes('금리'));
            
            return {
              t: parseTenorToYears(String(row[tenorKey] || '')),
              rate: Number(row[rateKey || '']) / 100
            };
          }).filter(item => item.t > 0 && !isNaN(item.rate))
            .sort((a, b) => a.t - b.t);
        }

        // [핵심] 2. Par Curve -> Zero Curve 부트스트래핑(Bootstrapping) 함수
        const bootstrapZeroCurve = (inputParCurve: {t: number, rate: number}[]) => {
          const zeroCurve: {t: number, rate: number}[] = [];
          
          // 보간용 내부 함수 (이전 구간의 DF를 구할 때 사용)
          const getInterpZero = (targetT: number, currentZero: {t: number, rate: number}[]) => {
            if (currentZero.length === 0) return inputParCurve[0]?.rate || 0.035;
            if (targetT <= currentZero[0].t) return currentZero[0].rate;
            if (targetT >= currentZero[currentZero.length - 1].t) return currentZero[currentZero.length - 1].rate;
            
            for (let i = 0; i < currentZero.length - 1; i++) {
              if (targetT >= currentZero[i].t && targetT <= currentZero[i+1].t) {
                const range = currentZero[i+1].t - currentZero[i].t;
                const weight = (targetT - currentZero[i].t) / range;
                return currentZero[i].rate * (1 - weight) + currentZero[i+1].rate * weight;
              }
            }
            return 0.035;
          };

          inputParCurve.forEach(point => {
            const { t, rate: parRate } = point;
            
            // 1년 이하 단기물은 현금흐름이 단순하여 Par Rate ≒ Zero Rate 로 가정
            if (t <= 1) {
              zeroCurve.push({ t, rate: parRate });
            } else {
              // 1년 초과 구간: Swap Pricing 공식 [1 = c * Sum(DF) + DF_n] 을 이용해 마지막 DF 역산
              let sumDF = 0;
              // 분기(0.25) 이자 지급 가정
              for (let i = 0.25; i < t; i += 0.25) {
                const zr = getInterpZero(i, zeroCurve);
                sumDF += Math.exp(-zr * i) * 0.25;
              }
              
              // 마지막 기간(t)의 할인율 역산 및 연속복리 Zero Rate 도출
              const df_t = (1 - parRate * sumDF) / (1 + parRate * 0.25);
              let zeroRate = -Math.log(df_t) / t;
              
              // 수학적 오류(NaN) 방지용 Fallback
              if (isNaN(zeroRate)) zeroRate = parRate; 
              
              zeroCurve.push({ t, rate: zeroRate });
            }
          });
          return zeroCurve;
        };

        //3. 최종 Zero Curve 생성 및 콘솔 확인
        let zeroCurve = bootstrapZeroCurve(parCurve);
        if (zeroCurve.length === 0) zeroCurve = [{ t: 0, rate: 0.03 }, { t: 30, rate: 0.03 }];

        
        // 커브가 비어있을 경우 Fallback (Flat 3%)
        if (zeroCurve.length === 0) zeroCurve = [{ t: 0, rate: 0.03 }, { t: 30, rate: 0.03 }];

        // 선형 보간법 (Linear Interpolation) 함수
        const getZeroRate = (t: number) => {
          if (t <= zeroCurve[0].t) return zeroCurve[0].rate;
          if (t >= zeroCurve[zeroCurve.length - 1].t) return zeroCurve[zeroCurve.length - 1].rate;
          for (let i = 0; i < zeroCurve.length - 1; i++) {
            if (t >= zeroCurve[i].t && t <= zeroCurve[i+1].t) {
              const range = zeroCurve[i+1].t - zeroCurve[i].t;
              const weight = (t - zeroCurve[i].t) / range;
              return zeroCurve[i].rate * (1 - weight) + zeroCurve[i+1].rate * weight;
            }
          }
          return 0.03;
        };

        // 특정 시점(t)의 Zero Rate를 선형 보간으로 구하는 함수
        const getInterpolatedZeroRate = (targetYears: number, curve: { t: number, rate: number }[]) => {
          if (!curve || curve.length === 0) return 0.035; // 커브가 없으면 Fallback 3.5%
          if (targetYears <= curve[0].t) return curve[0].rate;
          if (targetYears >= curve[curve.length - 1].t) return curve[curve.length - 1].rate;
          
          for (let i = 0; i < curve.length - 1; i++) {
            if (targetYears >= curve[i].t && targetYears <= curve[i+1].t) {
              const range = curve[i+1].t - curve[i].t;
              const weight = (targetYears - curve[i].t) / range;
              return curve[i].rate * (1 - weight) + curve[i+1].rate * weight;
            }
          }
          return 0.035;
        };

        // 동적 할인율(Discount Factor) 함수 - 연속 복리(Continuous Compounding) 적용
        const getDF = (t: number) => {
          const rate = getInterpolatedZeroRate(t, zeroCurve);
          return Math.exp(-rate * t); 
        };

        // 2. 파생상품(IRS) 파싱
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
  const lastFixingDate = parseExcelDate(row['Fixing Date']) || new Date(pricingDate.getTime() - 90 * 24 * 60 * 60 * 1000); // 없으면 대략 3개월 전

  // 정확한 일수(ACT/365) 기반 연수 계산
  const daysToMaturity = Math.max(0, differenceInDays(maturityDate, pricingDate));
  const daysToNextCoupon = Math.max(1, differenceInDays(nextCouponDate, pricingDate));
  const daysFromLastFixing = Math.max(0, differenceInDays(pricingDate, lastFixingDate));
  const daysInCurrentPeriod = daysFromLastFixing + daysToNextCoupon;

  const t_maturity = daysToMaturity / 365;
  const t_next = daysToNextCoupon / 365;

  const notional = Number(row['현재액면(원화)']) || 0;
  const sector = String(row['기초자산1']).includes('CD') ? 'IRS' : 'OIS';
  // 딜링룸 관행에 맞춘 부호: 수취(+) = 1, 지급(-) = -1
  const direction = String(row['지급 수취']).trim() === '수취' ? 1 : -1; 

  // 정확한 금리 파싱 및 Float Leg 재정의
const fixedRateStr = row['구조화쿠폰'] || row['계약이율'] || row['표면이율'] || row['고정금리'] || row['이율'];
  const fixedRate = fixedRateStr ? Number(fixedRateStr) / 100 : 0.035;

  const floatRateStr = row['변동쿠폰'] || row['변동금리'];
  const floatRate = floatRateStr ? Number(floatRateStr) / 100 : 0.0281; // 기본 2.81%

  const krdMap: { [key: string]: number } = {};
  const distributeToKRD = (targetYears: number, amount: number) => {
    if (targetYears >= 10) krdMap['10Y'] = (krdMap['10Y'] || 0) + amount;
    else if (targetYears <= (1/365)) krdMap['1D'] = (krdMap['1D'] || 0) + amount;
    else {
      let lower = pillars[0], upper = pillars[pillars.length - 1];
      for (let i = 0; i < pillars.length - 1; i++) {
        if (targetYears >= pillars[i].y && targetYears < pillars[i+1].y) {
          lower = pillars[i]; upper = pillars[i+1]; break;
        }
      }
      const range = upper.y - lower.y;
      const weightUpper = (targetYears - lower.y) / range;
      const weightLower = 1 - weightUpper;
      krdMap[lower.name] = (krdMap[lower.name] || 0) + (amount * weightLower);
      krdMap[upper.name] = (krdMap[upper.name] || 0) + (amount * weightUpper);
    }
  };

  // Float Leg는 '다음 리셋일에 원금+이자를 받는 채권(FRN)'과 완벽히 동일함
  const expectedFloatCoupon = notional * floatRate * (daysInCurrentPeriod / 365);
  const floatPV = (notional + expectedFloatCoupon) * getDF(t_next);
  const floatDV01 = floatPV * t_next * 0.0001 * (-direction);
  distributeToKRD(t_next, floatDV01);
  let totalPVBP = floatDV01;

  const dt = 1 / 365;
  const tomFloatPV = (notional + expectedFloatCoupon) * getDF(Math.max(0, t_next - dt));

  // 2. Fixed Leg의 Cashflow 일수 적용 및 세타(Theta) 고도화
  let baseFixedPV = 0, tomFixedPV = 0;
  let current_t = t_next;

  while (current_t <= t_maturity + 0.05) {
    const isMaturity = (current_t + 0.1 > t_maturity);
    const cf_time = isMaturity ? t_maturity : current_t;
    
    // 0.25 대신 실제 분기 일수 비율(약 91일/365일) 적용
    const periodFraction = isMaturity ? (cf_time - (current_t - 0.25)) : 91 / 365;
    const interestCF = notional * fixedRate * periodFraction;
    const principalCF = isMaturity ? notional : 0;
    const totalCF = interestCF + principalCF;
    
    const pv = totalCF * getDF(cf_time);
    const dv01 = pv * cf_time * 0.0001 * direction;
    distributeToKRD(cf_time, dv01);
    totalPVBP += dv01;

    baseFixedPV += pv;
    tomFixedPV += totalCF * getDF(Math.max(0, cf_time - dt));
    
    if (isMaturity) break;
    current_t += 0.25; // 다음 스텝
  }

  // [세타(Theta) 이중 카운팅 제거 및 통합]
// Zero Curve가 동적으로 연결되었으므로, tomNPV와 baseNPV의 차이값에 
// 이미 '할인율 언와인딩(Carry)'과 '커브 롤다운(Roll-down)'이 모두 녹아있음!
const baseNPV = (baseFixedPV - floatPV) * direction;
const tomNPV = (tomFixedPV - tomFloatPV) * direction;

// 불필요한 dailyCarry 수동 계산 로직 전면 삭제.
// 순수 NPV 변화량만으로 완벽한 Spot Theta 산출.
const expectedThetaPnL = tomNPV - baseNPV; 


  let expectedDeltaPnL = 0;
  Object.entries(krdMap).forEach(([tenor, pvbp]) => {
    const t_years = parseTenorToYears(tenor);
    const shockBp = getInterpolatedShock(t_years, swapShockCurve);
    expectedDeltaPnL += pvbp * (-shockBp); 
  });

  // 최종 객체 반환
  return {
    id: `irs-${index}`,
    name: String(row['종목명']) || '',
    book: bookName,
    bondType: 'swap',
    sector: sector,
    notional: notional,
    evaluationAmount: Number(row['평가금액']) || 0,
    remainingDays: t_maturity * 365,
    tenor: '10Y',
    pvbp: totalPVBP,
    entryYield: 0,
    duration: t_maturity * 0.95 * direction,
    krdMap: krdMap,
    nextFixingDate: nextCouponDate,
    currentFloatRate: floatRate,
    expectedDeltaPnL: expectedDeltaPnL,
    expectedThetaPnL: expectedThetaPnL
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
