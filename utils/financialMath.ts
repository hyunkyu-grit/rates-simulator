// 금융 수학 유틸리티 - 기관 트레이딩 데스크용 프라이싱 엔진

// 지수 보간법 (Exponential Interpolation)
export function zzExp(x: number, ydata: number[][]): number {
  if (ydata.length < 2) {
    throw new Error("ydata must have at least 2 points for interpolation");
  }

  // x가 범위를 벗어나면 가장 가까운 점 사용
  if (x <= ydata[0][0]) {
    return ydata[0][1];
  }
  if (x >= ydata[ydata.length - 1][0]) {
    return ydata[ydata.length - 1][1];
  }

  // 적절한 구간 찾기
  for (let i = 0; i < ydata.length - 1; i++) {
    const x1 = ydata[i][0];
    const x2 = ydata[i + 1][0];
    const y1 = ydata[i][1];
    const y2 = ydata[i + 1][1];

    if (x >= x1 && x <= x2) {
      // 지수 보간: Ln(y2/y1)/(x2-x1) 형태의 기울기
      const slope = Math.log(y2 / y1) / (x2 - x1);
      return y1 * Math.exp(slope * (x - x1));
    }
  }

  throw new Error("Interpolation failed");
}

// 선형 보간법 (Linear Interpolation)
export function zzLin(x: number, ydata: number[][]): number {
  if (ydata.length < 2) {
    throw new Error("ydata must have at least 2 points for interpolation");
  }

  // x가 범위를 벗어나면 가장 가까운 점 사용
  if (x <= ydata[0][0]) {
    return ydata[0][1];
  }
  if (x >= ydata[ydata.length - 1][0]) {
    return ydata[ydata.length - 1][1];
  }

  // 적절한 구간 찾기
  for (let i = 0; i < ydata.length - 1; i++) {
    const x1 = ydata[i][0];
    const x2 = ydata[i + 1][0];
    const y1 = ydata[i][1];
    const y2 = ydata[i + 1][1];

    if (x >= x1 && x <= x2) {
      // 선형 보간
      const slope = (y2 - y1) / (x2 - x1);
      return y1 + slope * (x - x1);
    }
  }

  throw new Error("Interpolation failed");
}

// 3점 선형 보간법
export function zzlin3(x: number, ydata: number[][]): number {
  if (ydata.length < 3) {
    return zzLin(x, ydata);
  }

  // x가 범위를 벗어나면 가장 가까운 점 사용
  if (x <= ydata[0][0]) {
    return ydata[0][1];
  }
  if (x >= ydata[ydata.length - 1][0]) {
    return ydata[ydata.length - 1][1];
  }

  // 중간 구간에서 3점 보간
  for (let i = 1; i < ydata.length - 1; i++) {
    const x0 = ydata[i - 1][0];
    const x1 = ydata[i][0];
    const x2 = ydata[i + 1][0];
    const y0 = ydata[i - 1][1];
    const y1 = ydata[i][1];
    const y2 = ydata[i + 1][1];

    if (x >= x0 && x <= x2) {
      // 2차 보간 (Quadratic Interpolation)
      const h1 = x - x0;
      const h2 = x - x1;
      const h3 = x - x2;
      
      const L0 = h2 * h3 / ((x0 - x1) * (x0 - x2));
      const L1 = h1 * h3 / ((x1 - x0) * (x1 - x2));
      const L2 = h1 * h2 / ((x2 - x0) * (x2 - x1));
      
      return y0 * L0 + y1 * L1 + y2 * L2;
    }
  }

  return zzLin(x, ydata);
}

// 선도금리 계산 (Forward Rate)
export function forwardYTM(startDate: number, y: number[][], DF: number[], frequency: number): number {
  // 시작일에 해당하는 할인계수 찾기
  const dfStart = zzLin(startDate, y.map((point, i) => [point[0], DF[i]]));
  
  // 다음 지급일
  const nextDate = startDate + (365 / frequency);
  const dfEnd = zzLin(nextDate, y.map((point, i) => [point[0], DF[i]]));
  
  // 선도금리 = (DF_start/DF_end - 1) * frequency
  return (dfStart / dfEnd - 1) * frequency;
}

// Black-76 모델 관련 함수

// 표준정규분포 CDF
export function CND(x: number): number {
  const a1 = 0.31938153;
  const a2 = -0.356563782;
  const a3 = 1.781477937;
  const a4 = -1.821255978;
  const a5 = 1.330274429;
  
  const L = Math.abs(x);
  const K = 1 / (1 + 0.2316419 * L);
  const w = 1 - 1 / Math.sqrt(2 * Math.PI) * Math.exp(-L * L / 2) * 
    (a1 * K + a2 * K * K + a3 * K * K * K + a4 * K * K * K * K + a5 * K * K * K * K * K);
  
  return x < 0 ? 1 - w : w;
}

// 표준정규분포 PDF
export function ND(x: number): number {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-x * x / 2);
}

