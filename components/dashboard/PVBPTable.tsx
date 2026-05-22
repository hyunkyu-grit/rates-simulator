import { PVBPSensitivity } from '@/types/portfolio';

interface PVBPTableProps {
  data: PVBPSensitivity[];
}

const formatPVBP = (pvbp: number) => Math.round(pvbp / 1000000).toLocaleString();

export default function PVBPTable({ data }: PVBPTableProps) {
  return (
    <div className="bg-gray-800 rounded-lg p-3 shadow-xl overflow-hidden h-full flex flex-col">
      <div className="flex justify-between items-center mb-2">
        <h2 className="text-sm font-semibold text-blue-300">PVBP 민감도 (단위: 백만)</h2>
        <span className="text-xs text-gray-400">1bp 변동</span>
      </div>
      <div className="overflow-x-auto flex-grow">
        <table className="w-full text-xs table-fixed border-collapse">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-1 px-2 text-gray-400 sticky left-0 bg-gray-800 border-r border-gray-700 w-max whitespace-nowrap text-xs">섹터</th>
              {['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '30Y', '합계'].map(tenor => (
                <th key={tenor} className={`text-center py-1 px-2 text-gray-400 whitespace-nowrap border-r font-bold text-xs ${tenor === '합계' ? 'bg-indigo-100 text-indigo-900 border-indigo-600' : 'border-gray-700'}`}>{tenor}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map(sector => {
              const isTotalRow = sector.sector === '합계';
              return (
                <tr key={sector.sector} className="border-b border-gray-700 hover:bg-gray-700 even:bg-gray-750/30">
                  <td className={`py-1 px-2 font-medium sticky left-0 border-r whitespace-nowrap text-xs ${isTotalRow ? 'bg-indigo-100 text-indigo-900 font-extrabold' : 'bg-gray-800'}`}>{sector.sector}</td>
                  {['1D', '3M', '6M', '9M', '1Y', '1.5Y', '2Y', '3Y', '4Y', '5Y', '7Y', '10Y', '30Y', '합계'].map(tenor => {
                    const value = Number(sector.tenors[tenor]) || 0;
                    const isTotalColumn = tenor === '합계';
                    const isGrandTotalCell = isTotalRow && isTotalColumn;
                    let bgClass = '', textClass = value > 0 ? 'text-green-400' : value < 0 ? 'text-red-400' : 'text-gray-500', fontClass = '';
                    if (isGrandTotalCell) { bgClass = 'bg-indigo-200'; textClass = 'text-indigo-900'; fontClass = 'font-extrabold text-sm'; }
                    else if (isTotalRow || isTotalColumn) { bgClass = 'bg-indigo-100'; textClass = 'text-indigo-900'; fontClass = 'font-extrabold text-sm'; }
                    return (
                      <td key={tenor} className={`py-1 px-2 text-right border-r whitespace-nowrap pr-3 ${bgClass} ${textClass} ${fontClass} ${isTotalColumn ? 'border-indigo-600' : 'border-gray-700'}`}>
                        {value !== 0 ? formatPVBP(value) : '-'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
