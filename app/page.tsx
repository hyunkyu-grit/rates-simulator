"use client";

import { useState, useEffect } from "react";
import Navigation from "@/components/Navigation";
import ExcelUploader from "@/components/ExcelUploader";
import ShiftMatrixUploader from "@/components/ShiftMatrixUploader";
import ScenarioSimulator from "@/components/ScenarioSimulator";
import { usePortfolioMetrics } from "@/hooks/usePortfolioMetrics";
import { Position, ShockCurves } from "@/types/portfolio";
import PVBPTable from "@/components/dashboard/PVBPTable";
import BookPnLTable from "@/components/dashboard/BookPnLTable";
import PortfolioSummary from "@/components/dashboard/PortfolioSummary";

export default function PortfolioDashboard() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [baseDate, setBaseDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [fundingRate, setFundingRate] = useState<number>(0.0420);
  const [fundingRateInput, setFundingRateInput] = useState<string>('');
  const [dailyShockCurves, setDailyShockCurves] = useState<ShockCurves>({ bondCurves: {}, swapCurve: [] });
  const [scenarioShockCurves, setScenarioShockCurves] = useState<ShockCurves>({ bondCurves: {}, swapCurve: [] });
  const [activeTab, setActiveTab] = useState<'dashboard' | 'scenario'>('dashboard');
  const [irsParRates, setIrsParRates] = useState<{ t: number; rate: number }[]>([]);

  const { pvbpSensitivity, bookDailyPnLs, positionSummaries, calculateScenarioPnL, setMetrics } = usePortfolioMetrics(positions, dailyShockCurves, fundingRate, baseDate, irsParRates);

  useEffect(() => {
    const savedRate = localStorage.getItem('dashboardFundingRate');
    if (savedRate && !isNaN(parseFloat(savedRate))) setFundingRate(parseFloat(savedRate));
  }, []);

  useEffect(() => {
    localStorage.setItem('dashboardFundingRate', fundingRate.toString());
  }, [fundingRate]);

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
            <ExcelUploader baseDate={baseDate} onDataLoaded={setPositions} onParRatesLoaded={setIrsParRates} />
          </div>
        </div>
      </div>
    );
  } else {
    mainContent = (
      <div className="w-full flex flex-col h-full">
        <div style={{ display: activeTab === 'dashboard' ? 'block' : 'none' }} className="w-full">
          <div className="mb-4 grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ExcelUploader baseDate={baseDate} onDataLoaded={setPositions} onParRatesLoaded={setIrsParRates} />
            <ShiftMatrixUploader onShiftMatrixLoaded={setDailyShockCurves} title="당일 실제 금리변동표 업로드" />
          </div>

          <div className="grid grid-cols-1 gap-4">
            <PVBPTable data={pvbpSensitivity} />

            <div className="grid grid-cols-2 gap-4 h-[calc(100vh-350px)]">
              <BookPnLTable data={bookDailyPnLs} />
              <PortfolioSummary data={positionSummaries} />
            </div>
          </div>
        </div>

        <div style={{ display: activeTab === 'scenario' ? 'block' : 'none' }} className="w-full h-[calc(100vh-120px)]">
          <div className="mb-4">
            <ShiftMatrixUploader onShiftMatrixLoaded={setScenarioShockCurves} title="시나리오 가상 금리변동표 업로드" />
          </div>
          <ScenarioSimulator
            positions={positions}
            baseDate={baseDate}
            fundingRate={fundingRate}
            shockCurves={scenarioShockCurves}
            dailyShockCurves={dailyShockCurves}
            irsParRates={irsParRates}
            onMetricsUpdate={setMetrics}
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
            <div className="flex items-center space-x-4">
              <div className="flex items-center space-x-2">
                <label className="text-sm text-gray-400">기준일자:</label>
                <input type="date" value={baseDate} onChange={(e) => setBaseDate(e.target.value)} className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm text-gray-300" />
              </div>
              <div className="flex items-center space-x-2">
                <label className="text-sm text-gray-400">조달 금리:</label>
                <input
                  type="number"
                  value={fundingRateInput !== '' ? fundingRateInput : (fundingRate * 100).toFixed(2)}
                  onChange={(e) => setFundingRateInput(e.target.value)}
                  onBlur={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) setFundingRate(v / 100);
                    setFundingRateInput('');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  }}
                  className="w-20 px-2 py-1 bg-gray-800 border border-gray-700 rounded text-sm"
                  step="0.01"
                />
                <span className="text-sm text-gray-400">%</span>
              </div>
            </div>
          </div>
          <div className="flex space-x-1 bg-gray-800 p-1 rounded-lg">
            <button onClick={() => setActiveTab('dashboard')} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'dashboard' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>포트폴리오 관리</button>
            <button onClick={() => setActiveTab('scenario')} className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${activeTab === 'scenario' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}>시나리오 P&L 예측</button>
          </div>
        </div>
        {mainContent}
      </div>
    </div>
  );
}
