'use client';

import React, { useState, useId } from 'react';
import * as XLSX from 'xlsx';

interface FundingEvent {
  date: string;
  shiftBp: number;
}

interface ShockCurves {
  bondCurves: { [key: string]: { t: number, val: number }[] };
  swapCurve: { t: number, val: number }[];
  fundingEvents?: FundingEvent[];
}

interface ShiftMatrixUploaderProps {
  onShiftMatrixLoaded: (shockCurves: ShockCurves) => void;
  title?: string;
}

const ShiftMatrixUploader: React.FC<ShiftMatrixUploaderProps> = ({ onShiftMatrixLoaded, title }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const inputId = useId();

  // 테너(문자열)를 연 단위(숫자)로 변환하는 헬퍼 함수
  const parseTenorToYears = (tenor: string) => {
    const t = String(tenor).toUpperCase().replace('년', 'Y').replace('개월', 'M').replace('일', 'D').trim();
    if (t.includes('Y')) return parseFloat(t) || 0;
    if (t.includes('M')) return (parseFloat(t) || 0) / 12;
    if (t.includes('D')) return (parseFloat(t) || 0) / 365;
    return parseFloat(t) || 0;
  };

  // 채권 전용 다중 섹터 커브 파서
  const buildBondShockCurves = (sheetName: string | undefined, workbook: XLSX.WorkBook) => {
    if (!sheetName) return {};
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const curves: { [key: string]: { t: number, val: number }[] } = {};
    
    if (data.length === 0) return curves;
    const keys = Object.keys(data[0] as any);
    const tenorKey = keys.find(k => String(k).includes('연물') || String(k).includes('테너')) || keys[0];

    // '테너', '금리' 열을 제외한 모든 열을 크레딧 섹터로 인식하여 배열 초기화
    keys.forEach(k => {
      if (k !== tenorKey && !String(k).includes('금리') && !String(k).includes('Mid')) {
        curves[k] = [];
      }
    });

    // 데이터 채우기
    data.forEach((row: any) => {
      const t = parseTenorToYears(String(row[tenorKey] || ''));
      if (t <= 0) return;
      Object.keys(curves).forEach(sectorKey => {
        const val = Number(row[sectorKey]);
        if (!isNaN(val)) curves[sectorKey].push({ t, val });
      });
    });

    // 각 커브 t 기준으로 정렬
    Object.keys(curves).forEach(k => curves[k].sort((a, b) => a.t - b.t));
    return curves;
  };

  // 조달 변동표 파서: 엑셀 날짜 시리얼 넘버 또는 문자열 날짜 모두 처리
  const buildFundingEvents = (sheetName: string | undefined, workbook: XLSX.WorkBook): FundingEvent[] => {
    if (!sheetName) return [];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const events: FundingEvent[] = [];

    data.forEach((row: any) => {
      const keys = Object.keys(row);
      const dateKey = keys.find(k => String(k).includes('적용일자') || String(k).includes('날짜')) || keys[0];
      const bpKey = keys.find(k => String(k).includes('변동폭') || String(k).includes('bp')) || keys[1];
      if (!dateKey || !bpKey) return;

      const rawDate = row[dateKey];
      const shiftBp = Number(row[bpKey]);
      if (isNaN(shiftBp)) return;

      let dateStr = '';
      if (typeof rawDate === 'number') {
        // 엑셀 날짜 시리얼 넘버 → JS Date 변환 (엑셀 기준일: 1900-01-01 = 1)
        const excelEpoch = new Date(1900, 0, 1);
        const jsDate = new Date(excelEpoch.getTime() + (rawDate - 2) * 86400000);
        dateStr = jsDate.toISOString().slice(0, 10);
      } else {
        // 문자열 날짜: YYYY-MM-DD 또는 YYYY/MM/DD 포맷 정규화
        dateStr = String(rawDate).replace(/\//g, '-').trim().slice(0, 10);
      }

      if (dateStr && dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
        events.push({ date: dateStr, shiftBp });
      }
    });

    return events.sort((a, b) => a.date.localeCompare(b.date));
  };

  // 스왑용 단일 커브 파서
  const buildSwapShockCurve = (sheetName: string | undefined, workbook: XLSX.WorkBook) => {
    if (!sheetName) return [];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    const curve: { t: number, val: number }[] = [];
    
    data.forEach((row: any) => {
      const keys = Object.keys(row);
      if (keys.length === 0) return;
      
      const tenorKey = keys.find(k => String(k).includes('연물') || String(k).includes('테너')) || keys[0];
      let t_str = String(row[tenorKey] || '');
      
      const shockKey = keys.find(k => String(k).includes('전일비') || String(k).includes('bp'));
      if (!shockKey) return;
      const val = Number(row[shockKey]) || 0;
      
      const t = parseTenorToYears(t_str);
      if (t > 0 && !isNaN(val)) curve.push({ t, val });
    });
    return curve.sort((a, b) => a.t - b.t);
  };

  const parseShiftMatrixFile = async (file: File) => {
    setIsLoading(true);
    setError('');
    setFileName(file.name);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      
      // 변동표 파싱
      const bondShockSheet = workbook.SheetNames.find(n => n.includes('채권 변동표'));
      const swapShockSheet = workbook.SheetNames.find(n => n.includes('스왑 변동표'));

      const fundingEventsSheet = workbook.SheetNames.find(n => n.includes('조달 변동표'));

      const bondCurves = buildBondShockCurves(bondShockSheet, workbook);
      const swapCurve = buildSwapShockCurve(swapShockSheet, workbook);
      const fundingEvents = buildFundingEvents(fundingEventsSheet, workbook);

      onShiftMatrixLoaded({ bondCurves, swapCurve, fundingEvents });
      
    } catch (error) {
      console.error('금리변동표 파일 파싱 오류:', error);
      setError(error instanceof Error ? error.message : '파일 파싱 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
        parseShiftMatrixFile(file);
      } else {
        setError('엑셀 파일(.xlsx, .xls)만 업로드 가능합니다.');
      }
      event.target.value = '';
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
      <div className="flex items-center space-x-4">
        <div className="flex-1">
          <label className="block text-sm font-medium text-blue-300 mb-2">
            {title || '당일 금리변동표 업로드'}
          </label>
          <div className="flex items-center space-x-2">
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileUpload}
              className="hidden"
              id={inputId}
            />
            <label
              htmlFor={inputId}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 cursor-pointer transition-colors text-sm font-medium"
            >
              {isLoading ? '파싱 중...' : '파일 선택'}
            </label>
            {fileName && (
              <span className="text-sm text-gray-400">
                {fileName}
              </span>
            )}
          </div>
          {error && (
            <div className="mt-2 text-sm text-red-400">
              {error}
            </div>
          )}
        </div>
      </div>
      
      <div className="mt-3 text-xs text-gray-400">
        <p>• 채권 변동표: '연물' 열과 모든 섹터 열(국채, 은행채, 카드채 등)</p>
        <p>• 스왑 변동표: '연물' 열과 '전일비' 또는 'bp' 열</p>
      </div>
    </div>
  );
};

export default ShiftMatrixUploader;
