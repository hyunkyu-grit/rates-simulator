'use client';

import React, { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { ShockCurves } from '@/types/portfolio';

interface Props {
  shockCurves?: ShockCurves;
  simDays: number;
  shockType: 'step' | 'ramp';
  shockMode: 'parallel' | 'matrix';
  baseShockBp: number;
}

type ViewMode = 'termstructure' | 'timepath';

const TENOR_NODES = [
  { label: '1D', years: 1 / 365 },
  { label: '3M', years: 0.25 },
  { label: '6M', years: 0.5 },
  { label: '1Y', years: 1 },
  { label: '2Y', years: 2 },
  { label: '3Y', years: 3 },
  { label: '5Y', years: 5 },
  { label: '7Y', years: 7 },
  { label: '10Y', years: 10 },
];

const TIME_PATH_TENORS = [
  { label: '3M', years: 0.25 },
  { label: '3Y', years: 3 },
  { label: '5Y', years: 5 },
];

const COLORS = ['#60A5FA', '#34D399', '#F87171', '#FBBF24', '#A78BFA', '#FB923C'];

function lerp(years: number, curve: { t: number; val: number }[]): number {
  if (!curve.length) return 0;
  const pts = [...curve].sort((a, b) => a.t - b.t);
  if (years <= pts[0].t) return pts[0].val;
  if (years >= pts[pts.length - 1].t) return pts[pts.length - 1].val;
  for (let i = 0; i < pts.length - 1; i++) {
    if (years >= pts[i].t && years <= pts[i + 1].t) {
      const r = (years - pts[i].t) / (pts[i + 1].t - pts[i].t);
      return pts[i].val + r * (pts[i + 1].val - pts[i].val);
    }
  }
  return 0;
}

export default function ScenarioPreviewChart({
  shockCurves, simDays, shockType, shockMode, baseShockBp,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('termstructure');
  const [selectedSector, setSelectedSector] = useState<string>('전체');

  const sectorOptions = useMemo(() => {
    const opts = ['전체'];
    if (shockCurves?.swapCurve?.length) opts.push('IRS');
    Object.entries(shockCurves?.bondCurves ?? {}).forEach(([k, v]) => {
      if (v.length) opts.push(k);
    });
    return opts;
  }, [shockCurves]);

  // 렌더링할 커브 목록
  const activeCurves = useMemo<{ key: string; data: { t: number; val: number }[] }[]>(() => {
    if (shockMode === 'parallel') {
      return [{ key: 'Parallel Shift', data: TENOR_NODES.map(n => ({ t: n.years, val: baseShockBp })) }];
    }
    if (!shockCurves) return [];
    const result: { key: string; data: { t: number; val: number }[] }[] = [];
    if ((selectedSector === '전체' || selectedSector === 'IRS') && shockCurves.swapCurve?.length) {
      result.push({ key: 'IRS', data: shockCurves.swapCurve });
    }
    Object.entries(shockCurves.bondCurves ?? {}).forEach(([k, v]) => {
      if (!v.length) return;
      if (selectedSector === '전체' || selectedSector === k) result.push({ key: k, data: v });
    });
    return result;
  }, [shockCurves, shockMode, baseShockBp, selectedSector]);

  const hasData = shockMode === 'parallel' || activeCurves.length > 0;

  // 커브형 데이터: X=테너, Y=bp 변동
  const termData = useMemo(() => {
    return TENOR_NODES.map(({ label, years }) => {
      const row: Record<string, number | string> = { tenor: label, '현재 (0bp)': 0 };
      activeCurves.forEach(({ key, data }) => { row[key] = lerp(years, data); });
      return row;
    });
  }, [activeCurves]);

  // 시계열형 데이터: X=일수, Y=bp 변동
  const timeData = useMemo(() => {
    const days = new Set<number>([0]);
    if (shockType === 'step') days.add(1);
    const step = Math.max(1, Math.floor(simDays / 50));
    for (let d = 2; d < simDays; d += step) days.add(d);
    days.add(simDays);

    const refCurve =
      shockCurves?.swapCurve?.length
        ? shockCurves.swapCurve
        : activeCurves[0]?.data ?? [];

    return [...days].sort((a, b) => a - b).map(day => {
      const factor = shockType === 'step' ? (day === 0 ? 0 : 1) : day / simDays;
      const row: Record<string, number | string> = { day: `D+${day}` };
      TIME_PATH_TENORS.forEach(({ label, years }) => {
        const target = shockMode === 'parallel' ? baseShockBp : lerp(years, refCurve);
        row[label] = parseFloat((factor * target).toFixed(2));
      });
      return row;
    });
  }, [shockCurves, simDays, shockType, shockMode, baseShockBp, activeCurves]);

  // 빈 상태
  if (!hasData) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center border-2 border-dashed border-gray-600 rounded-xl">
        <div className="text-5xl mb-4 opacity-20">📈</div>
        <p className="text-gray-500 text-sm font-medium">시나리오를 설정하면</p>
        <p className="text-gray-500 text-sm">여기에 예상 경로가 표시됩니다</p>
      </div>
    );
  }

  return (
    <div className="flex-1 bg-gray-900/40 rounded-xl border border-gray-700 p-4 flex flex-col min-h-0">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h3 className="text-sm font-semibold text-blue-300">시나리오 커브 미리보기</h3>
        <div className="flex items-center gap-2">
          {shockMode === 'matrix' && sectorOptions.length > 1 && (
            <select
              value={selectedSector}
              onChange={e => setSelectedSector(e.target.value)}
              className="text-xs bg-gray-800 border border-gray-600 rounded px-2 py-1 text-gray-300 focus:outline-none focus:border-blue-500"
            >
              {sectorOptions.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          )}
          <div className="flex bg-gray-800 rounded p-0.5 border border-gray-700">
            <button
              onClick={() => setViewMode('termstructure')}
              className={`text-xs px-2 py-1 rounded transition ${viewMode === 'termstructure' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              커브형
            </button>
            <button
              onClick={() => setViewMode('timepath')}
              className={`text-xs px-2 py-1 rounded transition ${viewMode === 'timepath' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
            >
              시계열형
            </button>
          </div>
        </div>
      </div>

      {/* 차트 */}
      <div className="flex-1 min-h-0">
        {viewMode === 'termstructure' ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={termData} margin={{ top: 5, right: 15, left: -5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis dataKey="tenor" tick={{ fill: '#9CA3AF', fontSize: 10 }} />
              <YAxis
                tick={{ fill: '#9CA3AF', fontSize: 10 }}
                tickFormatter={v => `${v}bp`}
                width={42}
              />
              <ReferenceLine y={0} stroke="#6B7280" strokeWidth={1} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', fontSize: 11 }}
                formatter={(v: any, name: string) => [`${Number(v).toFixed(1)}bp`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
              <Line
                dataKey="현재 (0bp)"
                stroke="#6B7280"
                strokeDasharray="5 3"
                dot={false}
                strokeWidth={1.5}
              />
              {activeCurves.map(({ key }, i) => (
                <Line
                  key={key}
                  dataKey={key}
                  stroke={COLORS[i % COLORS.length]}
                  dot={false}
                  strokeWidth={2}
                  activeDot={{ r: 3 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={timeData} margin={{ top: 5, right: 15, left: -5, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
              <XAxis
                dataKey="day"
                tick={{ fill: '#9CA3AF', fontSize: 10 }}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fill: '#9CA3AF', fontSize: 10 }}
                tickFormatter={v => `${v}bp`}
                width={42}
              />
              <ReferenceLine y={0} stroke="#6B7280" strokeWidth={1} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', fontSize: 11 }}
                formatter={(v: any, name: string) => [`${Number(v).toFixed(1)}bp`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
              {TIME_PATH_TENORS.map(({ label }, i) => (
                <Line
                  key={label}
                  dataKey={label}
                  stroke={COLORS[i % COLORS.length]}
                  dot={false}
                  strokeWidth={2}
                  type={shockType === 'step' ? 'stepAfter' : 'linear'}
                  activeDot={{ r: 3 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 하단 설명 */}
      <p className="text-xs text-gray-500 mt-2 text-center flex-shrink-0">
        {viewMode === 'termstructure'
          ? '점선: 현재 커브 · 실선: 시나리오 충격 후 예상 커브'
          : `${shockType === 'step' ? 'Step — 즉시 전가' : 'Ramp — 선형 점진'} · IRS 주요 테너별 충격 경로`}
      </p>
    </div>
  );
}
