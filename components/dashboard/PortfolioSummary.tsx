import { PositionSummary } from '@/types/portfolio';

interface PortfolioSummaryProps {
  data: PositionSummary[];
}

export default function PortfolioSummary({ data }: PortfolioSummaryProps) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-lg font-semibold text-blue-300">북별 컴팩트 요약</h2>
      </div>
      <div className="space-y-3">
        {data.map(summary => (
          <div key={summary.bookName} className="border border-gray-700 rounded-lg p-3">
            <div className="grid grid-cols-3 gap-2 mb-3">
              <div className="text-center">
                <div className="text-xs text-gray-400">총 운용규모</div>
                <div className="text-sm font-bold text-blue-300">{(summary.totalEvaluationAmount / 100000000).toFixed(1)}억</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">평균 YTM</div>
                <div className="text-sm font-bold text-green-300">{summary.weightedAvgYTM.toFixed(2)}%</div>
              </div>
              <div className="text-center">
                <div className="text-xs text-gray-400">듀레이션</div>
                <div className="text-sm font-bold text-yellow-300">{summary.portfolioDuration.toFixed(2)}년</div>
              </div>
            </div>
            
            <div className="space-y-2 mb-3">
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-gray-400 w-16">섹터</span>
                  <div className="flex-1 flex h-4">
                    <div className="bg-blue-600" style={{ width: `${summary.sectorAllocation['국고채'] || 0}%` }} title={`국고채: ${(summary.sectorAllocation['국고채'] || 0).toFixed(1)}%`} />
                    <div className="bg-green-600" style={{ width: `${summary.sectorAllocation['통안채'] || 0}%` }} title={`통안채: ${(summary.sectorAllocation['통안채'] || 0).toFixed(1)}%`} />
                    <div className="bg-purple-600" style={{ width: `${summary.sectorAllocation['특은채'] || 0}%` }} title={`특은채: ${(summary.sectorAllocation['특은채'] || 0).toFixed(1)}%`} />
                    <div className="bg-orange-600" style={{ width: `${summary.sectorAllocation['시은채'] || 0}%` }} title={`시은채: ${(summary.sectorAllocation['시은채'] || 0).toFixed(1)}%`} />
                    <div className="bg-red-600" style={{ width: `${summary.sectorAllocation['공사채'] || 0}%` }} title={`공사채: ${(summary.sectorAllocation['공사채'] || 0).toFixed(1)}%`} />
                    <div className="bg-pink-600" style={{ width: `${summary.sectorAllocation['여전채'] || 0}%` }} title={`여전채: ${(summary.sectorAllocation['여전채'] || 0).toFixed(1)}%`} />
                    <div className="bg-gray-600" style={{ width: `${summary.sectorAllocation['회사채'] || 0}%` }} title={`회사채: ${(summary.sectorAllocation['회사채'] || 0).toFixed(1)}%`} />
                  </div>
                </div>
                <div className="flex items-center space-x-2 ml-20">
                  <span className="text-xs text-gray-300">
                    국고채 {(summary.sectorAllocation['국고채'] || 0).toFixed(1)}% | 통안채 {(summary.sectorAllocation['통안채'] || 0).toFixed(1)}% | 특은채 {(summary.sectorAllocation['특은채'] || 0).toFixed(1)}% | 시은채 {(summary.sectorAllocation['시은채'] || 0).toFixed(1)}% | 공사채 {(summary.sectorAllocation['공사채'] || 0).toFixed(1)}% | 여전채 {(summary.sectorAllocation['여전채'] || 0).toFixed(1)}% | 회사채 {(summary.sectorAllocation['회사채'] || 0).toFixed(1)}%
                  </span>
                </div>
              </div>
              <div className="space-y-1">
                <div className="flex items-center space-x-2">
                  <span className="text-xs text-gray-400 w-16">만기</span>
                  <div className="flex-1 flex h-4">
                    <div className="bg-purple-600" style={{ width: `${summary.maturityAllocation['단기(1년 미만)'] || 0}%` }} title={`단기: ${(summary.maturityAllocation['단기(1년 미만)'] || 0).toFixed(1)}%`} />
                    <div className="bg-orange-600" style={{ width: `${summary.maturityAllocation['중기(1~3년)'] || 0}%` }} title={`중기: ${(summary.maturityAllocation['중기(1~3년)'] || 0).toFixed(1)}%`} />
                    <div className="bg-red-600" style={{ width: `${summary.maturityAllocation['장기(3년 이상)'] || 0}%` }} title={`장기: ${(summary.maturityAllocation['장기(3년 이상)'] || 0).toFixed(1)}%`} />
                  </div>
                </div>
                <div className="flex items-center space-x-2 ml-20">
                  <span className="text-xs text-gray-300">
                    단기(&lt;1년) {(summary.maturityAllocation['단기(1년 미만)'] || 0).toFixed(1)}% | 중기(1~3년) {(summary.maturityAllocation['중기(1~3년)'] || 0).toFixed(1)}% | 장기(&gt;3년) {(summary.maturityAllocation['장기(3년 이상)'] || 0).toFixed(1)}%
                  </span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-blue-400 font-medium mb-1">Top 3 수익</div>
                <div className="space-y-1">
                  {summary.top3.map(pos => (
                    <div key={pos.id} className="flex justify-between items-center">
                      <span className="text-xs text-gray-300 truncate">{pos.name.length > 15 ? pos.name.substring(0, 15) + '...' : pos.name}</span>
                      <span className="text-xs text-blue-400 font-medium">+{Math.round(pos.totalDailyPnL / 10000)}만</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-xs text-red-400 font-medium mb-1">Bottom 3 손실</div>
                <div className="space-y-1">
                  {summary.bottom3.map(pos => (
                    <div key={pos.id} className="flex justify-between items-center">
                      <span className="text-xs text-gray-300 truncate">{pos.name.length > 15 ? pos.name.substring(0, 15) + '...' : pos.name}</span>
                      <span className="text-xs text-red-400 font-medium">{Math.round(pos.totalDailyPnL / 10000)}만</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
