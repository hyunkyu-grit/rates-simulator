export interface Position {
  id: string;
  name: string;
  book: string;
  bondType: 'swap' | 'bond';
  sector: '국고채' | '통안채' | '특은채' | '시은채' | '공사채' | '여전채' | '회사채' | 'IRS' | 'OIS';
  maturityDate?: string;
  couponRate: number;
  frequency: number;
  notional: number;
  entryYield: number;
  entryYieldPurchase: number;
  mtmYield?: number;
  expectedDeltaPnL?: number;
  expectedThetaPnL?: number;
  evaluationAmount: number;
  duration: number;
  pvbp: number;
  tenor: string;
  remainingDays: number;
  durationWeight: number;
  krdMap: { [tenor: string]: number };
  nextFixingDate?: Date;
  currentFloatRate?: number;
  totalDailyPnL?: number;
  direction: number;
}

export interface PVBPSensitivity {
  sector: string;
  tenors: { [key: string]: number };
  total: number;
}

export interface BookDailyPnL {
  bookName: string;
  dailyCarry: number;
  fundingCost: number;
  bondValuation: number;
  swapValuation: number;
  swapThetaPnL: number;
  totalDailyPnL: number;
}

export interface PositionSummary {
  bookName: string;
  instrumentName: string;
  assetType: string;
  direction: 'Long' | 'Short';
  notional: number;
  avgPrice: number;
  ytm: number;
  totalNotional: number;          // 채권 액면 합계
  totalEvaluationAmount: number;  // 채권평가 합계
  weightedAvgYTM: number;         // 평균민평수익률
  portfolioDuration: number;      // 채권 단순 듀레이션
  hedgedDuration: number;         // 헷지 후 듀레이션 (IRS 포함 순 PVBP 기준)
  sectorAllocation: { [key: string]: number };
  maturityAllocation: { [key: string]: number };
  top3: any[];
  bottom3: any[];
  totalDailyPnL: number;
  pvbp: number;
}

export interface ScenarioPnL {
  name: string;
  shiftBp: number;
  pnl: number;
}

export interface FundingEvent {
  date: string;
  shiftBp: number;
}

export interface ShockCurves {
  bondCurves: { [key: string]: { t: number, val: number }[] };
  swapCurve: { t: number, val: number }[];
  fundingEvents?: FundingEvent[];
}
