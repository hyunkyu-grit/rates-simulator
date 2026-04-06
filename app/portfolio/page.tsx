"use client";

import { useState, useEffect } from "react";
import Navigation from "@/components/Navigation";
import ExcelUploader from "@/components/ExcelUploader";
import ShiftMatrixUploader from "@/components/ShiftMatrixUploader";

interface Position {
  id: string;
  name: string; // 종목명
  book: string;
  bondType: 'coupon' | 'discount' | 'swap';
  sector: '국고채' | '통안채' | '특은채' | '시은채' | '공사채' | '여전채' | '회사채' | 'IRS' | 'OIS';
  maturityDate: string;
  couponRate: number;
  frequency: number;
  notional: number;
  entryYield: number;
  entryYieldPurchase: number; // 매수 시점 수익율
  mtmYield?: number; // MTM 민평수익율
  expectedDeltaPnL?: number; // 예상 델타 손익
  expectedThetaPnL?: number; // 예상 세타 손익
  evaluationAmount: number; // 평가금액
  duration: number; // 듀레이션
  // 실무 데이터 기반 추가 필드
  pvbp: number;
  tenor: string;
  remainingDays: number;
  durationWeight: number;
  krdMap: { [tenor: string]: number }; // KRD(Key Rate Duration) 분배 맵
}

interface PVBPSensitivity {
  sector: string;
  tenors: { [key: string]: number };
  total: number;
}

interface BookDailyPnL {
  bookName: string;
  dailyCarry: number;
  bondValuation: number;
  swapValuation: number;
  swapThetaPnL: number;
  totalDailyPnL: number;
}

interface PositionSummary {
  bookName: string;
  instrumentName: string;
  assetType: string;
  direction: 'Long' | 'Short';
  notional: number;
  avgPrice: number;
  ytm: number;
  // 컴팩트 요약 데이터
  totalEvaluationAmount: number;
  weightedAvgYTM: number;
  portfolioDuration: number;
  sectorAllocation: { [key: string]: number };
  maturityAllocation: { [key: string]: number };
  top3: any[];
  bottom3: any[];
}

interface ScenarioPnL {
  name: string;
  shiftBp: number;
  pnl: number;
}

interface ShiftMatrixData {
  years: number;
  국채: number; // 국고채, 통안채
  은행채: number; // 특은채, 시은채
  카드채: number; // 여전채
  산금채: number; // 공사채
  회사채: number; // 회사채
  기타: number;
  [key: string]: number; // 인덱스 시그니처 추가
}

