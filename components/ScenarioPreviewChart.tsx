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
  baseShockBp: number;
  waypoints?: { day: number; bp: number }[];
  fundingSteps?: { day: number; cumBp: number }[];
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
  { label: '20Y', years: 20 },
  { label: '30Y', years: 30 },
];

const COLORS = ['#60A5FA', '#34D399', '#F87171', '#FBBF24', '#A78BFA', '#FB923C'];

function lerpCurve(years: number, curve: { t: number; val: number }[]): number {
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

function lerpWaypoints(day: number, sorted: { day: number; bp: number }[]): number {
  if (!sorted.length) return 0;
  if (day <= sorted[0].day) return sorted[0].bp;
  if (day >= sorted[sorted.length - 1].day) return sorted[sorted.length - 1].bp;
  for (let i = 0; i < sorted.length - 1; i++) {
    if (day >= sorted[i].day && day <= sorted[i + 1].day) {
      const r = (day - sorted[i].day) / (sorted[i + 1].day - sorted[i].day);
      return sorted[i].bp + r * (sorted[i + 1].bp - sorted[i].bp);
    }
  }
  return 0;
}

function lookupFunding(day: number, steps: { day: number; cumBp: number }[]): number {
  let cum = 0;
  for (const s of steps) {
    if (s.day <= day) cum = s.cumBp;
    else break;  // steps must be sorted ascending
  }
  return cum;
}

function isStepDay(label: string, steps: { day: number; cumBp: number }[]): boolean {
  const dayNum = parseInt(label.replace('D+', ''), 10);
  // 실제 cumBp가 바뀌는 지점 (이전 값과 다른 첫 번째 occurrence)
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].day === dayNum && steps[i].cumBp !== steps[i - 1].cumBp) return true;
  }
  return false;
}

