'use client';

import React from 'react';
import * as XLSX from 'xlsx';

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

// 경험적 PVBP 커브 (100억 당 1bp 환산)
const calculateExactFixedPvbp = (years: number, notional: number, direction: number) => {
  let multiplier = 0;
  if (years <= 1) multiplier = years * 9.8;
  else if (years <= 2) multiplier = 9.8 + (years - 1) * 9.4;
  else if (years <= 3) multiplier = 19.2 + (years - 2) * 9.3;
  else if (years <= 4) multiplier = 28.5 + (years - 3) * 9.0;
  else if (years <= 5) multiplier = 37.5 + (years - 4) * 9.0;
  else if (years <= 7) multiplier = 46.5 + (years - 5) * 8.5;
  else if (years <= 10) multiplier = 63.5 + (years - 7) * 8.0;
  else multiplier = 87.5 + (years - 10) * 7.0;

  return (notional / 10000000000) * multiplier * 100000 * direction;
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

          let tenor = '10Y';
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
            duration: Number(row['듀레이션']) || 0,
            krdMap
          };
        });

        // 2. 파생상품(IRS) 파싱
        let parsedIRS: any[] = [];
        const irsSheetName = wb.SheetNames.find(n => n.includes('IRS'));
        
        if (irsSheetName) {
          const irsSheet = wb.Sheets[irsSheetName];
          const irsData = XLSX.utils.sheet_to_json(irsSheet);

          parsedIRS = irsData.map((row: any, index: number) => {
            const rawBook = String(row['PORTFOLIO명'] || '').trim();
            const bookName = rawBook.includes('파생') ? 'RP Fund' : rawBook;

            const maturityDate = parseExcelDate(row['만기일']);
            const nextCouponDate = parseExcelDate(row['차기지급일자']);
            const pricingDate = new Date(baseDate);

            const yearsToMaturity = Math.max(0, (maturityDate.getTime() - pricingDate.getTime()) / (1000 * 60 * 60 * 24 * 365));
            const yearsToNextCoupon = Math.max(0, (nextCouponDate.getTime() - pricingDate.getTime()) / (1000 * 60 * 60 * 24 * 365)) || 0.25;

            const notional = Number(row['현재액면(원화)']) || 0;
            const sector = String(row['기초자산1']).includes('CD') ? 'IRS' : 'OIS';
            const direction = String(row['지급 수취']).trim() === '수취' ? -1 : 1;

            const exactTotalFixedPvbp = calculateExactFixedPvbp(yearsToMaturity, notional, direction);
            const floatingPvbp = notional * yearsToNextCoupon * 0.0001 * (-direction);

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

            // 단기 변동금리 리스크 맵핑
            distributeToKRD(yearsToNextCoupon, floatingPvbp);

            // 고정금리 리스크 분배 (원금 85% / 이표 15% 쿠폰 이펙트)
            const principalWeight = 0.85;
            const couponWeight = 0.15;

            distributeToKRD(yearsToMaturity, exactTotalFixedPvbp * principalWeight);

            const couponPvbp = exactTotalFixedPvbp * couponWeight;
            const validPillars = pillars.filter(p => p.y <= yearsToMaturity);
            if (validPillars.length > 0) {
              const perPillar = couponPvbp / validPillars.length;
              validPillars.forEach(p => {
                krdMap[p.name] = (krdMap[p.name] || 0) + perPillar;
              });
            }

            return {
              id: `irs-${index}`,
              name: String(row['종목명'] || ''),
              book: bookName,
              bondType: 'swap',
              sector: sector,
              notional: notional,
              evaluationAmount: Number(row['평가금액']) || 0,
              remainingDays: yearsToMaturity * 365,
              tenor: '10Y',
              pvbp: exactTotalFixedPvbp + floatingPvbp,
              entryYield: 0,
              duration: yearsToMaturity * 0.95 * direction,
              krdMap: krdMap
            };
          });
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