// Black-76 모델
export function Black(F: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  const d1 = (Math.log(F / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  
  if (isCall) {
    return F * CND(d1) - K * CND(d2);
  } else {
    return K * CND(-d2) - F * CND(-d1);
  }
}

// Delta 계산
export function Deltaa(F: number, K: number, T: number, r: number, sigma: number, isCall: boolean): number {
  const d1 = (Math.log(F / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return isCall ? CND(d1) : CND(d1) - 1;
}

// Gamma 계산
export function Gamma(F: number, K: number, T: number, r: number, sigma: number): number {
  const d1 = (Math.log(F / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return ND(d1) / (F * sigma * Math.sqrt(T));
}

// Vega 계산
export function Vega(F: number, K: number, T: number, r: number, sigma: number): number {
  const d1 = (Math.log(F / K) + (sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  return F * ND(d1) * Math.sqrt(T);
}

// Cap/Floorlet 프라이싱
export function Black_CapFloorlet(
  forwardRate: number, 
  strikeRate: number, 
  timeToExpiry: number, 
  timeToPayment: number, 
  volatility: number, 
  isCap: boolean,
  notional: number = 1000000,
  dayCountFraction: number = 0.25
): number {
  const F = forwardRate;
  const K = strikeRate;
  const T = timeToExpiry;
  const r = 0; // 선도금리 사용시 할인율은 0으로 가정
  
  const optionPrice = Black(F, K, T, r, volatility, isCap);
  
  // 할인계수 적용
  const discountFactor = Math.exp(-r * timeToPayment);
  
  // 명목금액 및 일수계산분 적용
  return optionPrice * notional * dayCountFraction * discountFactor;
}

// Key Rate Duration 계산
export interface KRDData {
  tenor: string;
  duration: number;
  exposure: number;
}

export function calculateKRD(
  cashflows: { date: number; amount: number }[],
  yieldCurve: number[][],
  shift: number = 0.0001 // 1bp shift
): KRDData[] {
  const tenors = ['1D', '1W', '1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y'];
  const results: KRDData[] = [];
  
  tenors.forEach(tenor => {
    // 해당 테너의 시점 찾기
    const targetDate = getTenorDate(tenor);
    
    // 기준 가격
    const basePrice = calculatePresentValue(cashflows, yieldCurve);
    
    // 1bp 시프트 후 가격
    const shiftedCurve = shiftYieldCurve(yieldCurve, targetDate, shift);
    const shiftedPrice = calculatePresentValue(cashflows, shiftedCurve);
    
    // KRD = -(shiftedPrice - basePrice) / shift
    const duration = -(shiftedPrice - basePrice) / shift;
    const exposure = duration * basePrice;
    
    results.push({
      tenor,
      duration,
      exposure
    });
  });
  
  return results;
}

// 테넌별 날짜 계산
function getTenorDate(tenor: string): number {
  const today = new Date();
  let result = new Date(today);
  
  switch (tenor) {
    case '1D': result.setDate(result.getDate() + 1); break;
    case '1W': result.setDate(result.getDate() + 7); break;
    case '1M': result.setMonth(result.getMonth() + 1); break;
    case '3M': result.setMonth(result.getMonth() + 3); break;
    case '6M': result.setMonth(result.getMonth() + 6); break;
    case '1Y': result.setFullYear(result.getFullYear() + 1); break;
    case '2Y': result.setFullYear(result.getFullYear() + 2); break;
    case '3Y': result.setFullYear(result.getFullYear() + 3); break;
    case '5Y': result.setFullYear(result.getFullYear() + 5); break;
    case '7Y': result.setFullYear(result.getFullYear() + 7); break;
    case '10Y': result.setFullYear(result.getFullYear() + 10); break;
  }
  
  return Math.floor((result.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

// 현재가치 계산
function calculatePresentValue(cashflows: { date: number; amount: number }[], yieldCurve: number[][]): number {
  return cashflows.reduce((sum, cf) => {
    const df = zzLin(cf.date, yieldCurve);
    return sum + cf.amount * df;
  }, 0);
}

// 금리 커브 시프트
function shiftYieldCurve(yieldCurve: number[][], targetDate: number, shift: number): number[][] {
  return yieldCurve.map(point => {
    const [date, rate] = point;
    // 타겟 날짜 주변의 점들만 시프트
    const distance = Math.abs(date - targetDate);
    const weight = Math.exp(-distance / 365); // 1년당 1/e 감쇠
    
    return [date, rate + shift * weight];
  });
}

// 포트폴리오 P&L 계산
export interface PortfolioPnL {
  scenario: string;
  pnl: number;
  krdImpact: number;
  curveImpact: number;
}

export function calculatePortfolioPnL(
  krdData: KRDData[],
  yieldCurve: number[][],
  scenarios: { name: string; shifts: { tenor: string; shift: number }[] }[]
): PortfolioPnL[] {
  return scenarios.map(scenario => {
    let totalKrdImpact = 0;
    let totalCurveImpact = 0;
    
    // KRD 기반 손익 계산
    scenario.shifts.forEach(shift => {
      const krd = krdData.find(k => k.tenor === shift.tenor);
      if (krd) {
        totalKrdImpact += krd.exposure * shift.shift;
      }
    });
    
    // 커브 시프트 기반 손익 계산 (단순화)
    totalCurveImpact = totalKrdImpact * 0.95; // KRD와 커브 시프트는 약간의 차이
    
    return {
      scenario: scenario.name,
      pnl: totalKrdImpact + totalCurveImpact,
      krdImpact: totalKrdImpact,
      curveImpact: totalCurveImpact
    };
  });
}
