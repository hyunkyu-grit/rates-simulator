import { useState, useEffect, useCallback } from 'react';
import { Position, PVBPSensitivity, BookDailyPnL, PositionSummary, ScenarioPnL, ShockCurves } from '@/types/portfolio';

export const usePortfolioMetrics = (
  positions: Position[],
  shockCurves: ShockCurves | null,
  fundingRate: number,
  baseDate: string,
  irsParRates: { t: number; rate: number }[] = []
) => {
  const [pvbpSensitivity, setPvbpSensitivity] = useState<PVBPSensitivity[]>([]);
  const [bookDailyPnLs, setBookDailyPnLs] = useState<BookDailyPnL[]>([]);
  const [positionSummaries, setPositionSummaries] = useState<PositionSummary[]>([]);

  // 북별 요약 — positions에서 직접 계산 (백엔드 불필요)
  useEffect(() => {
    if (!positions || positions.length === 0) { setPositionSummaries([]); return; }

    const books = [...new Set(positions.map(p => p.book))];
    const summaries: PositionSummary[] = books.map(book => {
      const all   = positions.filter(p => p.book === book);
      const bonds = all.filter(p => p.bondType !== 'swap');

      const totalNotional  = bonds.reduce((s, p) => s + (p.notional || 0), 0);
      const totalEvalAmt   = bonds.reduce((s, p) => s + (p.evaluationAmount || 0), 0);
      const weightedYield  = totalEvalAmt > 0
        ? bonds.reduce((s, p) => s + (p.mtmYield || 0) * (p.evaluationAmount || 0), 0) / totalEvalAmt
        : 0;

      // 헷지 후 듀레이션: 전 종목(채권+IRS) 순 PVBP × 10000 / 채권평가
      const netPvbp = all.reduce((s, p) => s + (p.pvbp || 0) * (p.direction || 1), 0);
      const hedgedDuration = totalEvalAmt > 0 ? (netPvbp * 10000) / totalEvalAmt : 0;

      // 채권만 단순 듀레이션 (IRS 제외)
      const bondPvbp = bonds.reduce((s, p) => s + (p.pvbp || 0), 0);
      const portfolioDuration = totalEvalAmt > 0 ? (bondPvbp * 10000) / totalEvalAmt : 0;

      // 섹터 배분
      const sectorTotals: { [k: string]: number } = {};
      bonds.forEach(p => { sectorTotals[p.sector] = (sectorTotals[p.sector] || 0) + (p.evaluationAmount || 0); });
      const sectorAllocation: { [k: string]: number } = {};
      Object.keys(sectorTotals).forEach(k => {
        sectorAllocation[k] = totalEvalAmt > 0 ? (sectorTotals[k] / totalEvalAmt) * 100 : 0;
      });

      // 만기 배분
      const maturBuckets = { '단기(1년 미만)': 0, '중기(1~3년)': 0, '장기(3년 이상)': 0 };
      bonds.forEach(p => {
        const yr = (p.remainingDays || 0) / 365;
        if (yr < 1) maturBuckets['단기(1년 미만)'] += p.evaluationAmount || 0;
        else if (yr < 3) maturBuckets['중기(1~3년)'] += p.evaluationAmount || 0;
        else maturBuckets['장기(3년 이상)'] += p.evaluationAmount || 0;
      });
      const maturityAllocation: { [k: string]: number } = {};
      (Object.keys(maturBuckets) as (keyof typeof maturBuckets)[]).forEach(k => {
        maturityAllocation[k] = totalEvalAmt > 0 ? (maturBuckets[k] / totalEvalAmt) * 100 : 0;
      });

      // Top3 / Bottom3 by daily PnL
      const sorted = [...bonds].sort((a, b) => (b.totalDailyPnL || 0) - (a.totalDailyPnL || 0));
      const top3    = sorted.slice(0, 3);
      const bottom3 = sorted.slice(-3).reverse();
      const totalDailyPnL = all.reduce((s, p) => s + (p.totalDailyPnL || 0), 0);

      return {
        bookName: book,
        instrumentName: '', assetType: 'mixed', direction: 'Long' as const,
        notional: totalNotional, avgPrice: 0, ytm: weightedYield,
        totalNotional,
        totalEvaluationAmount: totalEvalAmt,
        weightedAvgYTM: weightedYield,
        portfolioDuration,
        hedgedDuration,
        sectorAllocation,
        maturityAllocation,
        top3, bottom3,
        totalDailyPnL,
        pvbp: bondPvbp,
      };
    });
    setPositionSummaries(summaries);
  }, [positions]);

  const fetchBaseMetrics = useCallback(async () => {
    if (!positions || positions.length === 0) {
      setPvbpSensitivity([]);
      setBookDailyPnLs([]);
      setPositionSummaries([]);
      return;
    }

    const hasCurveData =
      shockCurves &&
      (Object.keys(shockCurves.bondCurves).length > 0 || shockCurves.swapCurve.length > 0);

    const payload = {
      positions,
      shockCurves: shockCurves ?? { bondCurves: {}, swapCurve: [], fundingEvents: [] },
      fundingRate,
      fundingEvents: shockCurves?.fundingEvents ?? [],
      simDays: 0,
      shockType: 'step',
      shockMode: hasCurveData ? 'matrix' : 'parallel',
      baseShockBp: 0,
      baseDate,
      irsCurves: irsParRates,
    };

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return;
      const result = await res.json();
      setPvbpSensitivity(result.pvbpSensitivity ?? []);
      setBookDailyPnLs(result.bookDailyPnLs ?? []);
    } catch {
      // 백엔드 미연결 시 조용히 실패
    }
  }, [positions, shockCurves, fundingRate, baseDate, irsParRates]);

  useEffect(() => {
    fetchBaseMetrics();
  }, [fetchBaseMetrics]);

  const setMetrics = (pvbp: PVBPSensitivity[], bookPnLs: BookDailyPnL[]) => {
    setPvbpSensitivity(pvbp);
    setBookDailyPnLs(bookPnLs);
  };

  const calculateScenarioPnL = (): ScenarioPnL[] => [];

  return {
    pvbpSensitivity,
    bookDailyPnLs,
    positionSummaries,
    calculateScenarioPnL,
    setMetrics,
  };
};
