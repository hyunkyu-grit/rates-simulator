import { PositionSummary } from '@/types/portfolio';

interface PortfolioSummaryProps {
  data: PositionSummary[];
}

function fmtAmt(won: number): string {
  const jo  = Math.floor(Math.abs(won) / 1_000_000_000_000);
  const eok = Math.floor((Math.abs(won) % 1_000_000_000_000) / 100_000_000);
  if (jo > 0) return `${jo}조 ${eok.toLocaleString()}억`;
  return `${eok.toLocaleString()}억`;
}

const SECTOR_COLORS: Record<string, string> = {
  '국고채': 'bg-blue-500', '통안채': 'bg-teal-500', '특은채': 'bg-purple-500',
  '시은채': 'bg-orange-500', '공사채': 'bg-red-500', '여전채': 'bg-pink-500', '회사채': 'bg-gray-500',
};
const SECTOR_ORDER = ['국고채', '통안채', '특은채', '시은채', '공사채', '여전채', '회사채'];

export default function PortfolioSummary({ data }: PortfolioSummaryProps) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-4 shadow-xl flex items-center justify-center h-full">
        <p className="text-gray-500 text-sm">포지션을 업로드하면 북별 요약이 표시됩니다</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-4 shadow-xl overflow-y-auto h-full">
      <h2 className="text-lg font-semibold text-blue-300 mb-3">북별 컴팩트 요약</h2>
      <div className="space-y-3">
        {data.map(summary => (
          <div key={summary.bookName} className="border border-gray-700 rounded-lg p-3">

            {/* 북 이름 */}
            <div className="text-sm font-bold text-white mb-2">{summary.bookName}</div>

            {/* 핵심 4개 지표 */}
            <div className="grid grid-cols-4 gap-1 mb-3 bg-gray-900/50 rounded-md p-2">
              <div className="text-center">
                <div className="text-[10px] text-gray-400 mb-0.5">채권 액면</div>
                <div className="text-xs font-bold text-blue-300">{fmtAmt(summary.totalNotional)}</div>
              </div>
              <div className="text-center border-l border-gray-700">
                <div className="text-[10px] text-gray-400 mb-0.5">채권평가</div>
                <div className="text-xs font-bold text-cyan-300">{fmtAmt(summary.totalEvaluationAmount)}</div>
              </div>
              <div className="text-center border-l border-gray-700">
                <div className="text-[10px] text-gray-400 mb-0.5">평균민평수익률</div>
                <div className="text-xs font-bold text-green-300">{summary.weightedAvgYTM.toFixed(3)}%</div>
              </div>
              <div className="text-center border-l border-gray-700">
                <div className="text-[10px] text-gray-400 mb-0.5">헷지 후 듀레이션</div>
                <div className={`text-xs font-bold ${summary.hedgedDuration >= 0 ? 'text-yellow-300' : 'text-red-300'}`}>
                  {summary.hedgedDuration.toFixed(2)}년
                </div>
              </div>
            </div>

            {/* 섹터 배분 바 */}
            <div className="mb-2">
              <div className="text-[10px] text-gray-400 mb-1">섹터 배분</div>
              <div className="flex h-3 rounded overflow-hidden">
                {SECTOR_ORDER.map(s =>
                  (summary.sectorAllocation[s] || 0) > 0 ? (
                    <div
                      key={s}
                      className={`${SECTOR_COLORS[s] || 'bg-gray-600'}`}
                      style={{ width: `${summary.sectorAllocation[s]}%` }}
                      title={`${s}: ${(summary.sectorAllocation[s] || 0).toFixed(1)}%`}
                    />
                  ) : null
                )}
              </div>
              <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1">
                {SECTOR_ORDER.filter(s => (summary.sectorAllocation[s] || 0) > 0).map(s => (
                  <span key={s} className="text-[10px] text-gray-400">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full mr-0.5 ${SECTOR_COLORS[s]}`} />
                    {s} {(summary.sectorAllocation[s] || 0).toFixed(1)}%
                  </span>
                ))}
              </div>
            </div>

            {/* 만기 배분 바 */}
            <div className="mb-3">
              <div className="text-[10px] text-gray-400 mb-1">만기 배분</div>
              <div className="flex h-3 rounded overflow-hidden">
                <div className="bg-purple-500" style={{ width: `${summary.maturityAllocation['단기(1년 미만)'] || 0}%` }} title={`단기: ${(summary.maturityAllocation['단기(1년 미만)'] || 0).toFixed(1)}%`} />
                <div className="bg-orange-500" style={{ width: `${summary.maturityAllocation['중기(1~3년)'] || 0}%` }} title={`중기: ${(summary.maturityAllocation['중기(1~3년)'] || 0).toFixed(1)}%`} />
                <div className="bg-red-500"    style={{ width: `${summary.maturityAllocation['장기(3년 이상)'] || 0}%` }} title={`장기: ${(summary.maturityAllocation['장기(3년 이상)'] || 0).toFixed(1)}%`} />
              </div>
              <div className="flex gap-x-2 mt-1">
                {[['단기(<1Y)', '단기(1년 미만)', 'text-purple-400'], ['중기(1~3Y)', '중기(1~3년)', 'text-orange-400'], ['장기(>3Y)', '장기(3년 이상)', 'text-red-400']].map(([label, key, cls]) => (
                  <span key={key} className={`text-[10px] ${cls}`}>{label} {(summary.maturityAllocation[key] || 0).toFixed(1)}%</span>
                ))}
              </div>
            </div>

            {/* Top3 / Bottom3 */}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <div className="text-[10px] text-blue-400 font-medium mb-1">▲ Top 3</div>
                <div className="space-y-0.5">
                  {summary.top3.map((pos: any) => (
                    <div key={pos.id} className="flex justify-between items-center">
                      <span className="text-[10px] text-gray-300 truncate max-w-[70%]">{pos.name}</span>
                      <span className="text-[10px] text-blue-400 font-medium">+{Math.round((pos.totalDailyPnL || 0) / 10000)}만</span>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-red-400 font-medium mb-1">▼ Bottom 3</div>
                <div className="space-y-0.5">
                  {summary.bottom3.map((pos: any) => (
                    <div key={pos.id} className="flex justify-between items-center">
                      <span className="text-[10px] text-gray-300 truncate max-w-[70%]">{pos.name}</span>
                      <span className="text-[10px] text-red-400 font-medium">{Math.round((pos.totalDailyPnL || 0) / 10000)}만</span>
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
