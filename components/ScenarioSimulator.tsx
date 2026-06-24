"use client";

import React, { useState, useRef, useEffect, useMemo } from 'react';
import type { Position, FundingEvent, ShockCurves, PVBPSensitivity, BookDailyPnL } from '@/types/portfolio';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
import ScenarioPreviewChart from './ScenarioPreviewChart';

type CreditSpreads = { '특은채': number; '은행채': number; '카드채': number; '회사채': number };

function generateShockCurves(
  baseShockBp: number,
  spread1y: number,
  spread10y: number,
  spread30y: number,
  credit: CreditSpreads,
  irsSpread: number,
): ShockCurves {
  // 테너별 국채 spread (vs 3Y 앵커): 1Y↔3Y, 3Y↔10Y, 10Y↔30Y 구간 선형 보간
  const nodes = [
    { t: 1 / 365, s: spread1y },
    { t: 0.25,    s: spread1y },
    { t: 0.5,     s: spread1y },
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
  const [baseShockBp, setBaseShockBp] = useState<number>(30);
  const [waypoints, setWaypoints] = useState<{ day: number; bp: number }[]>([
    { day: 0, bp: 0 },
    { day: 180, bp: 30 },
  ]);
  const [spread1y, setSpread1y]   = useState<number>(0);
  const [spread10y, setSpread10y] = useState<number>(0);
  const [spread30y, setSpread30y] = useState<number>(0);
  const [creditSpreads, setCreditSpreads] = useState<CreditSpreads>({ '특은채': 0, '은행채': 0, '카드채': 0, '회사채': 0 });
  const [irsSpread, setIrsSpread] = useState<number>(0);
  const [spreadsOpen, setSpreadsOpen] = useState<boolean>(false);
  const [isSimulated, setIsSimulated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [chartData, setChartData] = useState<any[]>([]);
  const [summary, setSummary] = useState({ finalMTM: 0, finalCarry: 0, finalTotal: 0, breakEvenDay: -1 });
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
      result.push({ day: simDays, bp: baseShockBp });
      return result;
    });
  }, [simDays, baseShockBp]);

  const updateWaypoint = (day: number, bp: number) => {
    setWaypoints(prev => prev.map(w => w.day === day ? { ...w, bp } : w));
  };

  const generatedShockCurves = useMemo(
    () => generateShockCurves(baseShockBp, spread1y, spread10y, spread30y, creditSpreads, irsSpread),
    [baseShockBp, spread1y, spread10y, spread30y, creditSpreads, irsSpread],
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
      fundingEvents: propFundingEvents ?? [],
      simDays,
      shockType: 'ramp' as const,
      shockMode: 'matrix' as const,
      baseShockBp,
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
      if (onMetricsUpdate) onMetricsUpdate(result.pvbpSensitivity ?? [], result.bookDailyPnLs ?? []);
      setIsSimulated(true);
    } catch (err) {
      console.error('시뮬레이션 오류:', err);
      setErrorMsg(err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다. 백엔드 서버를 확인해주세요.');
    } finally {
      setIsLoading(false);
    }
  };

  const formatAmt = (num: number) => Math.round(num / 10000).toLocaleString() + '만';
  const fmtSigned = (num: number) => {
    const v = Math.round(num / 10000);
    return (v >= 0 ? '+' : '') + v.toLocaleString() + '만';
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
                type="number"
                step="any"
                value={baseShockBp}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  if (!isNaN(v)) setBaseShockBp(v);
                }}
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
                const absMax = Math.max(Math.abs(baseShockBp) + 50, 100);
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
                <span className={`text-xs font-bold w-14 text-right flex-shrink-0 font-mono ${baseShockBp > 0 ? 'text-red-400' : baseShockBp < 0 ? 'text-blue-400' : 'text-gray-400'}`}>
                  {baseShockBp >= 0 ? '+' : ''}{baseShockBp} bp
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
                          type="number"
                          step="any"
                          value={value}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v)) (set as (v: number) => void)(v);
                          }}
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
                          type="number"
                          step="any"
                          value={creditSpreads[sector]}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value);
                            if (!isNaN(v)) setCreditSpreads(prev => ({ ...prev, [sector]: v }));
                          }}
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
                    type="number"
                    step="any"
                    value={irsSpread}
                    onChange={(e) => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) setIrsSpread(v);
                    }}
                    className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-right text-white focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-xs text-gray-500 w-5 flex-shrink-0">bp</span>
                </div>
              </div>
            )}
          </div>
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
            baseShockBp={baseShockBp}
            waypoints={waypoints}
          />
        ) : (
          <>
            <div className="flex justify-between items-end mb-4">
              <div>
                <h2 className="text-xl font-bold text-blue-300">Total Return 누적 궤적</h2>
                <p className="text-xs text-gray-400 mt-1">자본손익(MTM)과 이자수익(Carry)의 상쇄 효과 분석</p>
              </div>
              <div className="flex space-x-4 bg-gray-900 p-3 rounded-lg border border-gray-700">
                <div className="text-center px-4 border-r border-gray-700">
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" />
                    <span className="text-xs text-gray-400">최종 MTM</span>
                  </div>
                  <div className="font-bold text-red-400">{fmtSigned(summary.finalMTM)}</div>
                </div>
                <div className="text-center px-4 border-r border-gray-700">
                  <div className="flex items-center justify-center gap-1.5 mb-1">
                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500 flex-shrink-0" />
                    <span className="text-xs text-gray-400">최종 누적캐리</span>
                  </div>
                  <div className="font-bold text-blue-400">{fmtSigned(summary.finalCarry)}</div>
                </div>
                <div className="text-center px-4">
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
                손익분기점(BEP) 도달: 금리 상승 충격 이후 높아진 캐리 수익으로 인해 <strong className="text-white mx-1">{summary.breakEvenDay}일 차</strong>에 원금을 회복합니다.
              </div>
            )}

            <div ref={chartContainerRef} className="flex-1 w-full min-h-[300px]">
              {chartContainerWidth > 0 && <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="day" stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 12 }} tickFormatter={(val) => `D+${val}`} />
                  <YAxis stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 12 }} tickFormatter={(val) => `${Math.round(val/10000)}만`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', color: '#fff' }}
                    formatter={(value) => {
                      const num = Math.round(Number(value ?? 0));
                      return [(num >= 0 ? '+' : '') + num.toLocaleString() + '원', ''];
                    }}
                    labelFormatter={(label) => `시뮬레이션 ${label}일 차`}
                  />
                  <Legend wrapperStyle={{ paddingTop: '20px' }} />
                  <ReferenceLine y={0} stroke="#6B7280" strokeWidth={2} />
                  {summary.breakEvenDay > 0 && (
                    <ReferenceLine x={summary.breakEvenDay} stroke="#10B981" strokeDasharray="3 3" label={{ position: 'top', value: 'BEP', fill: '#10B981', fontSize: 12 }} />
                  )}
                  <Line type="monotone" dataKey="mtmPnL" stroke="#EF4444" strokeWidth={2} dot={false} name="평가손익(MTM)" />
                  <Line type="monotone" dataKey="cumulativeCarry" stroke="#3B82F6" strokeWidth={2} dot={false} name="누적 이자수익(Carry)" />
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
