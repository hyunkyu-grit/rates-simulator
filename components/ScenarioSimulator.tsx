"use client";

import React, { useState, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts';

interface Position {
  id: string; name: string; book: string; bondType: 'swap' | 'bond';
  sector: string; maturityDate: string; couponRate: number;
  evaluationAmount: number; duration: number; pvbp: number;
  remainingDays: number; krdMap: { [tenor: string]: number };
  mtmYield?: number; expectedThetaPnL?: number;
  nextFixingDate?: Date; currentFloatRate?: number;
}

interface Props {
  positions: Position[];
  baseDate: string;
  fundingRate: number;
}

export default function ScenarioSimulator({ positions, baseDate, fundingRate }: Props) {
  const [simDays, setSimDays] = useState<number>(90);
  const [shockType, setShockType] = useState<'step' | 'ramp'>('step');
  const [baseShockBp, setBaseShockBp] = useState<number>(50); // 기본 +50bp 충격 세팅
  const [isSimulated, setIsSimulated] = useState<boolean>(false);
  const [chartData, setChartData] = useState<any[]>([]);
  const [summary, setSummary] = useState({ finalMTM: 0, finalCarry: 0, finalTotal: 0, breakEvenDay: -1 });

  const runSimulation = () => {
    console.log('🚀 시뮬레이션 엔진 가동...');
    const data = [];
    let cumulativeCarry = 0;
    let breakEvenDay = -1;
    let isBrokenEven = false;

    // Day 0 (현재 상태)
    data.push({
      day: 0,
      MTM손익: 0,
      누적캐리: 0,
      총손익: 0
    });

    // 시뮬레이션 루프 (t = 1 to simDays)
    for (let t = 1; t <= simDays; t++) {
      let dailyMTM = 0;
      let dailyCarry = 0;

      // 1. 충격 계수 (Step vs Ramp)
      const multiplier = shockType === 'step' ? 1.0 : (t / simDays);
      const currentShockBp = baseShockBp * multiplier;

      positions.forEach(p => {
        const evalAmt = Number(p.evaluationAmount) || 0;
        
        // [평가손익 (MTM)] : 금리 상승(Shock>0) 시, PVBP가 양수이면 손실 발생
        const mtmPnL = p.pvbp * (-currentShockBp);
        dailyMTM += mtmPnL;

        // [당일 캐리 (Carry)] : 금리가 오르면(Shock>0) 그만큼 재투자/이표 일드가 높아진다고 가정 (선형 근사)
        let carryRate = Number(p.mtmYield) || 0;
        carryRate += (currentShockBp / 100); // Shock 반영된 새로운 일드(%)

        const dailyInterest = (evalAmt * (carryRate / 100)) / 365;
        const dailyFundingCost = (evalAmt * fundingRate) / 365;
        
        // 스왑의 경우 단순화된 세타(Carry) 합산 + 충격 반영분
        if (p.bondType === 'swap') {
            dailyCarry += ((p.expectedThetaPnL || 0) + (evalAmt * (currentShockBp / 10000) / 365));
        } else {
            dailyCarry += (dailyInterest - dailyFundingCost);
        }
      });

      // 캐리 누적
      cumulativeCarry += dailyCarry;
      const totalPnL = dailyMTM + cumulativeCarry;

      // BEP 돌파 일자 포착 (초반에 마이너스였다가 양수로 전환되는 시점)
      if (totalPnL >= 0 && dailyMTM < 0 && !isBrokenEven) {
        breakEvenDay = t;
        isBrokenEven = true;
      }

      data.push({
        day: t,
        MTM손익: Math.round(dailyMTM),
        누적캐리: Math.round(cumulativeCarry),
        총손익: Math.round(totalPnL)
      });
    }

    setChartData(data);
    setSummary({
      finalMTM: data[simDays].MTM손익,
      finalCarry: data[simDays].누적캐리,
      finalTotal: data[simDays].총손익,
      breakEvenDay
    });
    setIsSimulated(true);
  };

  const formatAmt = (num: number) => Math.round(num / 10000).toLocaleString() + '만';

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
            <label className="block text-sm font-medium text-gray-300 mb-2">목표 금리 변동 (Parallel Shift, bp)</label>
            <div className="flex items-center space-x-3">
              <input 
                type="number" value={baseShockBp} 
                onChange={(e) => setBaseShockBp(Number(e.target.value))} 
                className="flex-1 bg-gray-700 border border-gray-600 rounded-lg p-2 text-white text-right text-lg font-bold" 
              />
              <span className="text-gray-400 font-medium">bp</span>
            </div>
          </div>
        </div>
        
        <button 
          onClick={runSimulation} 
          className="w-full bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-lg py-4 rounded-xl shadow-lg transition-transform transform active:scale-95 mt-4"
        >
          시뮬레이션 실행 🚀
        </button>
      </div>

      {/* 우측: 차트 및 결과 요약 (3칸) */}
      <div className="bg-gray-800 rounded-lg p-5 shadow-xl col-span-1 lg:col-span-3 flex flex-col">
        {!isSimulated ? (
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
                <h2 className="text-xl font-bold text-blue-300">Total Return 누적 궤적 (Nike Swoosh)</h2>
                <p className="text-xs text-gray-400 mt-1">자본손익(MTM)과 이자수익(Carry)의 상쇄 효과 분석</p>
              </div>
              <div className="flex space-x-4 bg-gray-900 p-3 rounded-lg border border-gray-700">
                <div className="text-center px-4 border-r border-gray-700">
                  <div className="text-xs text-gray-400 mb-1">최종 MTM</div>
                  <div className={`font-bold ${summary.finalMTM > 0 ? 'text-green-400' : 'text-red-400'}`}>{formatAmt(summary.finalMTM)}</div>
                </div>
                <div className="text-center px-4 border-r border-gray-700">
                  <div className="text-xs text-gray-400 mb-1">최종 누적캐리</div>
                  <div className="font-bold text-blue-400">+{formatAmt(summary.finalCarry)}</div>
                </div>
                <div className="text-center px-4">
                  <div className="text-xs text-gray-400 mb-1">Total Return</div>
                  <div className={`font-extrabold text-lg ${summary.finalTotal > 0 ? 'text-green-400' : 'text-red-400'}`}>{formatAmt(summary.finalTotal)}</div>
                </div>
              </div>
            </div>
            
            {summary.breakEvenDay > 0 && (
              <div className="bg-green-900/30 border border-green-800 text-green-300 px-4 py-2 rounded-lg text-sm mb-4 font-medium flex items-center">
                <span className="mr-2">🎯</span>
                손익분기점(BEP) 도달: 금리 상승 충격 이후 높아진 캐리 수익으로 인해 <strong className="text-white mx-1">{summary.breakEvenDay}일 차</strong>에 원금을 회복합니다.
              </div>
            )}

            <div className="flex-1 w-full min-h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" vertical={false} />
                  <XAxis dataKey="day" stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 12 }} tickFormatter={(val) => `D+${val}`} />
                  <YAxis stroke="#9CA3AF" tick={{ fill: '#9CA3AF', fontSize: 12 }} tickFormatter={(val) => `${Math.round(val/10000)}만`} />
                  <Tooltip 
                    contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', color: '#fff' }}
                    formatter={(value: number) => [Math.round(value).toLocaleString() + '원', '']}
                    labelFormatter={(label) => `시뮬레이션 ${label}일 차`}
                  />
                  <Legend wrapperStyle={{ paddingTop: '20px' }} />
                  <ReferenceLine y={0} stroke="#6B7280" strokeWidth={2} />
                  {summary.breakEvenDay > 0 && (
                    <ReferenceLine x={summary.breakEvenDay} stroke="#10B981" strokeDasharray="3 3" label={{ position: 'top', value: 'BEP', fill: '#10B981', fontSize: 12 }} />
                  )}
                  <Line type="monotone" dataKey="MTM손익" stroke="#EF4444" strokeWidth={2} dot={false} name="평가손익(MTM)" />
                  <Line type="monotone" dataKey="누적캐리" stroke="#3B82F6" strokeWidth={2} dot={false} name="누적 이자수익(Carry)" />
                  <Line type="monotone" dataKey="총손익" stroke="#10B981" strokeWidth={4} dot={false} name="Total Return (합계)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
