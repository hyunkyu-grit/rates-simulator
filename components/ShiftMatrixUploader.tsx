'use client';

import React, { useState } from 'react';
import * as XLSX from 'xlsx';

interface ShiftMatrixData {
  years: number;
  국채: number; // 국고채, 통안채
  은행채: number; // 특은채, 시은채
  카드채: number; // 여전채
  산금채: number; // 공사채
  회사채: number; // 회사채
  기타: number;
  [key: string]: number; // 인덱스 시그니처 추가
}

interface ShiftMatrixUploaderProps {
  onShiftMatrixLoaded: (shiftMatrix: ShiftMatrixData[]) => void;
}

const ShiftMatrixUploader: React.FC<ShiftMatrixUploaderProps> = ({ onShiftMatrixLoaded }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [error, setError] = useState<string>('');

  // Tenor 문자열 -> Years(연수) 변환 함수
  const parseTenorToYears = (tenorStr: string | number): number => {
    if (!tenorStr) return 0;
    const t = String(tenorStr).toUpperCase().trim();
    if (t.includes('D')) return Number(t.replace('D', '')) / 365;
    if (t.includes('M')) return Number(t.replace('M', '')) / 12;
    if (t.includes('Y')) return Number(t.replace('Y', ''));
    return 0;
  };

  const parseShiftMatrixFile = async (file: File) => {
    setIsLoading(true);
    setError('');
    setFileName(file.name);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      
      // 첫 번째 시트 읽기
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      
      // 2차원 배열 형태로 데이터 읽기 (header: 1 옵션)
      const rawData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      if (rawData.length < 2) {
        throw new Error('엑셀 파일에 데이터가 없습니다.');
      }

      // 두 번째 줄(index 1)부터 순회하며 데이터 매핑
      const shiftMatrix: ShiftMatrixData[] = [];
      
      for (let i = 1; i < rawData.length; i++) {
        const row = rawData[i] as any[];
        
        if (!row || row.length < 7) continue; // 데이터가 부족한 행은 건너뛰기
        
        const tenorStr = String(row[0] || '').trim();
        const years = parseTenorToYears(tenorStr);
        
        if (years === 0) continue; // 유효하지 않은 테너는 건너뛰기
        
        // row[0]: Tenor, row[1]: Base Rate (무시)
        const parsedRow = {
          years: parseTenorToYears(row[0]),
          국채: Number(row[2]) || 0,
          은행채: Number(row[3]) || 0,
          카드채: Number(row[4]) || 0,
          산금채: Number(row[5]) || 0,
          회사채: Number(row[6]) || 0,
        };
        
        shiftMatrix.push({
          years: parsedRow.years,
          국채: parsedRow.국채,
          은행채: parsedRow.은행채,
          카드채: parsedRow.카드채,
          산금채: parsedRow.산금채,
          회사채: parsedRow.회사채,
          기타: 0
        });
      }

      if (shiftMatrix.length === 0) {
        throw new Error('유효한 금리변동표 데이터가 없습니다.');
      }

      // years 기준으로 오름차순 정렬
      const sortedShiftMatrix = shiftMatrix.sort((a, b) => a.years - b.years);

      console.log('✅ 금리변동표 파싱 완료:', sortedShiftMatrix);
      console.log('📊 Parsed Shift Matrix:', sortedShiftMatrix); // 디버깅용
      onShiftMatrixLoaded(sortedShiftMatrix);
      
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
    }
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4 shadow-xl">
      <div className="flex items-center space-x-4">
        <div className="flex-1">
          <label className="block text-sm font-medium text-blue-300 mb-2">
            당일 금리변동표 업로드
          </label>
          <div className="flex items-center space-x-2">
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileUpload}
              className="hidden"
              id="shift-matrix-upload"
            />
            <label
              htmlFor="shift-matrix-upload"
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
        <p>• 엑셀 파일: 1열(Tenor), 3열(국고), 5열(통안), 7열(기타)</p>
        <p>• Tenor 형식: 1D, 3M, 1.5Y, 5Y 등</p>
      </div>
    </div>
  );
};

export default ShiftMatrixUploader;
