'use client';

import { useState, useEffect } from 'react';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import {
  differenceInDays,
  differenceInYears,
  parseISO,
  format,
  addMonths,
  isAfter,
  isBefore
} from 'date-fns';
import Navigation from '../components/Navigation';

// 환경변수가 없으면 null — Vercel 배포 시 Supabase 없이도 빌드 통과
const _supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const _supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabase: SupabaseClient | null =
  _supabaseUrl && _supabaseKey ? createClient(_supabaseUrl, _supabaseKey) : null;

interface BondCalculationRecord {
  id: number;
  issue_date: string;
  maturity_date: string;
  settlement_date: string;
  coupon_rate: number;
  payment_frequency: number;
  ytm: number;
  calculated_price: number;
  bond_type: string;
  timestamp: string;
}

export default function BondPriceCalculator() {
  const [issueDate, setIssueDate] = useState<string>('');
  const [maturityDate, setMaturityDate] = useState<string>('');
  const [settlementDate, setSettlementDate] = useState<string>('');
  const [couponRate, setCouponRate] = useState<string>('');
  const [paymentFrequency, setPaymentFrequency] = useState<string>('2');
  const [ytm, setYtm] = useState<string>('');
  const [bondType, setBondType] = useState<string>('coupon'); // coupon, discount, frn
  const [baseRate, setBaseRate] = useState<string>('');
  const [spread, setSpread] = useState<string>('');
  const [calculatedPrice, setCalculatedPrice] = useState<number | null>(null);
  const [calculationHistory, setCalculationHistory] = useState<BondCalculationRecord[]>([]);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [apiMessage, setApiMessage] = useState<string | null>(null);
  const [apiLoading, setApiLoading] = useState(false);

  const testBackendApi = async () => {
    setApiLoading(true);
    setApiMessage(null);
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/api/hello`);
      const data = await res.json();
      setApiMessage(data.message);
    } catch {
      setApiMessage('연결 실패: 백엔드 서버를 확인해주세요.');
    } finally {
      setApiLoading(false);
    }
  };

  // 페이지 로드시 데이터베이스에서 과거 계산 기록 불러오기
  useEffect(() => {
    fetchCalculationHistory();
  }, []);

  const fetchCalculationHistory = async () => {
    if (!supabase) { setCalculationHistory([]); return; }
    try {
      console.log("데이터 조회 시작...");
      const { data, error } = await supabase
        .from('bond_price_history')
        .select('*')
        .order('created_at', { ascending: false });

      console.log("Supabase 응답:", { data, error });

      if (error) {
        console.error("Supabase 에러 원인:", error.message || error.code || JSON.stringify(error));
        alert(`데이터 조회 오류: ${error.message || error.code || JSON.stringify(error)}`);
        return;
      }

      // 빈 데이터 안전 처리
      if (!data || data.length === 0) {
        console.log("데이터가 없습니다. 빈 배열로 설정합니다.");
        setCalculationHistory([]);
        return;
      }

      // 데이터 형식 변환
      const formattedData: BondCalculationRecord[] = data.map(record => ({
        id: record.id,
        issue_date: record.issue_date,
        maturity_date: record.maturity_date,
        settlement_date: record.settlement_date,
        coupon_rate: record.coupon_rate,
        payment_frequency: record.payment_frequency,
        ytm: record.ytm,
        calculated_price: record.calculated_price,
        bond_type: record.bond_type || 'coupon',
        timestamp: new Date(record.created_at).toLocaleString('ko-KR')
      }));

      setCalculationHistory(formattedData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      console.error("Supabase 에러 원인:", errorMessage);
      alert(`데이터 불러오기 실패: ${errorMessage}`);
    }
  };

  const calculateBondPrice = async () => {
    const faceValue = 10000;
    const ytmRate = parseFloat(ytm);

    // 기본 유효성 검사
    if (!issueDate || !maturityDate || !settlementDate || isNaN(ytmRate)) {
      alert('모든 값을 올바르게 입력해주세요.');
      return;
    }

    // 채권 종류별 유효성 검사
    if (bondType === 'coupon' && (!couponRate || !paymentFrequency)) {
      alert('이표채는 쿠폰금리와 이자지급주기를 입력해주세요.');
      return;
    }

    if (bondType === 'frn' && (!baseRate || !spread)) {
      alert('FRN은 기준금리와 가산금리를 입력해주세요.');
      return;
    }

    try {
      // 날짜 파싱
      const issue = parseISO(issueDate);
      const maturity = parseISO(maturityDate);
      const settlement = parseISO(settlementDate);

      let finalPrice = 0;

      // 채권 종류별 계산 분기
      if (bondType === 'coupon') {
        // 이표채 계산 (기존 로직 유지)
        const coupon = parseFloat(couponRate);
        const frequency = parseInt(paymentFrequency);
        const couponDecimal = coupon / 100;
        const ytmDecimal = ytmRate / 100;
        const periodicCoupon = (faceValue * couponDecimal) / frequency;
        const periodicYTM = ytmDecimal / frequency;

      // 이표일 정확히 계산
        const getCouponDates = (fromDate: Date, toDate: Date) => {
          const dates = [];
          const monthsPerPeriod = 12 / frequency;
          let currentDate = new Date(fromDate);
          
          // 첫 이표일부터 시작
          currentDate = addMonths(currentDate, monthsPerPeriod);
          
          while (isBefore(currentDate, toDate) || currentDate.getTime() === toDate.getTime()) {
            dates.push(new Date(currentDate));
            currentDate = addMonths(currentDate, monthsPerPeriod);
          }
          
          return dates;
        };

        // 모든 이표일 계산
        const allCouponDates = getCouponDates(issue, maturity);
        
        // 직전 이표일과 다음 이표일 찾기
        let prevCouponDate: Date | null = null;
        let nextCouponDate: Date | null = null;
        let remainingCoupons: Date[] = [];
        
        for (let i = 0; i < allCouponDates.length; i++) {
          const couponDate = allCouponDates[i];
          if (isBefore(couponDate, settlement)) {
            prevCouponDate = couponDate;
          } else {
            nextCouponDate = couponDate;
            remainingCoupons = allCouponDates.slice(i);
            break;
          }
        }

        // 날짜 및 일수 계산 (Actual/Actual)
        const E = differenceInDays(nextCouponDate!, prevCouponDate!); // 직전 이표일부터 다음 이표일까지 총 일수
        const DSC = differenceInDays(nextCouponDate!, settlement); // 결제일부터 다음 이표일까지 잔여 일수
        
        // 기본 세팅
        const r = ytmDecimal / frequency; // 예: 0.0334 / 4 = 0.00835
        const couponPayment = faceValue * (couponDecimal / frequency);
        
        // 핵심 할인 로직 (제공된 공식)
        let dirtyPrice = 0;
        for (let i = 0; i < remainingCoupons.length; i++) {
          const couponDate = remainingCoupons[i];
          
          // 현금흐름 계산
          let CF;
          if (couponDate.getTime() === maturity.getTime()) {
            // 만기 회차: 원금 + 이자
            CF = faceValue + couponPayment;
          } else {
            // 일반 회차: 이자만
            CF = couponPayment;
          }
          
          // [중요 공식] 현재가치 = CF / ((1 + r * (DSC / E)) * Math.pow(1 + r, i))
          const presentValue = CF / (((1 + r * (DSC / E)) * Math.pow(1 + r, i)));
          dirtyPrice += presentValue;
        }
        
        finalPrice = dirtyPrice;

      } else if (bondType === 'discount') {
        // 할인채 계산 (단리 할인)
        const r = ytmRate / 100; // 예: 3.088% -> 0.03088
        const d = differenceInDays(maturity, settlement); // 결제일부터 만기일까지 잔여 일수
        
        // [수정할 단리 공식] Price = 10000 / (1 + (r * (d / 365)))
        finalPrice = faceValue / (1 + (r * (d / 365)));

      } else if (bondType === 'frn') {
        // FRN 계산
        const baseRateDecimal = parseFloat(baseRate) / 100;
        const spreadBp = parseFloat(spread) / 10000; // bp를 소수점으로 변환
        const frequency = 4; // FRN은 보통 분기별
        const currentRate = baseRateDecimal + spreadBp;
        
        // 다음 이표일까지의 이자 계산
        const nextCouponDate = addMonths(settlement, 3); // 분기별 가정
        const daysToNextCoupon = differenceInDays(nextCouponDate, settlement);
        const daysInQuarter = 91; // 평균 분기일수
        const accruedInterest = (faceValue * currentRate / frequency) * (daysToNextCoupon / daysInQuarter);
        
        // 미래 현금흐름 할인 (현재 금리가 유지된다고 가정)
        const periodsToMaturity = Math.floor(differenceInDays(maturity, settlement) / 91);
        let dirtyPrice = 0;
        
        for (let i = 0; i < periodsToMaturity; i++) {
          const couponPayment = faceValue * currentRate / frequency;
          const discountFactor = Math.pow(1 + currentRate / frequency, i + 1);
          
          if (i === periodsToMaturity - 1) {
            // 만기 회차
            dirtyPrice += (faceValue + couponPayment) / discountFactor;
          } else {
            // 일반 회차
            dirtyPrice += couponPayment / discountFactor;
          }
        }
        
        finalPrice = dirtyPrice + accruedInterest;
      }

      console.log("채권 단가 계산 상세:", {
        bondType,
        input: {
          settlement: format(settlement, 'yyyy-MM-dd'),
          maturity: format(maturity, 'yyyy-MM-dd'),
          ytm: ytmRate,
          faceValue: faceValue,
          ...(bondType === 'coupon' && { 
            coupon: parseFloat(couponRate),
            frequency: parseInt(paymentFrequency)
          }),
          ...(bondType === 'frn' && { 
            baseRate: parseFloat(baseRate),
            spread: parseFloat(spread)
          })
        },
        result: {
          finalPrice,
          testCondition: {
            expected: bondType === 'coupon' ? "9937.33" : "계산 필요",
            actual: finalPrice.toFixed(2),
            difference: bondType === 'coupon' ? (finalPrice - 9937.33).toFixed(2) : "N/A"
          }
        }
      });

      setCalculatedPrice(finalPrice);

      // 데이터베이스에 저장
      const insertData = {
        issue_date: issueDate,
        maturity_date: maturityDate,
        settlement_date: settlementDate,
        coupon_rate: bondType === 'coupon' ? parseFloat(couponRate) : 0,
        payment_frequency: bondType === 'coupon' ? parseInt(paymentFrequency) : 0,
        ytm: parseFloat(ytm),
        calculated_price: finalPrice,
        bond_type: bondType
      };
      
      console.log("DB에 넣을 데이터:", insertData);
      console.log("데이터 타입 확인:", {
        issue_date: typeof issueDate,
        maturity_date: typeof maturityDate,
        settlement_date: typeof settlementDate,
        coupon_rate: typeof (bondType === 'coupon' ? parseFloat(couponRate) : 0),
        payment_frequency: typeof (bondType === 'coupon' ? parseInt(paymentFrequency) : 0),
        ytm: typeof parseFloat(ytm),
        calculated_price: typeof finalPrice,
        bond_type: typeof bondType
      });

      if (supabase) {
        const { data, error } = await supabase
          .from('bond_price_history')
          .insert([insertData])
          .select();

        if (error) {
          console.error("저장 에러 상세:", error.message, error.details, error.hint, error);
          alert(`데이터 저장 오류: ${error.message || JSON.stringify(error)}`);
          return;
        }

        // 저장 성공 후 데이터 다시 불러오기
        await fetchCalculationHistory();
      }
      
    } catch (error) {
      console.error('계산 실패:', error);
      alert('계산 중 오류가 발생했습니다.');
    }
  };

  const deleteRecord = async (id: number) => {
    setDeletingId(id);

    try {
      if (supabase) {
        const { error } = await supabase
          .from('bond_price_history')
          .delete()
          .eq('id', id);

        if (error) {
          console.error('데이터 삭제 오류:', error);
          alert('데이터 삭제에 실패했습니다.');
          setDeletingId(null);
          return;
        }
      }

      // 삭제 성공(또는 Supabase 미설정) 시 상태에서 제거
      setCalculationHistory(prev => prev.filter(record => record.id !== id));

    } catch (error) {
      console.error('삭제 실패:', error);
      alert('데이터 삭제 중 오류가 발생했습니다.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <Navigation />
      
      <div className="p-6">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-3xl font-bold mb-8 text-center">채권 단가 계산기</h1>

          {/* 백엔드 연동 테스트 */}
          <div className="flex items-center gap-4 mb-8 p-4 bg-gray-800 rounded-lg border border-gray-700">
            <button
              onClick={testBackendApi}
              disabled={apiLoading}
              className="px-5 py-2 bg-emerald-600 hover:bg-emerald-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors duration-200"
            >
              {apiLoading ? '요청 중...' : '백엔드 연동 테스트'}
            </button>
            {apiMessage && (
              <span className={`text-sm font-medium ${
                apiMessage.startsWith('연결 실패') ? 'text-red-400' : 'text-emerald-400'
              }`}>
                응답: {apiMessage}
              </span>
            )}
          </div>
        
        {/* 채권 종류 선택 탭 */}
        <div className="mb-6">
          <div className="flex space-x-1 bg-gray-800 p-1 rounded-lg">
            <button
              onClick={() => setBondType('coupon')}
              className={`flex-1 py-2 px-4 rounded-md transition-colors duration-200 ${
                bondType === 'coupon' 
                  ? 'bg-blue-600 text-white' 
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              이표채
            </button>
            <button
              onClick={() => setBondType('discount')}
              className={`flex-1 py-2 px-4 rounded-md transition-colors duration-200 ${
                bondType === 'discount' 
                  ? 'bg-blue-600 text-white' 
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              할인채
            </button>
            <button
              onClick={() => setBondType('frn')}
              className={`flex-1 py-2 px-4 rounded-md transition-colors duration-200 ${
                bondType === 'frn' 
                  ? 'bg-blue-600 text-white' 
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
            >
              FRN
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {/* 왼쪽 패널 - 입력부 */}
          <div className="bg-gray-800 rounded-lg p-6 shadow-xl">
            <h2 className="text-xl font-semibold mb-6 text-blue-300">계산 입력</h2>
            
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  발행일 (Issue Date)
                </label>
                <input
                  type="date"
                  value={issueDate}
                  onChange={(e) => setIssueDate(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  만기일 (Maturity Date)
                </label>
                <input
                  type="date"
                  value={maturityDate}
                  onChange={(e) => setMaturityDate(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  결제일 (Settlement Date)
                </label>
                <input
                  type="date"
                  value={settlementDate}
                  onChange={(e) => setSettlementDate(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                />
              </div>

              {/* 이표채 전용 입력 */}
              {bondType === 'coupon' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      쿠폰금리 (Coupon Rate, %)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={couponRate}
                      onChange={(e) => setCouponRate(e.target.value)}
                      className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                      placeholder="예: 3.5"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      이자지급주기 (Payment Frequency)
                    </label>
                    <select
                      value={paymentFrequency}
                      onChange={(e) => setPaymentFrequency(e.target.value)}
                      className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                    >
                      <option value="1">연1회</option>
                      <option value="2">연2회</option>
                      <option value="4">연4회</option>
                      <option value="12">연12회</option>
                    </select>
                  </div>
                </>
              )}

              {/* FRN 전용 입력 */}
              {bondType === 'frn' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      현재 기준금리 (Base Rate, %)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={baseRate}
                      onChange={(e) => setBaseRate(e.target.value)}
                      className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                      placeholder="예: 3.0"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      가산금리 (Spread, bp)
                    </label>
                    <input
                      type="number"
                      step="1"
                      value={spread}
                      onChange={(e) => setSpread(e.target.value)}
                      className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                      placeholder="예: 50"
                    />
                  </div>
                </>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  만기수익률 (YTM, %)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={ytm}
                  onChange={(e) => setYtm(e.target.value)}
                  className="w-full px-4 py-2 bg-gray-700 border border-gray-600 rounded-lg text-gray-100 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
                  placeholder="예: 4.2"
                />
              </div>

              <div className="text-sm text-gray-400 mt-4">
                <p>* 액면가: 10,000원 기준</p>
              </div>

              <button
                onClick={calculateBondPrice}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-3 px-6 rounded-lg transition duration-200 ease-in-out transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
              >
                채권 단가 계산하기
              </button>
            </div>
          </div>

          {/* 오른쪽 패널 - 결과부 */}
          <div className="bg-gray-800 rounded-lg p-6 shadow-xl">
            <h2 className="text-xl font-semibold mb-6 text-blue-300">계산 결과</h2>
            
            {/* 채권 단가 결과값 */}
            <div className="bg-gray-900 rounded-lg p-6 mb-6 text-center">
              <p className="text-sm text-gray-400 mb-2">채권 단가 (Bond Price)</p>
              {calculatedPrice !== null ? (
                <div className="text-5xl font-bold text-green-400">
                  {calculatedPrice.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원
                </div>
              ) : (
                <div className="text-3xl font-bold text-gray-500">
                  --원
                </div>
              )}
            </div>

            {/* 계산 기록 테이블 */}
            <div>
              <h3 className="text-lg font-medium mb-4 text-gray-300">계산 기록</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-700">
                      <th className="text-left py-2 px-2 text-gray-400">채권종류</th>
                      <th className="text-left py-2 px-2 text-gray-400">쿠폰금리</th>
                      <th className="text-left py-2 px-2 text-gray-400">지급주기</th>
                      <th className="text-left py-2 px-2 text-gray-400">YTM</th>
                      <th className="text-left py-2 px-2 text-gray-400">계산단가</th>
                      <th className="text-left py-2 px-2 text-gray-400">시간</th>
                      <th className="text-center py-2 px-2 text-gray-400">삭제</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calculationHistory.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="text-center py-4 text-gray-500">
                          계산 기록이 없습니다
                        </td>
                      </tr>
                    ) : (
                      calculationHistory.map((record) => (
                        <tr key={record.id} className="border-b border-gray-700 hover:bg-gray-700">
                          <td className="py-2 px-2">
                            {record.bond_type === 'coupon' ? '이표채' : 
                             record.bond_type === 'discount' ? '할인채' : 'FRN'}
                          </td>
                          <td className="py-2 px-2">{record.coupon_rate}%</td>
                          <td className="py-2 px-2">
                            {record.payment_frequency === 1 ? '연1회' : 
                             record.payment_frequency === 2 ? '연2회' : 
                             record.payment_frequency === 4 ? '연4회' : '연12회'}
                          </td>
                          <td className="py-2 px-2">{record.ytm}%</td>
                          <td className="py-2 px-2 font-semibold text-green-400">
                            {record.calculated_price.toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원
                          </td>
                          <td className="py-2 px-2 text-gray-400 text-xs">
                            {record.timestamp}
                          </td>
                          <td className="py-2 px-2 text-center">
                            <button
                              onClick={() => deleteRecord(record.id)}
                              disabled={deletingId === record.id}
                              className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white text-xs rounded transition-colors duration-200"
                            >
                              {deletingId === record.id ? '삭제 중...' : '삭제'}
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  );
}
