"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { Position, FundingEvent, ShockCurves, PVBPSensitivity, BookDailyPnL } from '@/types/portfolio';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
import ScenarioPreviewChart from './ScenarioPreviewChart';

type CreditSpreads = { '특은채': number; '은행채': number; '카드채': number; '회사채': number };

const toNum = (s: string) => { const v = parseFloat(s); return isNaN(v) ? 0 : v; };

function generateShockCurves(
  baseShockBp: number,
  spread1y: number,
  spread10y: number,
  spread30y: number,
  credit: CreditSpreads,
  irsSpread: number,
  shortEndBp: number,  // 1D/3M 최종 충격 (BOK 누적 변동; 이벤트 없으면 1Y 수준으로 폴백)
): ShockCurves {
  // 1D/3M: BOK 이벤트 기반 최종 충격, 6M: 3M↔1Y 선형 보간, 1Y 이상: 기존 spread 체계
  const shortSpread = shortEndBp - baseShockBp;  // baseShockBp 기준 상대 spread
  const sixMSpread  = shortSpread + (spread1y - shortSpread) * (0.5 - 0.25) / (1.0 - 0.25);
  const nodes = [
    { t: 1 / 365, s: shortSpread },
    { t: 0.25,    s: shortSpread },
    { t: 0.5,     s: sixMSpread  },
    { t: 1,       s: spread1y },
    { t: 2,       s: spread1y * (3 - 2) / (3 - 1) },
    { t: 3,       s: 0 },
    { t: 5,       s: spread10y * (5 - 3) / (10 - 3) },
    { t: 7,       s: spread10y * (7 - 3) / (10 - 3) },
    { t: 10,      s: spread10y },
    { t: 20,      s: spread10y + (spread30y - spread10y) * 0.5 },
    { t: 30,      s: spread30y },
  ];
  const ktb = nodes.map(({ t, s }) => ({ t, val: baseShockBp + s }));
  const bondCurves: ShockCurves['bondCurves'] = {
    '국채': ktb,
    '특은채': ktb.map(p => ({ t: p.t, val: p.val + credit['특은채'] })),
    '은행채': ktb.map(p => ({ t: p.t, val: p.val + credit['은행채'] })),
    '카드채': ktb.map(p => ({ t: p.t, val: p.val + credit['카드채'] })),
    '회사채': ktb.map(p => ({ t: p.t, val: p.val + credit['회사채'] })),
  };
  const swapCurve = ktb.map(p => ({ t: p.t, val: p.val + irsSpread }));
  return { bondCurves, swapCurve };
}

interface Props {
  positions: Position[];
  baseDate: string;
  fundingRate: number;
  shockCurves?: ShockCurves;         // 시나리오 충격 (chartData 전용)
  dailyShockCurves?: ShockCurves;    // 당일 실제 금리변동 (bookDailyPnL 전용)
  fundingEvents?: FundingEvent[];
  irsParRates?: { t: number; rate: number }[];
  onMetricsUpdate?: (pvbp: PVBPSensitivity[], bookPnLs: BookDailyPnL[]) => void;
}

