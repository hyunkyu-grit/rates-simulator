"use client";

import React, { useState, useRef, useEffect } from 'react';
import type { Position, FundingEvent, ShockCurves, PVBPSensitivity, BookDailyPnL } from '@/types/portfolio';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';
 
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
  const [simDays, setSimDays] = useState<number>(90);
  const [shockType, setShockType] = useState<'step' | 'ramp'>('step');
  const [shockMode, setShockMode] = useState<'parallel' | 'matrix'>('parallel');
  const [baseShockBp, setBaseShockBp] = useState<number>(50); // 기본 +50bp 충격 세팅
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

  const runSimulation = async () => {
    if (!positions || positions.length === 0) return;
    setIsLoading(true);
    setErrorMsg(null);

    const payload = {
      positions,
      shockCurves: shockCurves ?? { bondCurves: {}, swapCurve: [], fundingEvents: [] },
      dailyShockCurves: dailyShockCurves ?? { bondCurves: {}, swapCurve: [], fundingEvents: [] },
      fundingRate,
      fundingEvents: propFundingEvents ?? shockCurves?.fundingEvents ?? [],
      simDays,
      shockType,
      shockMode,
      baseShockBp,
      baseDate,
      irsCurves: irsParRates,
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
        <div className="mb-6">
          <h2 className="text-xl font-bold text-blue-300">시나리오 조건 설정</h2>
          <p className="text-xs text-gray-400 mt-1">포트폴리오 Total Return 분석</p>
        </div>
        
        <div className="space-y-6 flex-1">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">시뮬레이션 기간 (일)</label>
            <input 
              type="range" min="10" max="365" step="1" 
              value={simDays} onChange={(e) => setSimDays(Number(e.target.value))} 
              className="w-full accent-blue-500"
            />
            <div className="text-right text-blue-400 font-bold mt-1">{simDays} Days</div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">금리 충격 방식</label>
            <div className="flex bg-gray-900 rounded-lg p-1">
              <button 
                onClick={() => setShockType('step')} 
                className={`flex-1 py-2 text-sm font-bold rounded-md transition ${shockType === 'step' ? 'bg-red-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Step (즉시 반영)
              </button>
              <button 
                onClick={() => setShockType('ramp')} 
                className={`flex-1 py-2 text-sm font-bold rounded-md transition ${shockType === 'ramp' ? 'bg-orange-500 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                Ramp (점진 반영)
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {shockType === 'step' ? '* 1일차에 목표 충격이 100% 반영됩니다.' : '* 설정 기간 동안 매일 점진적으로 금리가 변동합니다.'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">충격 적용 방식</label>
            <div className="flex bg-gray-900 rounded-lg p-1">
              <button 
                onClick={() => setShockMode('parallel')} 
                className={`flex-1 py-2 text-sm font-bold rounded-md transition ${shockMode === 'parallel' ? 'bg-blue-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                단순 병행 이동 (Parallel)
              </button>
              <button 
                onClick={() => setShockMode('matrix')} 
                className={`flex-1 py-2 text-sm font-bold rounded-md transition ${shockMode === 'matrix' ? 'bg-purple-600 text-white' : 'text-gray-500 hover:text-gray-300'}`}
              >
                업로드된 커브 적용 (Matrix)
              </button>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              {shockMode === 'parallel' ? '* 모든 채권에 동일한 병행 충격을 적용합니다.' : '* 업로드된 섹터/테너별 커브를 적용합니다.'}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              {shockMode === 'parallel' ? '목표 금리 변동 (Parallel Shift, bp)' : '기본 금리 변동 (Matrix 모드에서는 커브 우선 적용)'}
            </label>
            <div className="flex items-center space-x-3">
              <input 
                type="number" value={baseShockBp} 
                onChange={(e) => setBaseShockBp(Number(e.target.value))} 
                disabled={shockMode === 'matrix'}
                className={`flex-1 border border-gray-600 rounded-lg p-2 text-right text-lg font-bold ${
                  shockMode === 'matrix' 
                    ? 'bg-gray-600 text-gray-400 cursor-not-allowed' 
                    : 'bg-gray-700 text-white'
                }`} 
              />
              <span className="text-gray-400 font-medium">bp</span>
            </div>
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
          <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-gray-600 rounded-xl">
            <svg className="w-20 h-20 text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
            <h2 className="text-2xl font-bold text-gray-500 mb-2">Total Return 엔진 대기 중</h2>
            <p className="text-gray-400">좌측 패널에서 시나리오 조건을 설정하고 실행 버튼을 클릭하세요.</p>
          </div>
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
