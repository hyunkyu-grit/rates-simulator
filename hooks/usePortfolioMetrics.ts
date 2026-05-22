import { useState, useEffect } from 'react';
import { Position, PVBPSensitivity, BookDailyPnL, PositionSummary, ScenarioPnL, ShockCurves } from '@/types/portfolio';

export const usePortfolioMetrics = (
  positions: Position[],
  shockCurves: ShockCurves | null,
  fundingRate: number
) => {
  const [pvbpSensitivity, setPvbpSensitivity] = useState<PVBPSensitivity[]>([]);
  const [bookDailyPnLs, setBookDailyPnLs] = useState<BookDailyPnL[]>([]);
  const [positionSummaries, setPositionSummaries] = useState<PositionSummary[]>([]);

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

  const calculatePortfolioMetrics = () => {
    calculatePVBPSensitivity();
    calculateBookDailyPnL();
    calculatePositionSummaries();
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

  return {
    pvbpSensitivity,
    bookDailyPnLs,
    positionSummaries,
    calculateScenarioPnL
  };
};