export default function ScenarioSimulator({ positions, baseDate, fundingRate, shockCurves, dailyShockCurves, fundingEvents: propFundingEvents, irsParRates = [], onMetricsUpdate }: Props) {
  const [simDays, setSimDays] = useState<number>(180);
  const [baseShockBp, setBaseShockBp] = useState<string>('30');
  const [waypoints, setWaypoints] = useState<{ day: number; bp: number }[]>([
    { day: 0, bp: 0 },
    { day: 180, bp: 30 },
  ]);
  const [spread1y, setSpread1y]   = useState<string>('0');
  const [spread10y, setSpread10y] = useState<string>('0');
  const [spread30y, setSpread30y] = useState<string>('0');
  const [creditSpreads, setCreditSpreads] = useState<Record<string, string>>({ '특은채': '0', '은행채': '0', '카드채': '0', '회사채': '0' });
  const [irsSpread, setIrsSpread] = useState<string>('0');
  const [spreadsOpen, setSpreadsOpen] = useState<boolean>(false);
  const [eventsOpen, setEventsOpen] = useState<boolean>(false);
  const [shortEndEvents, setShortEndEvents] = useState<{ id: number; date: string; shiftBp: string }[]>(
    () => (propFundingEvents ?? []).map((ev, i) => ({ id: i, date: (ev as any).date ?? '', shiftBp: String((ev as any).shiftBp ?? 0) }))
  );
  const nextEventId = useRef<number>((propFundingEvents ?? []).length);
  const [isSimulated, setIsSimulated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [chartData, setChartData] = useState<any[]>([]);
  const [summary, setSummary] = useState({ finalMTM: 0, finalCarry: 0, finalSwap: 0, finalTotal: 0, breakEvenDay: -1 });
  const [irsEvents, setIrsEvents] = useState<any[]>([]);
  const [showIrsEvents, setShowIrsEvents] = useState(false);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [chartContainerWidth, setChartContainerWidth] = useState(0);

  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setChartContainerWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isSimulated && chartContainerRef.current) {
      const width = chartContainerRef.current.getBoundingClientRect().width;
      if (width > 0) setChartContainerWidth(width);
    }
  }, [isSimulated]);

  useEffect(() => {
    setWaypoints(prev => {
      const result: { day: number; bp: number }[] = [{ day: 0, bp: 0 }];
      const numSteps = Math.floor(simDays / 30);
      for (let i = 1; i < numSteps; i++) {
        const day = i * 30;
        const existing = prev.find(w => w.day === day);
        result.push({ day, bp: existing?.bp ?? 0 });
      }
      result.push({ day: simDays, bp: toNum(baseShockBp) });
      return result;
    });
  }, [simDays, baseShockBp]);

  const updateWaypoint = (day: number, bp: number) => {
    setWaypoints(prev => prev.map(w => w.day === day ? { ...w, bp } : w));
  };

  const fundingSteps = useMemo(() => {
    if (!baseDate) return [] as { day: number; cumBp: number }[];
    const base = new Date(baseDate);
    const events = shortEndEvents
      .filter(ev => ev.date)
      .map(ev => ({
        day: Math.round((new Date(ev.date).getTime() - base.getTime()) / 86400000),
        shiftBp: toNum(ev.shiftBp),
      }))
      .filter(ev => ev.day >= 0 && ev.day <= simDays)
      .sort((a, b) => a.day - b.day);
    if (!events.length) return [] as { day: number; cumBp: number }[];
    const pts: { day: number; cumBp: number }[] = [{ day: 0, cumBp: 0 }];
    let cum = 0;
    for (const ev of events) {
      pts.push({ day: ev.day - 1, cumBp: cum }); // 이벤트 직전 유지
      cum += ev.shiftBp;
      pts.push({ day: ev.day, cumBp: cum });      // 이벤트 당일 변동
    }
    if (pts[pts.length - 1].day < simDays) pts.push({ day: simDays, cumBp: cum });
    return pts;
  }, [shortEndEvents, baseDate, simDays]);

  // BOK 이벤트가 시뮬레이션 기간 내에 있으면 최종 누적 변동, 없으면 0 (기준금리 불변)
  const shortEndBp = fundingSteps.length > 0
    ? fundingSteps[fundingSteps.length - 1].cumBp
    : 0;

  const generatedShockCurves = useMemo(
    () => generateShockCurves(
      toNum(baseShockBp),
      toNum(spread1y), toNum(spread10y), toNum(spread30y),
      Object.fromEntries(
        Object.entries(creditSpreads).map(([k, v]) => [k, toNum(v)])
      ) as CreditSpreads,
      toNum(irsSpread),
      shortEndBp,
    ),
    [baseShockBp, spread1y, spread10y, spread30y, creditSpreads, irsSpread, shortEndBp],
  );

  const runSimulation = async () => {
    if (!positions || positions.length === 0) return;
    setIsLoading(true);
    setErrorMsg(null);

    const payload = {
      positions,
      shockCurves: generatedShockCurves,
      dailyShockCurves: dailyShockCurves ?? { bondCurves: {}, swapCurve: [], fundingEvents: [] },
      fundingRate,
      fundingEvents: shortEndEvents
        .filter(ev => ev.date)
        .map(ev => ({ date: ev.date, shiftBp: toNum(ev.shiftBp) })),
      simDays,
      shockType: 'ramp' as const,
      shockMode: 'matrix' as const,
      baseShockBp: toNum(baseShockBp),
      baseDate,
      irsCurves: irsParRates,
      customPath: waypoints,
    };

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/api/simulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}${errText ? ` — ${errText}` : ''}`);
      }
      const result = await res.json();

      setChartData(result.chartData ?? []);
      if (result.summary) setSummary(result.summary);
      if (result.irsSettlementEvents) setIrsEvents(result.irsSettlementEvents);
      if (onMetricsUpdate) onMetricsUpdate(result.pvbpSensitivity ?? [], result.bookDailyPnLs ?? []);
      setIsSimulated(true);
    } catch (err) {
      console.error('시뮬레이션 오류:', err);
      setErrorMsg(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다. 백엔드 서버를 확인해주세요.');
    } finally {
      setIsLoading(false);
    }
  };

  // baseDate 또는 fundingRate가 바뀌면 이미 시뮬레이션된 상태에서 자동 재실행
  const prevBaseDateRef = useRef(baseDate);
  const prevFundingRateRef = useRef(fundingRate);
  useEffect(() => {
    if (
      isSimulated &&
      positions.length > 0 &&
      (prevBaseDateRef.current !== baseDate || prevFundingRateRef.current !== fundingRate)
    ) {
      prevBaseDateRef.current = baseDate;
      prevFundingRateRef.current = fundingRate;
      runSimulation();
    } else {
      prevBaseDateRef.current = baseDate;
      prevFundingRateRef.current = fundingRate;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseDate, fundingRate]);

  const formatAmt = (num: number) => Math.round(num / 10000).toLocaleString() + '만';
  const fmtSigned = (num: number) => {
    const v = Math.round(num / 10000);
    return (v >= 0 ? '+' : '') + v.toLocaleString() + '만';
  };

  const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
  const offsetToDate = (offset: number): Date => {
    const [y, m, d] = baseDate.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + offset);
    return dt;
  };
  const fmtTickDate = (offset: number): string => {
    const dt = offsetToDate(offset);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  };
  const fmtTooltipDate = (offset: number): string => {
    const dt = offsetToDate(offset);
    const dow = DAY_NAMES[dt.getDay()];
    const isWeekend = dt.getDay() === 0 || dt.getDay() === 6;
    return `D+${offset} · ${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}(${dow})${isWeekend ? ' 〔주말〕' : ''}`;
  };
  const fmtDateShort = (offset: number): string => {
    const dt = offsetToDate(offset);
    return `${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}`;
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 h-[calc(100vh-120px)]">
      
      {/* 좌측: 시나리오 설정 패널 (1칸) */}
      <div className="bg-gray-800 rounded-lg p-5 shadow-xl col-span-1 flex flex-col">
        <div className="mb-5">
          <h2 className="text-xl font-bold text-blue-300">시나리오 조건 설정</h2>
          <p className="text-xs text-gray-400 mt-1">국채 3Y 기준 금리 경로 설계</p>
        </div>

        <div className="space-y-5 flex-1 overflow-y-auto pr-1">
          {/* 1. 시뮬레이션 기간 */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">시뮬레이션 기간</label>
            <input
              type="range" min="30" max="365" step="1"
              value={simDays} onChange={(e) => setSimDays(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="text-right text-blue-400 font-bold mt-1">{simDays} Days</div>
          </div>

          {/* 2. Base 충격 */}
          <div>
            <div className="flex justify-between items-center mb-2">
              <label className="text-sm font-medium text-gray-300">국채 3Y 목표 변동</label>
              <span className="text-xs text-gray-500 bg-gray-700 px-2 py-0.5 rounded">D+{simDays} 고정</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="decimal"
                value={baseShockBp}
                onChange={(e) => setBaseShockBp(e.target.value)}
                className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-right text-lg font-bold text-white focus:outline-none focus:border-blue-500"
              />
              <span className="text-gray-400 font-medium text-sm">bp</span>
            </div>
          </div>

          {/* 3. 경로 설정 */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-3">경로 설정 (국채 3Y)</label>
            <div className="space-y-2.5">
              {/* D+0 고정 */}
              <div className="flex items-center gap-2 opacity-40 select-none">
                <span className="text-xs text-gray-400 w-12 flex-shrink-0 font-mono">D+0</span>
                <div className="flex-1 h-1 bg-gray-700 rounded" />
                <span className="text-xs text-gray-400 w-14 text-right flex-shrink-0 font-mono">0 bp</span>
              </div>

              {/* 중간 웨이포인트 */}
              {waypoints.slice(1, -1).map((wp) => {
                const absMax = Math.max(Math.abs(toNum(baseShockBp)) + 50, 100);
                const bpColor = wp.bp > 0 ? 'text-red-400' : wp.bp < 0 ? 'text-blue-400' : 'text-gray-400';
                return (
                  <div key={wp.day} className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 w-12 flex-shrink-0 font-mono">D+{wp.day}</span>
                    <input
                      type="range"
                      min={-absMax} max={absMax} step={1}
                      value={wp.bp}
                      onChange={(e) => updateWaypoint(wp.day, Number(e.target.value))}
                      className="flex-1 accent-blue-500 cursor-pointer"
                    />
                    <span className={`text-xs font-bold w-14 text-right flex-shrink-0 font-mono ${bpColor}`}>
                      {wp.bp >= 0 ? '+' : ''}{wp.bp} bp
                    </span>
                  </div>
                );
              })}

              {/* D+simDays 고정 */}
              <div className="flex items-center gap-2 opacity-40 select-none">
                <span className="text-xs text-gray-400 w-12 flex-shrink-0 font-mono">D+{simDays}</span>
                <div className="flex-1 h-1 bg-gray-700 rounded" />
                <span className={`text-xs font-bold w-14 text-right flex-shrink-0 font-mono ${toNum(baseShockBp) > 0 ? 'text-red-400' : toNum(baseShockBp) < 0 ? 'text-blue-400' : 'text-gray-400'}`}>
                  {toNum(baseShockBp) >= 0 ? '+' : ''}{baseShockBp} bp
                </span>
              </div>
            </div>
          </div>

          {/* 4. 커브 스프레드 설정 */}
          <div className="border-t border-gray-700 pt-4">
            <button
              onClick={() => setSpreadsOpen(!spreadsOpen)}
              className="flex items-center justify-between w-full text-sm font-medium text-gray-300 hover:text-white transition"
            >
              <span>커브 스프레드 설정</span>
              <span className="text-gray-500 text-xs ml-2">{spreadsOpen ? '▲' : '▼'}</span>
            </button>

            {spreadsOpen && (
              <div className="mt-3 space-y-4">
                {/* 국고채 테너 스프레드 */}
                <div>
                  <p className="text-xs text-gray-500 mb-2">국고채 테너 스프레드 (vs 국채 3Y)</p>
                  <div className="space-y-1.5">
                    {([
                      { label: '1Y 기준', value: spread1y, set: setSpread1y },
                      { label: '10Y 기준', value: spread10y, set: setSpread10y },
                      { label: '30Y 기준', value: spread30y, set: setSpread30y },
                    ] as const).map(({ label, value, set }) => (
                      <div key={label} className="flex items-center gap-2">
                        <span className="text-xs text-gray-400 w-14 flex-shrink-0">{label}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={value}
                          onChange={(e) => (set as (v: string) => void)(e.target.value)}
                          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-right text-white focus:outline-none focus:border-blue-500"
                        />
                        <span className="text-xs text-gray-500 w-5 flex-shrink-0">bp</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 크레딧 스프레드 */}
                <div>
                  <p className="text-xs text-gray-500 mb-2">크레딧 스프레드 (국채 대비 추가)</p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
                    {(Object.keys(creditSpreads) as (keyof CreditSpreads)[]).map((sector) => (
                      <div key={sector} className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-400 w-10 flex-shrink-0">{sector}</span>
                        <input
                          type="text"
                          inputMode="decimal"
                          value={creditSpreads[sector]}
                          onChange={(e) => setCreditSpreads(prev => ({ ...prev, [sector]: e.target.value }))}
                          className="flex-1 min-w-0 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-right text-white focus:outline-none focus:border-blue-500"
                        />
                        <span className="text-xs text-gray-500">bp</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* IRS 스프레드 */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400 w-14 flex-shrink-0">IRS 스프레드</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={irsSpread}
                    onChange={(e) => setIrsSpread(e.target.value)}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-right text-white focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-xs text-gray-500 w-5 flex-shrink-0">bp</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 금통위 이벤트 설정 */}
        <div className="border-t border-gray-700 pt-4">
          <button
            onClick={() => setEventsOpen(!eventsOpen)}
            className="flex items-center justify-between w-full text-left"
          >
            <span className="text-sm font-medium text-gray-300">
              금통위 이벤트 (기준금리)
              {shortEndEvents.filter(ev => ev.date).length > 0 && (
                <span className="ml-2 text-xs text-purple-400">
                  {shortEndEvents.filter(ev => ev.date).length}건 등록
                </span>
              )}
            </span>
            <span className="text-gray-500 text-xs">{eventsOpen ? '▲' : '▼'}</span>
          </button>

          {eventsOpen && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">날짜 · 변동폭 (bp)</span>
                <button
                  onClick={() => {
                    const id = nextEventId.current++;
                    setShortEndEvents(prev => [...prev, { id, date: '', shiftBp: '-25' }]);
                  }}
                  className="text-xs bg-purple-900/40 hover:bg-purple-800/50 text-purple-300 hover:text-purple-200 border border-purple-700 rounded px-2 py-0.5 transition"
                >
                  + 추가
                </button>
              </div>

              {shortEndEvents.length === 0 ? (
                <p className="text-xs text-gray-600 text-center py-2">등록된 이벤트 없음</p>
              ) : (
                <div className="space-y-1.5">
                  {shortEndEvents.map(ev => (
                    <div key={ev.id} className="flex items-center gap-1.5">
                      <input
                        type="date"
                        value={ev.date}
                        onChange={e =>
                          setShortEndEvents(prev =>
                            prev.map(x => x.id === ev.id ? { ...x, date: e.target.value } : x)
                          )
                        }
                        className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-purple-500"
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        value={ev.shiftBp}
                        onChange={e =>
                          setShortEndEvents(prev =>
                            prev.map(x => x.id === ev.id ? { ...x, shiftBp: e.target.value } : x)
                          )
                        }
                        className="w-14 bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-xs text-right text-white focus:outline-none focus:border-purple-500"
                        placeholder="bp"
                      />
                      <span className="text-xs text-gray-500 flex-shrink-0">bp</span>
                      <button
                        onClick={() => setShortEndEvents(prev => prev.filter(x => x.id !== ev.id))}
                        className="text-gray-500 hover:text-red-400 text-base leading-none flex-shrink-0"
                      >×</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <button
          onClick={runSimulation}
          disabled={isLoading}
          className={`w-full font-extrabold text-lg py-4 rounded-xl shadow-lg transition-transform transform mt-4 ${
            isLoading
              ? 'bg-gray-600 text-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-500 text-white active:scale-95'
          }`}
        >
          {isLoading ? '계산 중...' : '시뮬레이션 실행 🚀'}
        </button>
      </div>

      {/* 우측: 차트 및 결과 요약 (3칸) */}
      <div className="bg-gray-800 rounded-lg p-5 shadow-xl col-span-1 lg:col-span-3 flex flex-col">
        {errorMsg && (
          <div className="bg-red-900/60 border border-red-500 text-red-200 px-4 py-3 rounded-lg mb-3 flex items-start space-x-3">
            <span className="text-red-400 text-xl flex-shrink-0">⚠</span>
            <div className="flex-1 min-w-0">
              <p className="font-bold text-red-300">시뮬레이션 오류 발생</p>
              <p className="text-sm mt-1 break-all">{errorMsg}</p>
            </div>
            <button onClick={() => setErrorMsg(null)} className="text-red-400 hover:text-red-200 flex-shrink-0 ml-2 text-lg leading-none">✕</button>
          </div>
        )}
        {isLoading ? (
          <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-blue-700 rounded-xl">
            <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-5" />
            <h2 className="text-xl font-bold text-blue-300 mb-2">엔진 시뮬레이션 계산 중...</h2>
            <p className="text-gray-400 text-sm">(통상 1~2초 소요)</p>
          </div>
        ) : !isSimulated ? (
          <ScenarioPreviewChart
            shockCurves={generatedShockCurves}
            simDays={simDays}
            baseShockBp={toNum(baseShockBp)}
            waypoints={waypoints}
            fundingSteps={fundingSteps}
          />
        ) : (
          <>
            <div className="flex justify-between items-end mb-4">
              <div>
                <h2 className="text-xl font-bold text-blue-300">Total Return 누적 궤적</h2>
                <p className="text-xs text-gray-400 mt-1">자본손익(MTM)과 이자수익(Carry)의 상쇄 효과 분석</p>
              </div>
              <div className="flex space-x-4 bg-gray-900 p-3 rounded-lg border border-gray-700">
                <div className="text-center px-3 border-r border-gray-700">
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" />
                    <span className="text-xs text-gray-400">채권 MTM</span>
                  </div>
                  <div className="font-bold text-red-400">{fmtSigned(summary.finalMTM)}</div>
                </div>
                <div className="text-center px-3 border-r border-gray-700">
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0" />
                    <span className="text-xs text-gray-400">채권 캐리</span>
                  </div>
                  <div className="font-bold text-blue-400">{fmtSigned(summary.finalCarry)}</div>
                </div>
                <div className="text-center px-3 border-r border-gray-700">
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-violet-400 flex-shrink-0" />
                    <span className="text-xs text-gray-400">스왑손익</span>
                  </div>
                  <div className="font-bold text-violet-400">{fmtSigned(summary.finalSwap)}</div>
                </div>
                <div className="text-center px-3">
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 flex-shrink-0" />
                    <span className="text-xs text-gray-400">Total Return</span>
                  </div>
                  <div className="font-extrabold text-lg text-emerald-400">{fmtSigned(summary.finalTotal)}</div>
                </div>
              </div>
            </div>
            
            {summary.breakEvenDay > 0 && (
              <div className="bg-green-900/30 border border-green-800 text-green-300 px-4 py-2 rounded-lg text-sm mb-4 font-medium flex items-center">
                <span className="mr-2">🎯</span>
                손익분기점(BEP) 도달: 금리 충격 이후 높아진 캐리 수익으로
                {' '}<strong className="text-white mx-1">D+{summary.breakEvenDay} ({fmtDateShort(summary.breakEvenDay)})</strong>에 원금을 회복합니다.
              </div>
            )}

            {/* BOK 이벤트 MTM 구간별 분해 검증 테이블 */}
            {(() => {
              const bokEvents = chartData.filter((d: any) => d.bokBreakdown);
              if (!bokEvents.length) return null;
              const fmtBok = (v: number) => {
                const eok = Math.round(v / 100000000 * 10) / 10;
                return (eok >= 0 ? '+' : '') + eok.toFixed(1) + '억';
              };
              return (
                <div className="bg-gray-900/70 border border-purple-800/40 rounded-lg p-3 mb-3">
                  <div className="text-xs font-semibold text-purple-300 mb-2">금통위 이벤트 당일 MTM 영향 분해</div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-gray-400 border-b border-gray-700">
                        <th className="text-left py-1 w-16">이벤트일</th>
                        <th className="text-right py-1">1D<br/><span className="text-gray-600 font-normal">오버나이트</span></th>
                        <th className="text-right py-1">3M 이하<br/><span className="text-gray-600 font-normal">BOK 직결</span></th>
                        <th className="text-right py-1">3M~1Y<br/><span className="text-gray-600 font-normal">블렌드</span></th>
                        <th className="text-right py-1">1Y 이상<br/><span className="text-gray-600 font-normal">장기경로</span></th>
                        <th className="text-right py-1 font-bold">합계</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bokEvents.map((d: any) => {
                        const b = d.bokBreakdown;
                        const bondTotal = b.shortDelta + b.blendDelta + b.longDelta;
                        const irsTotal  = (b.irs1dDelta ?? 0) + (b.irs3mDelta ?? 0) + (b.irsBlendDelta ?? 0) + (b.irsLongDelta ?? 0);
                        const hasIrs    = (b.irs1dPvbp !== undefined || b.irs3mPvbp !== undefined) &&
                          (Math.abs(b.irs1dPvbp ?? 0) + Math.abs(b.irs3mPvbp ?? 0) + Math.abs(b.irsBlendPvbp ?? 0) + Math.abs(b.irsLongPvbp ?? 0)) > 0;

                        const clr = (v: number) => v < 0 ? 'text-red-400' : v > 0 ? 'text-blue-400' : 'text-gray-500';
                        // 채권: pvbp 대비 역산 변동폭 (bond pvbp는 단일 방향이라 안전)
                        const bondImpliedBp = (delta: number, pvbp: number) =>
                          pvbp !== 0 ? Math.round(-delta / pvbp * 10) / 10 : null;
                        const fmtBp = (bp: number | null | undefined) =>
                          bp == null ? null : `${bp >= 0 ? '+' : ''}${bp}bp`;
                        const fmtPvbp = (v: number) => {
                          const man = Math.round(v / 10000);
                          return (man >= 0 ? '+' : '') + man.toLocaleString() + '만';
                        };

                        const shortBp = bondImpliedBp(b.shortDelta, b.shortPvbp);
                        const blendBp = bondImpliedBp(b.blendDelta, b.blendPvbp);
                        const longBp  = bondImpliedBp(b.longDelta,  b.longPvbp);

                        // IRS 변동폭: net KRD 역산 대신 백엔드에서 계산한 실제 충격 bp 직접 사용
                        // (net KRD는 pay/receive 상쇄로 0에 가까울 수 있어 역산 시 발산)
                        const irs1dBp    = b.bokShortBp  ?? null;
                        const irs3mBp    = b.bokShortBp  ?? null;
                        const irsBlendBp = b.bokBlendBp  ?? null;
                        const irsLongBp  = b.bokLongBp   ?? null;

                        // 라벨 공통 스타일
                        const labelStyle = "text-[10px] font-semibold mt-0.5";

                        return (
                          <React.Fragment key={d.day}>
                            {/* 채권 행 */}
                            <tr className="border-t border-gray-700/50">
                              <td className="py-1.5 text-gray-300 align-top">
                                <div>{fmtDateShort(d.day)}</div>
                                <div className={`${labelStyle} text-gray-400`}>채권</div>
                              </td>
                              {/* 1D: 채권은 1D 구간 없음 */}
                              <td className="py-1.5 text-right text-gray-600">—</td>
                              <td className={`py-1.5 text-right ${clr(b.shortDelta)}`}>
                                <div>{fmtBok(b.shortDelta)}</div>
                                {shortBp !== null && <div className="text-gray-500">{fmtBp(shortBp)}</div>}
                              </td>
                              <td className={`py-1.5 text-right ${clr(b.blendDelta)}`}>
                                <div>{fmtBok(b.blendDelta)}</div>
                                {blendBp !== null && <div className="text-gray-500">{fmtBp(blendBp)}</div>}
                              </td>
                              <td className={`py-1.5 text-right ${clr(b.longDelta)}`}>
                                <div>{fmtBok(b.longDelta)}</div>
                                {longBp !== null && <div className="text-gray-500">{fmtBp(longBp)}</div>}
                              </td>
                              <td className={`py-1.5 text-right font-bold ${bondTotal < 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                                {fmtBok(bondTotal)}
                              </td>
                            </tr>
                            {/* IRS 행 */}
                            {hasIrs && (
                              <tr className="bg-indigo-950/20">
                                <td className="py-1.5 text-gray-300 align-top">
                                  <div className="text-xs invisible select-none">—</div>
                                  <div className={`${labelStyle} text-indigo-400`}>IRS</div>
                                </td>
                                <td className={`py-1.5 text-right ${clr(b.irs1dDelta ?? 0)}`}>
                                  <div>{fmtBok(b.irs1dDelta ?? 0)}</div>
                                  <div className="text-gray-500">PVBP {fmtPvbp(b.irs1dPvbp ?? 0)}</div>
                                  {irs1dBp !== null && <div className="text-gray-500">{fmtBp(irs1dBp)}</div>}
                                </td>
                                <td className={`py-1.5 text-right ${clr(b.irs3mDelta ?? 0)}`}>
                                  <div>{fmtBok(b.irs3mDelta ?? 0)}</div>
                                  <div className="text-gray-500">PVBP {fmtPvbp(b.irs3mPvbp ?? 0)}</div>
                                  {irs3mBp !== null && <div className="text-gray-500">{fmtBp(irs3mBp)}</div>}
                                </td>
                                <td className={`py-1.5 text-right ${clr(b.irsBlendDelta ?? 0)}`}>
                                  <div>{fmtBok(b.irsBlendDelta ?? 0)}</div>
                                  <div className="text-gray-500">PVBP {fmtPvbp(b.irsBlendPvbp ?? 0)}</div>
                                  {irsBlendBp !== null && <div className="text-gray-500">{fmtBp(irsBlendBp)}</div>}
                                </td>
                                <td className={`py-1.5 text-right ${clr(b.irsLongDelta ?? 0)}`}>
                                  <div>{fmtBok(b.irsLongDelta ?? 0)}</div>
                                  <div className="text-gray-500">PVBP {fmtPvbp(b.irsLongPvbp ?? 0)}</div>
                                  {irsLongBp !== null && <div className="text-gray-500">{fmtBp(irsLongBp)}</div>}
                                </td>
                                <td className={`py-1.5 text-right font-bold ${irsTotal < 0 ? 'text-red-300' : 'text-emerald-300'}`}>
                                  {fmtBok(irsTotal)}
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="text-gray-600 text-xs mt-1.5">괄호/bp = 구간 PVBP 역산 금리변동폭 · IRS PVBP = 구간 KRD 합산(음수=단기수취·PAY고정) · 1D=오버나이트 KRD</p>
                </div>
              );
            })()}

            {/* IRS 정산 이벤트 진단 테이블 */}
            {irsEvents.length > 0 && (
              <div className="bg-gray-900/70 border border-indigo-800/40 rounded-lg p-3 mb-3">
                <button
                  onClick={() => setShowIrsEvents(v => !v)}
                  className="flex items-center justify-between w-full"
                >
                  <span className="text-xs font-semibold text-indigo-300">
                    IRS 리픽싱 정산 이벤트 ({irsEvents.length}건)
                  </span>
                  <span className="text-xs text-gray-500">{showIrsEvents ? '▲ 접기' : '▼ 펼치기'}</span>
                </button>
                {showIrsEvents && (
                  <div className="mt-2 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-gray-400 border-b border-gray-700">
                          <th className="text-left py-1 pr-3">날짜</th>
                          <th className="text-left py-1 pr-3">D+</th>
                          <th className="text-left py-1 pr-3 max-w-[180px]">종목명</th>
                          <th className="text-right py-1 pr-3">액면(억)</th>
                          <th className="text-right py-1 pr-3">방향</th>
                          <th className="text-right py-1 pr-3">고정금리</th>
                          <th className="text-right py-1">정산 CF(만)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {irsEvents
                          .sort((a: any, b: any) => a.day - b.day)
                          .map((ev: any, i: number) => {
                            const cfMan = Math.round((ev.settledCf || 0) / 10000);
                            const notEok = Math.round((ev.notional || 0) / 1e8 * 10) / 10;
                            return (
                              <tr key={i} className={`border-b border-gray-800 ${cfMan >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                <td className="py-1 pr-3 text-gray-300">{ev.date ?? '-'}</td>
                                <td className="py-1 pr-3 text-gray-400">D+{ev.day}</td>
                                <td className="py-1 pr-3 text-gray-200 truncate max-w-[180px]">{ev.positionName}</td>
                                <td className="py-1 pr-3 text-right text-gray-300">{notEok.toFixed(0)}</td>
                                <td className="py-1 pr-3 text-right">{ev.direction === 1 ? 'RF' : 'PF'}</td>
                                <td className="py-1 pr-3 text-right text-gray-300">{(ev.fixedRate || 0).toFixed(3)}%</td>
                                <td className="py-1 text-right font-medium">{cfMan >= 0 ? '+' : ''}{cfMan.toLocaleString()}</td>
                              </tr>
                            );
                          })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div ref={chartContainerRef} className="flex-1 w-full min-h-[300px]">
              {chartContainerWidth > 0 && <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis
                    dataKey="day"
                    stroke="#9CA3AF"
                    tick={{ fill: '#9CA3AF', fontSize: 11 }}
                    tickFormatter={(val) => fmtTickDate(val)}
                    interval={Math.max(1, Math.floor(simDays / 8))}
                  />
                  <YAxis stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 12 }} tickFormatter={(val) => `${Math.round(val/10000)}만`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', color: '#fff' }}
                    formatter={(value) => {
                      const num = Math.round(Number(value ?? 0));
                      return [(num >= 0 ? '+' : '') + num.toLocaleString() + '원', ''];
                    }}
                    labelFormatter={(label) => fmtTooltipDate(Number(label))}
                  />
                  <Legend wrapperStyle={{ paddingTop: '20px' }} />
                  <ReferenceLine y={0} stroke="#6B7280" strokeWidth={2} />
                  {summary.breakEvenDay > 0 && (
                    <ReferenceLine x={summary.breakEvenDay} stroke="#10B981" strokeDasharray="3 3" label={{ position: 'top', value: 'BEP', fill: '#10B981', fontSize: 12 }} />
                  )}
                  <Line type="monotone" dataKey="mtmPnL" stroke="#EF4444" strokeWidth={2} dot={false} name="채권 평가손익(MTM)" />
                  <Line type="monotone" dataKey="cumulativeCarry" stroke="#3B82F6" strokeWidth={2} dot={false} name="채권 누적캐리(Carry)" />
                  <Line type="monotone" dataKey="swapPnL" stroke="#A78BFA" strokeWidth={2} dot={false} name="스왑손익(IRS)" />
                  <Line type="monotone" dataKey="totalPnL" stroke="#10B981" strokeWidth={4} dot={false} name="Total Return (합계)" />
                </LineChart>
              </ResponsiveContainer>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
