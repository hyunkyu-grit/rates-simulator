"use client";

import { useState, useEffect } from "react";
import Navigation from "@/components/Navigation";
import ExcelUploader from "@/components/ExcelUploader";
import ShiftMatrixUploader from "@/components/ShiftMatrixUploader";
import ScenarioSimulator from "@/components/ScenarioSimulator";

interface Position {
  id: string;
  name: string;
  book: string;
  bondType: 'swap' | 'bond';
  sector: '국고채' | '통안채' | '특은채' | '시은채' | '공사채' | '여전채' | '회사채' | 'IRS' | 'OIS';
  maturityDate: string;
  couponRate: number;
  frequency: number;
  notional: number;
  entryYield: number;
  entryYieldPurchase: number;
  mtmYield?: number;
  expectedDeltaPnL?: number;
  expectedThetaPnL?: number;
  evaluationAmount: number;
  duration: number;
  pvbp: number;
  tenor: string;
  remainingDays: number;
  durationWeight: number;
  krdMap: { [tenor: string]: number };
  nextFixingDate?: Date;
  currentFloatRate?: number;
  totalDailyPnL?: number;
  direction: number;
}

interface PVBPSensitivity {
  sector: string;
  tenors: { [key: string]: number };
  total: number;
}

interface BookDailyPnL {
  bookName: string;
  dailyCarry: number;
  fundingCost: number;
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
  totalEvaluationAmount: number;
  weightedAvgYTM: number;
  portfolioDuration: number;
  sectorAllocation: { [key: string]: number };
  maturityAllocation: { [key: string]: number };
  top3: any[];
  bottom3: any[];
  totalDailyPnL: number;
  pvbp: number;
}

interface ScenarioPnL {
  name: string;
  shiftBp: number;
  pnl: number;
}

