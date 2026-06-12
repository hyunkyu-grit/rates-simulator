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
      const res = await fetch('http://localhost:8000/api/simulate', {
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