export default function PortfolioDashboard() {
  // 포지션 데이터 상태
  const [positions, setPositions] = useState<Position[]>([]);

  // 계산 결과 상태들
  const [pvbpSensitivity, setPvbpSensitivity] = useState<PVBPSensitivity[]>([]);
  const [bookDailyPnLs, setBookDailyPnLs] = useState<BookDailyPnL[]>([]);
  const [positionSummaries, setPositionSummaries] = useState<PositionSummary[]>([]);

  // 기준일자 상태
  const [baseDate, setBaseDate] = useState<string>('2026-03-24');

  // 조달 금리 상태
  const [fundingRate, setFundingRate] = useState<number>(0.0420);

  // 금리변동표 상태
  const [shockCurves, setShockCurves] = useState<{ bondCurves: { [key: string]: { t: number, val: number }[] }, swapCurve: { t: number, val: number }[] }>({ bondCurves: {}, swapCurve: [] });

  // ExcelUploader에서 가져온 함수들
  const parseTenorToYears = (tenor: string) => {
    const t = String(tenor).toUpperCase().replace('년', 'Y').replace('개월', 'M').replace('일', 'D').trim();
    if (t.includes('Y')) return parseFloat(t) || 0;
    if (t.includes('M')) return (parseFloat(t) || 0) / 12;
    if (t.includes('D')) return (parseFloat(t) || 0) / 365;
    return parseFloat(t) || 0;
  };

  const getInterpolatedCurveShift = (targetYears: number, curveArray: { t: number, val: number }[]) => {
    if (curveArray.length === 0) return 0;
    if (targetYears <= curveArray[0].t) return curveArray[0].val;
    if (targetYears >= curveArray[curveArray.length - 1].t) return curveArray[curveArray.length - 1].val;
    
    for (let i = 0; i < curveArray.length - 1; i++) {
      if (targetYears >= curveArray[i].t && targetYears <= curveArray[i+1].t) {
        const range = curveArray[i+1].t - curveArray[i].t;
        const weight = (targetYears - curveArray[i].t) / range;
        return curveArray[i].val * (1 - weight) + curveArray[i+1].val * weight;
      }
    }
    return 0;
  };

  // [채권(Bullet) vs 스왑(KRD) 델타 계산 분리 함수]
  const calculateDynamicDelta = (position: Position) => {
    if (!shockCurves) return 0;

    // 1. 스왑(IRS/OIS) 로직: KRD 테너별 현금흐름 분해 후 합산
    if (position.bondType === 'swap') {
      let deltaPnL = 0;
      if (position.krdMap && shockCurves.swapCurve) {
        Object.entries(position.krdMap).forEach(([tenor, pvbp]) => {
          const t_years = parseTenorToYears(tenor);
          const shockBp = getInterpolatedCurveShift(t_years, shockCurves.swapCurve);
          
          // Float Leg 리스크가 집중된 초단기(1D, 3M) 구간이 변동표와 잘 결합되는지 확인
          if (tenor === '1D' || tenor === '3M') {
            console.log(`[초단기 커브 매핑 확인] 종목:${position.name} | 테너:${tenor}(${t_years.toFixed(4)}년) | PVBP:${Math.round(pvbp)} | 매핑된 충격치:${shockBp}bp`);
          }
          
          deltaPnL += pvbp * (-shockBp);
        });
      }
      return deltaPnL;
    } 
    // 2. 현물 채권 로직: 단일 PVBP * 정확한 잔존만기(Bullet) 보간 충격
    else {
      let curveKey = '국채';
      if (position.sector.includes('국고') || position.sector.includes('통안')) curveKey = '국채';
      else if (position.sector.includes('시은')) curveKey = '은행채';
      else if (position.sector.includes('특은') || position.sector.includes('공사')) curveKey = shockCurves.bondCurves['특은채'] ? '특은채' : '은행채';
      else if (position.sector.includes('여전')) curveKey = '카드채';
      else if (position.sector.includes('회사')) curveKey = '회사채';
      
      const targetCurve = shockCurves.bondCurves?.[curveKey] || shockCurves.bondCurves?.['국채'] || [];
      const exactYears = position.remainingDays / 365; // 정확한 잔존 연수
      const shockBp = getInterpolatedCurveShift(exactYears, targetCurve);
      
      // 디버깅용 로그 (채권 단일 충격 확인)
      if (position.name.includes('케이비국민카드') || position.name.includes('아이엠')) { // 예시 타겟
        console.log(`[채권 델타] ${position.name} | ${exactYears.toFixed(2)}년 | 섹터:${curveKey} | 적용충격:${shockBp.toFixed(3)}bp | PVBP:${position.pvbp} -> PnL:${position.pvbp * (-shockBp)}`);
      }

      return position.pvbp * (-shockBp);
    }
  };

  
  // positions와 shiftMatrix 상태가 변경될 때마다 계산 실행 (파이프라인 2: 반응성 보장)
  useEffect(() => {
    if (positions.length > 0) {
      calculatePortfolioMetrics();
    } else {
      // 데이터가 없을 때 계산 결과 초기화
      setPvbpSensitivity([]);
      setBookDailyPnLs([]);
      setPositionSummaries([]);
    }
  }, [positions, shockCurves, fundingRate]); // shockCurves 추가

  // 포트폴리오 메트릭 계산
  const calculatePortfolioMetrics = () => {
    console.log('🔄 포트폴리오 메트릭 계산 시작...', positions.length, '개 포지션');
    console.log('📈 현재 채권 다중 커브 상태:', Object.keys(shockCurves.bondCurves).length, '개 섹터');
    console.log('📈 현재 스왑 변동곡선 상태:', shockCurves.swapCurve.length, '개 구간');
    
    // 방어 로직: 금리변동표가 없으면 당일 손익 0으로 처리
    if (Object.keys(shockCurves.bondCurves).length === 0 && shockCurves.swapCurve.length === 0) {
      console.log('⚠️ 금리변동표가 없어 당일 평가손익은 0으로 계산됩니다.');
    }
    
    // PVBP 민감도 계산
    calculatePVBPSensitivity();
    
    // 북별 당일 손익 계산
    calculateBookDailyPnL();
    
    // 포지션 요약 계산
    calculatePositionSummaries();
    
    console.log('✅ 포트폴리오 메트릭 계산 완료');
  };

  // PVBP 민감도 계산 (동적 집계 로직으로 수정)
  const calculatePVBPSensitivity = () => {
    const sectors = ['국고채', '통안채', '특은채', '시은채', '공사채', '여전채', '회사채', 'IRS', 'OIS'];
    const tenors = ['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y'];
    
    // 각 섹터별 데이터 계산 (rowTotal 포함)
    const sensitivity: PVBPSensitivity[] = sectors.map(sector => {
      const sectorPositions = positions.filter(p => p.sector === sector);
      const tenorsData: { [key: string]: number } = {};
      let rowTotal = 0;
      
      tenors.forEach(tenor => {
        const tenorValue = sectorPositions
          .reduce((sum, p) => sum + (Number(p.krdMap?.[tenor]) || 0), 0);
        tenorsData[tenor] = tenorValue;
        rowTotal += tenorValue;
      });
      
      // 합계 열에 rowTotal 추가
      tenorsData['합계'] = rowTotal;
      
      return {
        sector,
        tenors: tenorsData,
        total: rowTotal
      };
    });

    // 테너별 합계 (colTotals) 동적 계산
    const colTotals: { [key: string]: number } = {};
    let grandTotal = 0;
    
    // 모든 테너에 대해 합계 계산
    [...tenors, '합계'].forEach(tenor => {
      const columnTotal = sensitivity.reduce((sum, sector) => {
        return sum + (Number(sector.tenors[tenor]) || 0);
      }, 0);
      colTotals[tenor] = columnTotal;
      grandTotal += columnTotal;
    });

    // 합계 행 추가
    sensitivity.push({
      sector: '합계',
      tenors: colTotals,
      total: grandTotal
    });

    setPvbpSensitivity(sensitivity);
    console.log('📊 동적 집계 PVBP 민감도 계산 완료:', sensitivity);
    console.log('🔢 테너별 합계:', colTotals);
    console.log('💰 그랜드 토탈:', grandTotal);
  };

  // 시나리오 P&L 계산 (선형 근사)
  const calculateScenarioPnL = (): ScenarioPnL[] => {
    // 전체 포트폴리오의 합산 actualPvbp
    const totalPvbp = positions.reduce((sum, position) => sum + position.pvbp, 0);
    
    const scenarios = [
      { name: '병행 10bp 상승', shiftBp: 10 },
      { name: '스티프닝', shiftBp: 5 },
      { name: '플래트닝', shiftBp: -5 },
      { name: '병행 10bp 하락', shiftBp: -10 }
    ];

    return scenarios.map(scenario => {
      // 시나리오 손익 = -1 * 합산_actualPvbp * shift_bp
      const pnl = -1 * totalPvbp * scenario.shiftBp;
      return {
        name: scenario.name,
        shiftBp: scenario.shiftBp,
        pnl: Math.round(pnl)
      };
    });
  };

  // 북별 당일 손익 계산 (기관 트레이더 방식)
  const calculateBookDailyPnL = () => {
    const books = [...new Set(positions.map(p => p.book))]; // 동적 북 목록
    const dailyPnLs: BookDailyPnL[] = [];

    books.forEach(bookName => {
      const bookPositions = positions.filter(p => p.book === bookName);
      let dailyCarry = 0;
      let bondValuation = 0;
      let swapValuation = 0;
      let swapThetaPnL = 0;

      bookPositions.forEach(position => {
  const dynamicDeltaPnL = calculateDynamicDelta(position);

  if (position.bondType === 'swap') {
    swapValuation += dynamicDeltaPnL;
    swapThetaPnL += position.expectedThetaPnL || 0;
  } else {
    const evalAmount = Number(position.evaluationAmount) || 0;
    const yieldRate = Number(position.mtmYield) || 0;
    dailyCarry += (evalAmount * (yieldRate / 100)) / 365;
    bondValuation += dynamicDeltaPnL;
  }
  console.log(`[P&L 검증] 종목: ${position.name} | 동적델타: ${dynamicDeltaPnL} | 세타손익: ${position.expectedThetaPnL}`);
});

      const totalDailyPnL = dailyCarry + bondValuation + swapValuation + (swapThetaPnL || 0);

      // 디버깅 로그: 채권 MTM 수익률 배열 확인
      console.log('채권 MTM 수익률 배열:', bookPositions.filter(p => p.bondType !== 'swap').map(p => ({ name: p.name, mtmYield: p.mtmYield })));
      
      // 디버깅 로그: 스왑 세타손익 확인
      const swapPositions = bookPositions.filter(p => p.bondType === 'swap');
      console.log(`[${bookName}] 스왑 세타손익 디버깅:`, {
        swapCount: swapPositions.length,
        swapThetaPnL: swapThetaPnL,
        details: swapPositions.map(p => ({ name: p.name, expectedThetaPnL: p.expectedThetaPnL }))
      });

      dailyPnLs.push({
        bookName,
        dailyCarry: Math.round(dailyCarry),
        bondValuation: Math.round(bondValuation),
        swapValuation: Math.round(swapValuation),
        swapThetaPnL: Math.round(swapThetaPnL), // 계산된 세타손익 반영
        totalDailyPnL: Math.round(totalDailyPnL)
      });
    });

    // Total 행 추가
    const total = dailyPnLs.reduce((acc, book) => ({
      bookName: 'Total',
      dailyCarry: acc.dailyCarry + book.dailyCarry,
      bondValuation: acc.bondValuation + book.bondValuation,
      swapValuation: acc.swapValuation + book.swapValuation,
      swapThetaPnL: acc.swapThetaPnL + book.swapThetaPnL,
      totalDailyPnL: acc.totalDailyPnL + book.totalDailyPnL
    }), { bookName: 'Total', dailyCarry: 0, bondValuation: 0, swapValuation: 0, swapThetaPnL: 0, totalDailyPnL: 0 });

    setBookDailyPnLs([...dailyPnLs, total]);
    console.log('💰 북별 당일 손익 계산 완료:', [...dailyPnLs, total]);
  };

  // 북별 요약 데이터 집계 로직
  const calculatePositionSummaries = () => {
    const books = [...new Set(positions.map(p => p.book))];
    const summaries: PositionSummary[] = [];

    books.forEach(bookName => {
      const bookPositions = positions.filter(p => p.book === bookName);
      
      // Key Metrics 계산
      const totalEvaluationAmount = bookPositions.reduce((sum, p) => sum + p.evaluationAmount, 0);
      const weightedAvgYTM = bookPositions.reduce((sum, p) => sum + (p.entryYield * p.evaluationAmount), 0) / totalEvaluationAmount || 0;
      const portfolioDuration = bookPositions.reduce((sum, p) => sum + (p.duration * p.evaluationAmount), 0) / totalEvaluationAmount || 0;

      // Allocation (비중 %) 계산 (7가지 섹터로 확장)
      const sectorAllocation = {
        '국고채': bookPositions.filter(p => p.sector === '국고채').reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '통안채': bookPositions.filter(p => p.sector === '통안채').reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '특은채': bookPositions.filter(p => p.sector === '특은채').reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '시은채': bookPositions.filter(p => p.sector === '시은채').reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '공사채': bookPositions.filter(p => p.sector === '공사채').reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '여전채': bookPositions.filter(p => p.sector === '여전채').reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '회사채': bookPositions.filter(p => p.sector === '회사채').reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100
      };

      const maturityAllocation = {
        '단기(1년 미만)': bookPositions.filter(p => p.remainingDays < 365).reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '중기(1~3년)': bookPositions.filter(p => p.remainingDays >= 365 && p.remainingDays <= 1095).reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100,
        '장기(3년 이상)': bookPositions.filter(p => p.remainingDays > 1095).reduce((sum, p) => sum + p.evaluationAmount, 0) / totalEvaluationAmount * 100
      };

      // Top & Bottom 3 계산 (당일 손익 기준)
      const positionsWithPnL = bookPositions.map(p => {
        const carryOrTheta = p.bondType === 'swap' 
          ? (p.expectedThetaPnL || 0) 
          : ((p.evaluationAmount || 0) * ((p.mtmYield || 0) / 100)) / 365;
        const dynamicDeltaPnL = calculateDynamicDelta(p);
        
        return {
          ...p,
          totalDailyPnL: carryOrTheta + dynamicDeltaPnL
        };
      });

      const sortedPositions = positionsWithPnL.sort((a, b) => b.totalDailyPnL - a.totalDailyPnL);
      const top3 = sortedPositions.slice(0, 3);
      const bottom3 = sortedPositions.slice(-3).reverse();

      summaries.push({
        bookName,
        instrumentName: '', // 기존 필드 호환성 유지
        assetType: 'BOND',
        direction: weightedAvgYTM < 0.042 ? 'Long' : 'Short',
        notional: totalEvaluationAmount,
        avgPrice: weightedAvgYTM * 100,
        ytm: portfolioDuration * 100,
        // 새로운 컴팩트 요약 데이터
        totalEvaluationAmount,
        weightedAvgYTM,
        portfolioDuration,
        sectorAllocation,
        maturityAllocation,
        top3,
        bottom3
      });
    });

    setPositionSummaries(summaries);
    console.log('📋 북별 컴팩트 요약 계산 완료:', summaries);
  };

  // 숫자 포맷팅 함수
  const formatNumber = (num: number): string => {
    return Math.round(num).toLocaleString();
  };

  // PVBP 백만 원 단위 포맷팅 함수
  const formatPVBP = (pvbp: number): string => {
    return Math.round(pvbp / 1000000).toLocaleString();
  };

  // P&L 색상 함수
  const getPnLColor = (pnl: number): string => {
    return pnl > 0 ? 'text-blue-600' : pnl < 0 ? 'text-red-600' : 'text-gray-400';
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <Navigation />
      
      <div className="container mx-auto p-4">
        <div className="flex justify-between items-center mb-6">
          <h1 className="text-2xl font-bold text-blue-300">포트폴리오 통합 관제 시스템</h1>
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <label className="text-sm text-gray-400">기준일자:</label>
              <input 
                type="date" 
                value={baseDate} 
                onChange={(e) => setBaseDate(e.target.value)}
                className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-gray-300"
              />
            </div>
            <div className="flex items-center space-x-2">
              <label className="text-sm text-gray-400">조달 금리:</label>
              <input
                type="number"
                value={fundingRate}
                onChange={(e) => setFundingRate(parseFloat(e.target.value) || 0)}
                className="w-20 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                step="0.0001"
              />
              <span className="text-sm text-gray-400">({(fundingRate * 100).toFixed(2)}%)</span>
            </div>
          </div>
        </div>

        {/* 업로드 컴포넌트들 */}
        <div className="mb-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ExcelUploader baseDate={baseDate} onDataLoaded={(loadedPositions) => {
            console.log('📊 ExcelUploader 데이터 수신:', loadedPositions.length, '개 포지션');
            setPositions(loadedPositions); // State 업데이트 트리거
          }} />
          
          <ShiftMatrixUploader onShiftMatrixLoaded={(loadedShockCurves) => {
            console.log('📈 채권 다중 커브 데이터 수신:', Object.keys(loadedShockCurves.bondCurves).length, '개 섹터');
            console.log('📈 스왑 변동곡선 데이터 수신:', loadedShockCurves.swapCurve.length, '개 구간');
            setShockCurves(loadedShockCurves); // 변동곡선 상태 업데이트
          }} />
        </div>

        {/* 조건부 렌더링 (파이프라인 3: UI 전환) */}
        {positions.length > 0 ? (
          /* 4분할 대시보드 화면 */
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-[calc(100vh-120px)]">
            
            {/* Top-Left: PVBP 민감도 표 (HTS 초밀도 뷰) */}
            <div className="bg-gray-800 rounded-lg p-3 shadow-xl overflow-hidden h-full flex flex-col">
              <div className="flex justify-between items-center mb-2">
                <h2 className="text-sm font-semibold text-blue-300">PVBP 민감도 (단위: 백만)</h2>
                <span className="text-xs text-gray-400">1bp 변동</span>
              </div>
              <div className="overflow-x-auto flex-grow">
                <table className="w-full text-xs table-fixed border-collapse">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left py-1 px-2 text-gray-400 sticky left-0 bg-gray-800 border-r border-gray-700 w-max whitespace-nowrap text-xs">섹터</th>
                      {['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '합계'].map((tenor, index) => (
                        <th key={tenor} className={`text-center py-1 px-2 text-gray-400 whitespace-nowrap border-r font-bold text-xs ${tenor === '합계' ? 'bg-indigo-100 text-indigo-900 border-indigo-600' : 'border-gray-700'}`}>
                          {tenor}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pvbpSensitivity.map((sector) => {
                      // 수정: 인덱스가 아닌 섹터 이름으로 합계 행을 정확히 판별
                      const isTotalRow = sector.sector === '합계'; 
                      
                      return (
                        <tr key={sector.sector} className="border-b border-gray-700 hover:bg-gray-700 even:bg-gray-750/30">
                          {/* 좌측 헤더 셀 (섹터명) */}
                          <td className={`py-1 px-2 font-medium sticky left-0 border-r whitespace-nowrap text-xs ${
                            isTotalRow ? 'bg-indigo-100 text-indigo-900 font-extrabold' : 'bg-gray-800'
                          }`}>
                            {sector.sector}
                          </td>
                          
                          {/* 우측 데이터 셀 (테너별 값) */}
                          {['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '합계'].map((tenor) => {
                            const value = Number(sector.tenors[tenor]) || 0;
                            
                            // 인덱스 번호가 아닌 '합계'라는 키워드 자체로 색상 렌더링 조건 변경!
                            const isTotalColumn = tenor === '합계';
                            const isGrandTotalCell = isTotalRow && isTotalColumn;  
                            let bgClass = '';
                            let textClass = value > 0 ? 'text-green-400' : value < 0 ? 'text-red-400' : 'text-gray-500';
                            let fontClass = '';
                            
                            if (isGrandTotalCell) {
                              bgClass = 'bg-indigo-200'; textClass = 'text-indigo-900'; fontClass = 'font-extrabold text-sm';
                            } else if (isTotalRow || isTotalColumn) {
                              bgClass = 'bg-indigo-100'; textClass = 'text-indigo-900'; fontClass = 'font-extrabold text-sm';
                            }

                            return (
                              <td key={tenor} className={`py-1 px-2 text-right border-r whitespace-nowrap pr-3 ${bgClass} ${textClass} ${fontClass} ${
                                isTotalColumn ? 'border-indigo-600' : 'border-gray-700'
                              }`}>
                                {value !== 0 ? formatPVBP(value) : '-'}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Top-Right: 시나리오 P&L 예측 */}
            <div className="bg-gray-800 rounded-lg p-4 shadow-xl flex flex-col">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold text-blue-300">시나리오 P&L 예측</h2>
                <span className="text-xs text-gray-400">선형 근사 시뮬레이션</span>
              </div>
              <div className="grid grid-cols-2 gap-3 flex-1">
                {calculateScenarioPnL().map((scenario) => (
                  <div key={scenario.name} className="bg-gray-700 rounded-lg p-3 flex flex-col justify-center">
                    <h3 className="text-sm font-medium mb-2 text-gray-300">{scenario.name}</h3>
                    <div className="space-y-1">
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-400">금리 시프트:</span>
                        <span className="text-xs text-gray-300">
                          {scenario.shiftBp > 0 ? '+' : ''}{scenario.shiftBp}bp
                        </span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-400">예상 P&L:</span>
                        <span className={`font-bold text-sm ${getPnLColor(scenario.pnl)}`}>
                          {scenario.pnl > 0 ? '+' : ''}{formatNumber(scenario.pnl)}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom-Left: 북별 당일 예상 손익 */}
            <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold text-blue-300">북별 당일 예상 손익</h2>
                <span className="text-xs text-gray-400">기관 트레이더 방식 Daily P&L</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left py-1 px-2 text-gray-400">북 이름</th>
                      <th className="text-right py-1 px-2 text-gray-400">당일 이자수익</th>
                      <th className="text-right py-1 px-2 text-gray-400">당일 평가손익</th>
                      <th className="text-right py-1 px-2 text-gray-400">당일 스왑 평가손익</th>
                      <th className="text-right py-1 px-2 text-gray-400">당일 스왑 세타손익</th>
                      <th className="text-right py-1 px-2 text-gray-400 font-bold">총 당일 예상손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookDailyPnLs.map((book) => (
                      <tr key={book.bookName} className="border-b border-gray-700 hover:bg-gray-700">
                        <td className="py-1 px-2 font-medium">{book.bookName}</td>
                        <td className={`py-1 px-2 text-right ${getPnLColor(book.dailyCarry)}`}>
                          {book.dailyCarry > 0 ? '+' : ''}{formatNumber(book.dailyCarry)}
                        </td>
                        <td className={`py-1 px-2 text-right ${getPnLColor(book.bondValuation)}`}>
                          {book.bondValuation > 0 ? '+' : ''}{formatNumber(book.bondValuation)}
                        </td>
                        <td className={`py-1 px-2 text-right ${getPnLColor(book.swapValuation)}`}>
                          {book.swapValuation > 0 ? '+' : ''}{formatNumber(book.swapValuation)}
                        </td>
                        <td className={`py-1 px-2 text-right ${getPnLColor(book.swapThetaPnL || 0)}`}>
                          {(book.swapThetaPnL || 0) > 0 ? '+' : ''}{formatNumber(book.swapThetaPnL || 0)}
                        </td>
                        <td className={`py-1 px-2 text-right font-bold ${getPnLColor(book.totalDailyPnL)}`}>
                          {book.totalDailyPnL > 0 ? '+' : ''}{formatNumber(book.totalDailyPnL)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Bottom-Right: 북별 컴팩트 요약 */}
            <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold text-blue-300">북별 컴팩트 요약</h2>
                <span className="text-xs text-gray-400">실전 딜링룸 스타일</span>
              </div>
              <div className="space-y-3">
                {positionSummaries.map((summary) => (
                  <div key={summary.bookName} className="border border-gray-700 rounded-lg p-3">
                    {/* 상단: Key Metrics */}
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="text-center">
                        <div className="text-xs text-gray-400">총 운용규모</div>
                        <div className="text-sm font-bold text-blue-300">
                          {(summary.totalEvaluationAmount / 100000000).toFixed(1)}억
                        </div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-gray-400">평균 YTM</div>
                        <div className="text-sm font-bold text-green-300">
                          {summary.weightedAvgYTM.toFixed(2)}%
                        </div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-gray-400">포트폴리오 듀레이션</div>
                        <div className="text-sm font-bold text-yellow-300">
                          {summary.portfolioDuration.toFixed(2)}년
                        </div>
                      </div>
                    </div>

                    {/* 중단: Allocation Bar */}
                    <div className="space-y-2 mb-3">
                      {/* 섹터 비중 (7가지 섹터로 확장) */}
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-gray-400 w-16">섹터</span>
                          <div className="flex-1 flex h-4">
                            <div 
                              className="bg-blue-600" 
                              style={{ width: `${summary.sectorAllocation['국고채']}%` }}
                              title={`국고채: ${summary.sectorAllocation['국고채'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-green-600" 
                              style={{ width: `${summary.sectorAllocation['통안채']}%` }}
                              title={`통안채: ${summary.sectorAllocation['통안채'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-purple-600" 
                              style={{ width: `${summary.sectorAllocation['특은채']}%` }}
                              title={`특은채: ${summary.sectorAllocation['특은채'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-orange-600" 
                              style={{ width: `${summary.sectorAllocation['시은채']}%` }}
                              title={`시은채: ${summary.sectorAllocation['시은채'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-red-600" 
                              style={{ width: `${summary.sectorAllocation['공사채']}%` }}
                              title={`공사채: ${summary.sectorAllocation['공사채'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-pink-600" 
                              style={{ width: `${summary.sectorAllocation['여전채']}%` }}
                              title={`여전채: ${summary.sectorAllocation['여전채'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-gray-600" 
                              style={{ width: `${summary.sectorAllocation['회사채']}%` }}
                              title={`회사채: ${summary.sectorAllocation['회사채'].toFixed(1)}%`}
                            />
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 ml-20">
                          <span className="text-xs text-gray-300">
                            국고채 {summary.sectorAllocation['국고채'].toFixed(1)}% | 
                            통안채 {summary.sectorAllocation['통안채'].toFixed(1)}% | 
                            특은채 {summary.sectorAllocation['특은채'].toFixed(1)}% | 
                            시은채 {summary.sectorAllocation['시은채'].toFixed(1)}% | 
                            공사채 {summary.sectorAllocation['공사채'].toFixed(1)}% | 
                            여전채 {summary.sectorAllocation['여전채'].toFixed(1)}% | 
                            회사채 {summary.sectorAllocation['회사채'].toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      
                      {/* 만기 비중 */}
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-gray-400 w-16">만기</span>
                          <div className="flex-1 flex h-4">
                            <div 
                              className="bg-purple-600" 
                              style={{ width: `${summary.maturityAllocation['단기(1년 미만)']}%` }}
                              title={`단기: ${summary.maturityAllocation['단기(1년 미만)'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-orange-600" 
                              style={{ width: `${summary.maturityAllocation['중기(1~3년)']}%` }}
                              title={`중기: ${summary.maturityAllocation['중기(1~3년)'].toFixed(1)}%`}
                            />
                            <div 
                              className="bg-red-600" 
                              style={{ width: `${summary.maturityAllocation['장기(3년 이상)']}%` }}
                              title={`장기: ${summary.maturityAllocation['장기(3년 이상)'].toFixed(1)}%`}
                            />
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 ml-20">
                          <span className="text-xs text-gray-300">
                            단기(&lt;1년) {summary.maturityAllocation['단기(1년 미만)'].toFixed(1)}% | 
                            중기(1~3년) {summary.maturityAllocation['중기(1~3년)'].toFixed(1)}% | 
                            장기(&gt;3년) {summary.maturityAllocation['장기(3년 이상)'].toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* 하단: Top & Bottom 3 */}
                    <div className="grid grid-cols-2 gap-3">
                      {/* Top 3 수익 종목 */}
                      <div>
                        <div className="text-xs text-blue-400 font-medium mb-1">Top 3 수익 (당일 손익 기여)</div>
                        <div className="space-y-1">
                          {summary.top3.map((pos, idx) => (
                            <div key={pos.id} className="flex justify-between items-center">
                              <span className="text-xs text-gray-300 truncate" title={pos.name}>
                                {pos.name.length > 15 ? pos.name.substring(0, 15) + '...' : pos.name}
                              </span>
                              <span className="text-xs text-blue-400 font-medium">
                                +{Math.round(pos.totalDailyPnL / 10000)}만 원
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      
                      {/* Bottom 3 리스크 종목 */}
                      <div>
                        <div className="text-xs text-red-400 font-medium mb-1">Bottom 3 손실 (당일 손익 기여)</div>
                        <div className="space-y-1">
                          {summary.bottom3.map((pos, idx) => (
                            <div key={pos.id} className="flex justify-between items-center">
                              <span className="text-xs text-gray-300 truncate" title={pos.name}>
                                {pos.name.length > 15 ? pos.name.substring(0, 15) + '...' : pos.name}
                              </span>
                              <span className="text-xs text-red-400 font-medium">
                                {Math.round(pos.totalDailyPnL / 10000)}만 원
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        ) : (
          /* 업로드 대기 화면 */
          <div className="bg-gray-800 rounded-lg p-8 shadow-xl text-center">
            <div className="max-w-md mx-auto">
              <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-blue-300 mb-2">엑셀 파일을 업로드해주세요</h2>
              <p className="text-gray-400 mb-4">채권 포트폴리오 데이터를 분석하여 4분할 대시보드에 표시합니다.</p>
              <div className="text-left bg-gray-700 rounded-lg p-4 text-sm text-gray-300">
                <p className="font-medium mb-2">필수 컬럼:</p>
                <ul className="space-y-1 text-xs">
                  <li>• 종목명</li>
                  <li>• 펀드명</li>
                  <li>• 상품중분류명</li>
                  <li>• 발행일자</li>
                  <li>• 만기일자</li>
                  <li>• 표면이율</li>
                  <li>• 민평수익율</li>
                  <li>• 결제장부수량(만)</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