export default function PortfolioDashboard() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [pvbpSensitivity, setPvbpSensitivity] = useState<PVBPSensitivity[]>([]);
  const [bookDailyPnLs, setBookDailyPnLs] = useState<BookDailyPnL[]>([]);
  const [positionSummaries, setPositionSummaries] = useState<PositionSummary[]>([]);
  const [baseDate, setBaseDate] = useState<string>('2026-03-24');
  const [fundingRate, setFundingRate] = useState<number>(0.0420);
  const [shockCurves, setShockCurves] = useState<{ bondCurves: { [key: string]: { t: number, val: number }[] }, swapCurve: { t: number, val: number }[] }>({ bondCurves: {}, swapCurve: [] });
  const [activeTab, setActiveTab] = useState<'dashboard' | 'scenario'>('dashboard');

  useEffect(() => {
    const savedDate = localStorage.getItem('dashboardBaseDate');
    const savedRate = localStorage.getItem('dashboardFundingRate');
    if (savedDate) setBaseDate(savedDate);
    if (savedRate && !isNaN(parseFloat(savedRate))) setFundingRate(parseFloat(savedRate));
  }, []);

  useEffect(() => {
    localStorage.setItem('dashboardBaseDate', baseDate);
    localStorage.setItem('dashboardFundingRate', fundingRate.toString());
  }, [baseDate, fundingRate]);

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

  const calculateDynamicDelta = (position: Position) => {
    if (!shockCurves) return 0;
    if (position.bondType === 'swap') {
      let deltaPnL = 0;
      if (position.krdMap && shockCurves.swapCurve) {
        Object.entries(position.krdMap).forEach(([tenor, pvbp]) => {
          const t_years = parseTenorToYears(tenor);
          const shockBp = getInterpolatedCurveShift(t_years, shockCurves.swapCurve);
          deltaPnL += pvbp * (-shockBp);
        });
      }
      return deltaPnL;
    } else {
      let curveKey = '국채';
      if (position.sector.includes('국고') || position.sector.includes('통안')) curveKey = '국채';
      else if (position.sector.includes('시은')) curveKey = '은행채';
      else if (position.sector.includes('특은') || position.sector.includes('공사')) curveKey = shockCurves.bondCurves['특은채'] ? '특은채' : '은행채';
      else if (position.sector.includes('여전')) curveKey = '카드채';
      else if (position.sector.includes('회사')) curveKey = '회사채';
      
      const targetCurve = shockCurves.bondCurves?.[curveKey] || shockCurves.bondCurves?.['국채'] || [];
      const exactYears = position.remainingDays / 365;
      const shockBp = getInterpolatedCurveShift(exactYears, targetCurve);
      return position.pvbp * (-shockBp);
    }
  };

  useEffect(() => {
    if (positions.length > 0) {
      calculatePortfolioMetrics();
    } else {
      setPvbpSensitivity([]);
      setBookDailyPnLs([]);
      setPositionSummaries([]);
    }
  }, [positions, shockCurves, fundingRate]);

  const calculatePortfolioMetrics = () => {
    calculatePVBPSensitivity();
    calculateBookDailyPnL();
    calculatePositionSummaries();
  };

  const calculatePVBPSensitivity = () => {
    const sectors = ['국고채', '통안채', '특은채', '시은채', '공사채', '여전채', '회사채', 'IRS', 'OIS'];
    const tenors = ['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y'];
    
    const sensitivity: PVBPSensitivity[] = sectors.map(sector => {
      const sectorPositions = positions.filter(p => p.sector === sector);
      const tenorsData: { [key: string]: number } = {};
      let rowTotal = 0;
      tenors.forEach(tenor => {
        const tenorValue = sectorPositions.reduce((sum, p) => sum + (Number(p.krdMap?.[tenor]) || 0), 0);
        tenorsData[tenor] = tenorValue;
        rowTotal += tenorValue;
      });
      tenorsData['합계'] = rowTotal;
      return { sector, tenors: tenorsData, total: rowTotal };
    });

    const colTotals: { [key: string]: number } = {};
    let grandTotal = 0;
    [...tenors, '합계'].forEach(tenor => {
      const columnTotal = sensitivity.reduce((sum, sector) => sum + (Number(sector.tenors[tenor]) || 0), 0);
      colTotals[tenor] = columnTotal;
      grandTotal += columnTotal;
    });

    sensitivity.push({ sector: '합계', tenors: colTotals, total: grandTotal });
    setPvbpSensitivity(sensitivity);
  };

  const calculateScenarioPnL = (): ScenarioPnL[] => {
    const totalPvbp = positions.reduce((sum, position) => sum + position.pvbp, 0);
    const scenarios = [
      { name: '병행 10bp 상승', shiftBp: 10 },
      { name: '스티프닝', shiftBp: 5 },
      { name: '플래트닝', shiftBp: -5 },
      { name: '병행 10bp 하락', shiftBp: -10 }
    ];
    return scenarios.map(scenario => ({
      name: scenario.name,
      shiftBp: scenario.shiftBp,
      pnl: Math.round(-1 * totalPvbp * scenario.shiftBp)
    }));
  };

  const calculateBookDailyPnL = () => {
    const books = [...new Set(positions.map(p => p.book))];
    const dailyPnLs: BookDailyPnL[] = [];

    books.forEach(bookName => {
      const bookPositions = positions.filter(p => p.book === bookName);
      let dailyCarry = 0, fundingCost = 0, bondValuation = 0, swapValuation = 0, swapThetaPnL = 0;

      bookPositions.forEach(position => {
        const dynamicDeltaPnL = calculateDynamicDelta(position);
        if (position.bondType === 'swap') {
          swapValuation += dynamicDeltaPnL;
          swapThetaPnL += position.expectedThetaPnL || 0;
        } else {
          const evalAmount = Number(position.evaluationAmount) || 0;
          const yieldRate = Number(position.mtmYield) || 0;
          dailyCarry += (evalAmount * (yieldRate / 100)) / 365;
          fundingCost -= (evalAmount * fundingRate) / 365;
          bondValuation += dynamicDeltaPnL;
        }
      });

      const totalDailyPnL = dailyCarry + fundingCost + bondValuation + swapValuation + swapThetaPnL;
      dailyPnLs.push({
        bookName,
        dailyCarry: Math.round(dailyCarry),
        fundingCost: Math.round(fundingCost),
        bondValuation: Math.round(bondValuation),
        swapValuation: Math.round(swapValuation),
        swapThetaPnL: Math.round(swapThetaPnL),
        totalDailyPnL: Math.round(totalDailyPnL)
      });
    });

    const total = dailyPnLs.reduce((acc, book) => ({
      bookName: 'Total',
      dailyCarry: acc.dailyCarry + book.dailyCarry,
      fundingCost: acc.fundingCost + book.fundingCost,
      bondValuation: acc.bondValuation + book.bondValuation,
      swapValuation: acc.swapValuation + book.swapValuation,
      swapThetaPnL: acc.swapThetaPnL + book.swapThetaPnL,
      totalDailyPnL: acc.totalDailyPnL + book.totalDailyPnL
    }), { bookName: 'Total', dailyCarry: 0, fundingCost: 0, bondValuation: 0, swapValuation: 0, swapThetaPnL: 0, totalDailyPnL: 0 });

    setBookDailyPnLs([...dailyPnLs, total]);
  };

  const calculatePositionSummaries = () => {
    const books = [...new Set(positions.map(p => p.book))];
    const summaries: PositionSummary[] = [];

    books.forEach(bookName => {
      const bookPositions = positions.filter(p => p.book === bookName);
      const totalEvaluationAmount = bookPositions.reduce((sum, p) => sum + p.evaluationAmount, 0);
      const weightedAvgYTM = bookPositions.reduce((sum, p) => sum + (p.entryYield * p.evaluationAmount), 0) / totalEvaluationAmount || 0;
      const portfolioDuration = bookPositions.reduce((sum, p) => sum + (p.duration * p.evaluationAmount), 0) / totalEvaluationAmount || 0;
      const totalPVBP = bookPositions.reduce((sum, p) => sum + p.pvbp, 0);

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

      const positionsWithPnL = bookPositions.map(p => {
        const carryOrTheta = p.bondType === 'swap' ? (p.expectedThetaPnL || 0) : ((p.evaluationAmount || 0) * ((p.mtmYield || 0) / 100)) / 365;
        return { ...p, totalDailyPnL: carryOrTheta + calculateDynamicDelta(p) };
      });

      const sortedPositions = positionsWithPnL.sort((a, b) => b.totalDailyPnL - a.totalDailyPnL);
      const bookTotalDailyPnL = bookPositions.reduce((sum, p) => sum + (p.totalDailyPnL || 0), 0);

      summaries.push({
        bookName, instrumentName: '', assetType: 'BOND', direction: weightedAvgYTM < 0.042 ? 'Long' : 'Short',
        notional: totalEvaluationAmount, avgPrice: weightedAvgYTM * 100, ytm: portfolioDuration * 100,
        totalEvaluationAmount, weightedAvgYTM, portfolioDuration, sectorAllocation, maturityAllocation,
        top3: sortedPositions.slice(0, 3), bottom3: sortedPositions.slice(-3).reverse(),
        totalDailyPnL: bookTotalDailyPnL, pvbp: totalPVBP
      });
    });
    setPositionSummaries(summaries);
  };

  const formatNumber = (num: number) => Math.round(num).toLocaleString();
  const formatPVBP = (pvbp: number) => Math.round(pvbp / 1000000).toLocaleString();
  const getPnLColor = (pnl: number) => pnl > 0 ? 'text-blue-600' : pnl < 0 ? 'text-red-600' : 'text-gray-400';

  let mainContent;
  if (positions.length === 0) {
    mainContent = (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-150px)]">
        <div className="bg-gray-800 rounded-lg p-10 shadow-xl text-center max-w-4xl w-full border border-gray-700">
          <div className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center mx-auto mb-6">
            <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-blue-300 mb-2">포트폴리오 데이터를 업로드해주세요</h2>
          <p className="text-gray-400 mb-8">채권 및 스왑 로데이터 엑셀과 금리 변동표를 업로드하면 퀀트 엔진이 구동됩니다.</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-left">
            <ExcelUploader baseDate={baseDate} onDataLoaded={setPositions} />
          </div>
        </div>
      </div>
    );
  } else {
    mainContent = (
      <div className="w-full flex flex-col h-full">
        <div style={{ display: activeTab === 'dashboard' ? 'block' : 'none' }} className="w-full">
          <div className="mb-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ExcelUploader baseDate={baseDate} onDataLoaded={setPositions} />
            <ShiftMatrixUploader onShiftMatrixLoaded={setShockCurves} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 h-[calc(100vh-120px)]">
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
                      {['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '합계'].map(tenor => (
                        <th key={tenor} className={`text-center py-1 px-2 text-gray-400 whitespace-nowrap border-r font-bold text-xs ${tenor === '합계' ? 'bg-indigo-100 text-indigo-900 border-indigo-600' : 'border-gray-700'}`}>{tenor}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pvbpSensitivity.map(sector => {
                      const isTotalRow = sector.sector === '합계';
                      return (
                        <tr key={sector.sector} className="border-b border-gray-700 hover:bg-gray-700 even:bg-gray-750/30">
                          <td className={`py-1 px-2 font-medium sticky left-0 border-r whitespace-nowrap text-xs ${isTotalRow ? 'bg-indigo-100 text-indigo-900 font-extrabold' : 'bg-gray-800'}`}>{sector.sector}</td>
                          {['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '합계'].map(tenor => {
                            const value = Number(sector.tenors[tenor]) || 0;
                            const isTotalColumn = tenor === '합계';
                            const isGrandTotalCell = isTotalRow && isTotalColumn;
                            let bgClass = '', textClass = value > 0 ? 'text-green-400' : value < 0 ? 'text-red-400' : 'text-gray-500', fontClass = '';
                            if (isGrandTotalCell) { bgClass = 'bg-indigo-200'; textClass = 'text-indigo-900'; fontClass = 'font-extrabold text-sm'; }
                            else if (isTotalRow || isTotalColumn) { bgClass = 'bg-indigo-100'; textClass = 'text-indigo-900'; fontClass = 'font-extrabold text-sm'; }
                            return (
                              <td key={tenor} className={`py-1 px-2 text-right border-r whitespace-nowrap pr-3 ${bgClass} ${textClass} ${fontClass} ${isTotalColumn ? 'border-indigo-600' : 'border-gray-700'}`}>
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

            <div className="bg-gray-800 rounded-lg p-4 shadow-xl flex flex-col">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold text-blue-300">시나리오 P&L 예측</h2>
                <span className="text-xs text-gray-400">선형 근사 시뮬레이션</span>
              </div>
              <div className="grid grid-cols-2 gap-3 flex-1">
                {calculateScenarioPnL().map(scenario => (
                  <div key={scenario.name} className="bg-gray-700 rounded-lg p-3 flex flex-col justify-center">
                    <h3 className="text-sm font-medium mb-2 text-gray-300">{scenario.name}</h3>
                    <div className="space-y-1">
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-400">금리 시프트:</span>
                        <span className="text-xs text-gray-300">{scenario.shiftBp > 0 ? '+' : ''}{scenario.shiftBp}bp</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-gray-400">예상 P&L:</span>
                        <span className={`font-bold text-sm ${getPnLColor(scenario.pnl)}`}>{scenario.pnl > 0 ? '+' : ''}{formatNumber(scenario.pnl)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold text-blue-300">북별 당일 예상 손익</h2>
                <span className="text-xs text-gray-400">기관 트레이더 방식 Daily P&L</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left py-1 px-2 text-gray-400 whitespace-nowrap">북 이름</th>
                      <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 이자수익</th>
                      <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 조달비용</th>
                      <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 평가손익</th>
                      <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 스왑 평가손익</th>
                      <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 스왑 세타손익</th>
                      <th className="text-right py-1 px-2 text-gray-400 font-bold whitespace-nowrap">총 당일 예상손익</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bookDailyPnLs.map(book => (
                      <tr key={book.bookName} className="border-b border-gray-700 hover:bg-gray-700">
                        <td className="py-1 px-2 font-medium whitespace-nowrap">{book.bookName}</td>
                        <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.dailyCarry)}`}>{book.dailyCarry > 0 ? '+' : ''}{formatNumber(book.dailyCarry)}</td>
                        <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.fundingCost)}`}>{book.fundingCost > 0 ? '+' : ''}{formatNumber(book.fundingCost)}</td>
                        <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.bondValuation)}`}>{book.bondValuation > 0 ? '+' : ''}{formatNumber(book.bondValuation)}</td>
                        <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.swapValuation)}`}>{book.swapValuation > 0 ? '+' : ''}{formatNumber(book.swapValuation)}</td>
                        <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.swapThetaPnL || 0)}`}>{(book.swapThetaPnL || 0) > 0 ? '+' : ''}{formatNumber(book.swapThetaPnL || 0)}</td>
                        <td className={`py-1 px-2 text-right font-bold whitespace-nowrap ${getPnLColor(book.totalDailyPnL)}`}>{book.totalDailyPnL > 0 ? '+' : ''}{formatNumber(book.totalDailyPnL)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
              <div className="flex justify-between items-center mb-3">
                <h2 className="text-lg font-semibold text-blue-300">북별 컴팩트 요약</h2>
                <span className="text-xs text-gray-400">실전 딜링룸 스타일</span>
              </div>
              <div className="space-y-3">
                {positionSummaries.map(summary => (
                  <div key={summary.bookName} className="border border-gray-700 rounded-lg p-3">
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="text-center">
                        <div className="text-xs text-gray-400">총 운용규모</div>
                        <div className="text-sm font-bold text-blue-300">{(summary.totalEvaluationAmount / 100000000).toFixed(1)}억</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-gray-400">평균 YTM</div>
                        <div className="text-sm font-bold text-green-300">{summary.weightedAvgYTM.toFixed(2)}%</div>
                      </div>
                      <div className="text-center">
                        <div className="text-xs text-gray-400">듀레이션</div>
                        <div className="text-sm font-bold text-yellow-300">{summary.portfolioDuration.toFixed(2)}년</div>
                      </div>
                    </div>
                    
                    <div className="space-y-2 mb-3">
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-gray-400 w-16">섹터</span>
                          <div className="flex-1 flex h-4">
                            <div className="bg-blue-600" style={{ width: `${summary.sectorAllocation['국고채'] || 0}%` }} title={`국고채: ${(summary.sectorAllocation['국고채'] || 0).toFixed(1)}%`} />
                            <div className="bg-green-600" style={{ width: `${summary.sectorAllocation['통안채'] || 0}%` }} title={`통안채: ${(summary.sectorAllocation['통안채'] || 0).toFixed(1)}%`} />
                            <div className="bg-purple-600" style={{ width: `${summary.sectorAllocation['특은채'] || 0}%` }} title={`특은채: ${(summary.sectorAllocation['특은채'] || 0).toFixed(1)}%`} />
                            <div className="bg-orange-600" style={{ width: `${summary.sectorAllocation['시은채'] || 0}%` }} title={`시은채: ${(summary.sectorAllocation['시은채'] || 0).toFixed(1)}%`} />
                            <div className="bg-red-600" style={{ width: `${summary.sectorAllocation['공사채'] || 0}%` }} title={`공사채: ${(summary.sectorAllocation['공사채'] || 0).toFixed(1)}%`} />
                            <div className="bg-pink-600" style={{ width: `${summary.sectorAllocation['여전채'] || 0}%` }} title={`여전채: ${(summary.sectorAllocation['여전채'] || 0).toFixed(1)}%`} />
                            <div className="bg-gray-600" style={{ width: `${summary.sectorAllocation['회사채'] || 0}%` }} title={`회사채: ${(summary.sectorAllocation['회사채'] || 0).toFixed(1)}%`} />
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 ml-20">
                          <span className="text-xs text-gray-300">
                            국고채 {(summary.sectorAllocation['국고채'] || 0).toFixed(1)}% | 통안채 {(summary.sectorAllocation['통안채'] || 0).toFixed(1)}% | 특은채 {(summary.sectorAllocation['특은채'] || 0).toFixed(1)}% | 시은채 {(summary.sectorAllocation['시은채'] || 0).toFixed(1)}% | 공사채 {(summary.sectorAllocation['공사채'] || 0).toFixed(1)}% | 여전채 {(summary.sectorAllocation['여전채'] || 0).toFixed(1)}% | 회사채 {(summary.sectorAllocation['회사채'] || 0).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                      <div className="space-y-1">
                        <div className="flex items-center space-x-2">
                          <span className="text-xs text-gray-400 w-16">만기</span>
                          <div className="flex-1 flex h-4">
                            <div className="bg-purple-600" style={{ width: `${summary.maturityAllocation['단기(1년 미만)'] || 0}%` }} title={`단기: ${(summary.maturityAllocation['단기(1년 미만)'] || 0).toFixed(1)}%`} />
                            <div className="bg-orange-600" style={{ width: `${summary.maturityAllocation['중기(1~3년)'] || 0}%` }} title={`중기: ${(summary.maturityAllocation['중기(1~3년)'] || 0).toFixed(1)}%`} />
                            <div className="bg-red-600" style={{ width: `${summary.maturityAllocation['장기(3년 이상)'] || 0}%` }} title={`장기: ${(summary.maturityAllocation['장기(3년 이상)'] || 0).toFixed(1)}%`} />
                          </div>
                        </div>
                        <div className="flex items-center space-x-2 ml-20">
                          <span className="text-xs text-gray-300">
                            단기(&lt;1년) {(summary.maturityAllocation['단기(1년 미만)'] || 0).toFixed(1)}% | 중기(1~3년) {(summary.maturityAllocation['중기(1~3년)'] || 0).toFixed(1)}% | 장기(&gt;3년) {(summary.maturityAllocation['장기(3년 이상)'] || 0).toFixed(1)}%
                          </span>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <div className="text-xs text-blue-400 font-medium mb-1">Top 3 수익</div>
                        <div className="space-y-1">
                          {summary.top3.map(pos => (
                            <div key={pos.id} className="flex justify-between items-center">
                              <span className="text-xs text-gray-300 truncate">{pos.name.length > 15 ? pos.name.substring(0, 15) + '...' : pos.name}</span>
                              <span className="text-xs text-blue-400 font-medium">+{Math.round(pos.totalDailyPnL / 10000)}만</span>
                            </div>
                          ))}
                        </div>
                      </div>
                      <div>
                        <div className="text-xs text-red-400 font-medium mb-1">Bottom 3 손실</div>
                        <div className="space-y-1">
                          {summary.bottom3.map(pos => (
                            <div key={pos.id} className="flex justify-between items-center">
                              <span className="text-xs text-gray-300 truncate">{pos.name.length > 15 ? pos.name.substring(0, 15) + '...' : pos.name}</span>
                              <span className="text-xs text-red-400 font-medium">{Math.round(pos.totalDailyPnL / 10000)}만</span>
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
        </div>

        <div style={{ display: activeTab === 'scenario' ? 'block' : 'none' }} className="w-full h-[calc(100vh-120px)]">
          <ScenarioSimulator 
            positions={positions} 
            baseDate={baseDate} 
            fundingRate={fundingRate} 
          />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <Navigation />
      <div className="container mx-auto p-4">
        <div className="flex flex-col space-y-4 mb-6">
          <div className="flex justify-between items-center">
            <h1 className="text-2xl font-bold text-blue-300">포트폴리오 통합 관제 시스템</h1>
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <label className="text-sm text-gray-400">기준일자:</label>
                <input type="date" value={baseDate} onChange={(e) => setBaseDate(e.target.value)} className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-gray-300" />
              </div>
              <div className="flex items-center space-x-2">
                <label className="text-sm text-gray-400">조달 금리:</label>
                <input type="number" value={fundingRate} onChange={(e) => setFundingRate(parseFloat(e.target.value) || 0)} className="w-20 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm" step="0.0001" />
                <span className="text-sm text-gray-400">({(fundingRate * 100).toFixed(2)}%)</span>
              </div>
            </div>
          </div>
          <div className="flex space-x-1 bg-gray-800 p-1 rounded-lg">
            <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'dashboard' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>포트폴리오 대시보드</button>
            <button onClick={() => setActiveTab('scenario')} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'scenario' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>시나리오 P&L 예측</button>
          </div>
        </div>
        {mainContent}
      </div>
    </div>
  );
}