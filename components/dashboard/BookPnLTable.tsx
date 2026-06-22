import { BookDailyPnL } from '@/types/portfolio';

interface BookPnLTableProps {
  data: BookDailyPnL[];
}

const formatNumber = (num: number) => Math.round(num).toLocaleString();
const getPnLColor = (pnl: number) => pnl > 0 ? 'text-blue-600' : pnl < 0 ? 'text-red-600' : 'text-gray-400';

export default function BookPnLTable({ data }: BookPnLTableProps) {
  return (
    <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
      <div className="flex justify-between items-center mb-3">
        <h2 className="text-lg font-semibold text-blue-300">북별 당일 예상 손익</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-1 px-2 text-gray-400 whitespace-nowrap">북 이름</th>
              <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 이자수익</th>
              <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 조달비용</th>
              <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 평가손익</th>
              <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 스왑 평가손익</th>
              <th className="text-right py-1 px-2 text-gray-400 whitespace-nowrap">당일 스왑 세타손익</th>
              <th className="text-right py-1 px-2 text-gray-400 font-bold whitespace-nowrap">총 당일 예상손익</th>
            </tr>
          </thead>
          <tbody>
            {data.map(book => (
              <tr key={book.bookName} className="border-b border-gray-700 hover:bg-gray-700">
                <td className="py-1 px-2 font-medium whitespace-nowrap">{book.bookName}</td>
                <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.dailyCarry)}`}>{book.dailyCarry > 0 ? '+' : ''}{formatNumber(book.dailyCarry)}</td>
                <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.fundingCost)}`}>{book.fundingCost > 0 ? '+' : ''}{formatNumber(book.fundingCost)}</td>
                <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.bondValuation)}`}>{book.bondValuation > 0 ? '+' : ''}{formatNumber(book.bondValuation)}</td>
                <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.swapValuation)}`}>{book.swapValuation > 0 ? '+' : ''}{formatNumber(book.swapValuation)}</td>
                <td className={`py-1 px-2 text-right whitespace-nowrap ${getPnLColor(book.swapThetaPnL || 0)}`}>{(book.swapThetaPnL || 0) > 0 ? '+' : ''}{formatNumber(book.swapThetaPnL || 0)}</td>
                <td className={`py-1 px-2 text-right font-bold whitespace-nowrap ${getPnLColor(book.totalDailyPnL)}`}>{book.totalDailyPnL > 0 ? '+' : ''}{formatNumber(book.totalDailyPnL)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