export default function ScenarioPreviewChart({
  shockCurves, simDays, baseShockBp, waypoints, fundingSteps,
}: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>('timepath');
  const [selectedSector, setSelectedSector] = useState<string>('전체');

  const hasShockCurves = !!(
    shockCurves?.swapCurve?.length ||
    Object.values(shockCurves?.bondCurves ?? {}).some(v => v.length > 0)
  );

  const sectorOptions = useMemo(() => {
    const opts = ['전체'];
    if (shockCurves?.swapCurve?.length) opts.push('IRS');
    Object.entries(shockCurves?.bondCurves ?? {}).forEach(([k, v]) => {
      if (v.length) opts.push(k);
    });
    return opts;
  }, [shockCurves]);

  // 커브형: 테너별 최종 충격 bp
  const activeCurves = useMemo(() => {
    if (!hasShockCurves) {
      return [{ key: '병행이동', data: TENOR_NODES.map(n => ({ t: n.years, val: baseShockBp })) }];
    }
    const result: { key: string; data: { t: number; val: number }[] }[] = [];
    if ((selectedSector === '전체' || selectedSector === 'IRS') && shockCurves?.swapCurve?.length) {
      result.push({ key: 'IRS', data: shockCurves.swapCurve });
    }
    Object.entries(shockCurves?.bondCurves ?? {}).forEach(([k, v]) => {
      if (!v.length) return;
      if (selectedSector === '전체' || selectedSector === k) result.push({ key: k, data: v });
    });
    return result;
  }, [shockCurves, hasShockCurves, baseShockBp, selectedSector]);

  const termData = useMemo(() => {
    return TENOR_NODES.map(({ label, years }) => {
      const row: Record<string, number | string> = { tenor: label, '현재 (0bp)': 0 };
      activeCurves.forEach(({ key, data }) => { row[key] = lerpCurve(years, data); });
      return row;
    });
  }, [activeCurves]);

  // 시계열형: 웨이포인트 기반 국채 3Y + 기준금리 경로
  const hasFundingSteps = !!(fundingSteps && fundingSteps.length > 0);
  const timeData = useMemo(() => {
    const sorted = waypoints ? [...waypoints].sort((a, b) => a.day - b.day) : [];
    const maxDay = sorted.length > 0 ? sorted[sorted.length - 1].day : simDays;

    const daySet = new Set<number>([0]);
    const step = Math.max(1, Math.floor(maxDay / 60));
    for (let d = step; d < maxDay; d += step) daySet.add(d);
    daySet.add(maxDay);
    sorted.forEach(w => daySet.add(w.day));
    // 이벤트 당일과 직전 포인트도 추가해 수직 계단 시각화
    (fundingSteps ?? []).forEach(s => { if (s.day > 0) daySet.add(s.day - 1); daySet.add(s.day); });

    return [...daySet].sort((a, b) => a - b).map(day => {
      const bp = sorted.length >= 2
        ? lerpWaypoints(day, sorted)
        : (day / simDays) * baseShockBp;
      const row: Record<string, any> = { day: `D+${day}`, '국채 3Y': parseFloat(bp.toFixed(2)) };
      if (hasFundingSteps) {
        row['기준금리'] = lookupFunding(day, fundingSteps!);
      }
      return row;
    });
  }, [waypoints, simDays, baseShockBp, fundingSteps, hasFundingSteps]);

  const waypointDaySet = useMemo(
    () => new Set((waypoints ?? []).map(w => `D+${w.day}`)),
    [waypoints],
  );

  return (
    <div className="flex-1 bg-gray-900/40 rounded-xl border border-gray-700 p-4 flex flex-col min-h-0">
      {/* 헤더 */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <h3 className="text-sm font-semibold text-blue-300">시나리오 커브 미리보기</h3>
        <div className="flex items-center gap-2">
          {hasShockCurves && viewMode === 'termstructure' && sectorOptions.length > 1 && (
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
                formatter={(v: any, name: any) => [`${Number(v).toFixed(1)}bp`, name]}
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
                domain={['auto', 'auto']}
                allowDataOverflow={false}
              />
              <ReferenceLine y={0} stroke="#6B7280" strokeWidth={1} />
              <Tooltip
                contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', fontSize: 11 }}
                formatter={(v: any, name: any) => [`${Number(v).toFixed(1)}bp`, name]}
              />
              <Legend wrapperStyle={{ fontSize: 10, paddingTop: 6 }} />
              <Line
                dataKey="국채 3Y"
                stroke="#60A5FA"
                strokeWidth={2.5}
                type="linear"
                activeDot={{ r: 4 }}
                dot={(props: any) => {
                  if (!waypointDaySet.has(props.payload?.day)) return <g key={props.index} />;
                  return (
                    <circle
                      key={props.index}
                      cx={props.cx}
                      cy={props.cy}
                      r={4}
                      fill="#60A5FA"
                      stroke="#111827"
                      strokeWidth={2}
                    />
                  );
                }}
              />
              {hasFundingSteps && (
                <Line
                  dataKey="기준금리"
                  stroke="#A78BFA"
                  strokeWidth={2.5}
                  strokeDasharray="6 3"
                  type="linear"
                  activeDot={{ r: 4, fill: '#A78BFA' }}
                  dot={(props: any) => {
                    if (!isStepDay(props.payload?.day ?? '', fundingSteps!)) return <g key={props.index} />;
                    return (
                      <circle
                        key={props.index}
                        cx={props.cx}
                        cy={props.cy}
                        r={5}
                        fill="#A78BFA"
                        stroke="#111827"
                        strokeWidth={2}
                      />
                    );
                  }}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* 하단 설명 */}
      <p className="text-xs text-gray-500 mt-2 text-center flex-shrink-0">
        {viewMode === 'termstructure'
          ? `점선: 현재 커브 · 실선: 충격 후 예상 커브 (최종 ${baseShockBp >= 0 ? '+' : ''}${baseShockBp}bp)`
          : `● = 웨이포인트 · 국채 3Y 기준 경로 · D+${simDays} 최종 ${baseShockBp >= 0 ? '+' : ''}${baseShockBp}bp${hasFundingSteps ? ' · 점선 = 기준금리 누적 변동' : ''}`}
      </p>
    </div>
  );
}
