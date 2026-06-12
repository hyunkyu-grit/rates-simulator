import { parseISO, isBefore, isSameDay } from 'date-fns';
import type { Position, FundingEvent, ShockCurves } from '@/types/portfolio';

export type CurvePoint = { t: number; val: number };

// ─── 섹터명 → 커브 키 매핑 ────────────────────────────────────────
export function getSectorCurveKey(sector: string): string {
  const s = sector || '';
  if (s.includes('국고') || s.includes('통안') || s.includes('국채')) return '국채';
  if (s.includes('시은') || s.includes('은행')) return '은행채';
  if (s.includes('특은') || s.includes('공사')) return '특은채';
  if (s.includes('여전') || s.includes('카드')) return '카드채';
  if (s.includes('회사')) return '회사채';
  if (s.includes('IRS') || s.includes('OIS') || s.includes('swap')) return 'swap';
  return '국채';
}

// ─── 선형 보간: 임의 연물(years)의 충격 bp 추출 ──────────────────
export function interpolateCurveShift(years: number, curve: CurvePoint[]): number {
  if (!curve || !Array.isArray(curve) || curve.length === 0) return 0;

  const normalizedCurve = curve
    .map((item: any) => ({
      t: item.t !== undefined ? Number(item.t) : Number(item.tenor || 0),
      val: item.val !== undefined ? Number(item.val) : Number(item.value || 0),
    }))
    .filter(item => !isNaN(item.t) && !isNaN(item.val) && item.t >= 0)
    .sort((a, b) => a.t - b.t);

  if (normalizedCurve.length === 0) return 0;

  const exactMatch = normalizedCurve.find(item => item.t === years);
  if (exactMatch) return exactMatch.val;

  let lowerT = -1, upperT = -1, lowerVal = 0, upperVal = 0;
  for (let i = 0; i < normalizedCurve.length; i++) {
    if (normalizedCurve[i].t <= years) {
      lowerT = normalizedCurve[i].t;
      lowerVal = normalizedCurve[i].val;
    } else {
      upperT = normalizedCurve[i].t;
      upperVal = normalizedCurve[i].val;
      break;
    }
  }

  if (lowerT === -1) return upperVal;
  if (upperT === -1) return lowerVal;
  if (upperT === lowerT) return lowerVal;

  const ratio = (years - lowerT) / (upperT - lowerT);
  const result = lowerVal + (upperVal - lowerVal) * ratio;
  return isNaN(result) || !isFinite(result) ? 0 : result;
}

// ─── 이벤트 드리븐 동적 조달 금리 계산 ──────────────────────────
export function calculateDynamicFundingRate(
  baseFundingRate: number,
  fundingEvents: FundingEvent[],
  currentSimDate: Date
): number {
  return fundingEvents.reduce((acc, ev) => {
    const evDate = parseISO(ev.date);
    if (isBefore(evDate, currentSimDate) || isSameDay(evDate, currentSimDate)) {
      return acc + ev.shiftBp / 10000;
    }
    return acc;
  }, Number(baseFundingRate) || 0);
}

// ─── (내부) 포지션별 충격 bp 계산 ──────────────────────────────
function getPositionShockBp(
  p: Position,
  shockMode: 'parallel' | 'matrix',
  shockType: 'step' | 'ramp',
  baseShockBp: number,
  shockCurves: ShockCurves | null | undefined,
  multiplier: number,
  t: number
): number {
  if (shockMode === 'parallel') {
    return (Number(baseShockBp) || 0) * multiplier;
  }
  if (!shockCurves) return 0;

  const curveKey = getSectorCurveKey(p.sector);
  const targetCurve: CurvePoint[] =
    p.bondType === 'swap'
      ? (shockCurves.swapCurve || [])
      : (shockCurves.bondCurves?.[curveKey] || shockCurves.bondCurves?.['국채'] || []);

  const safeRemainingDays = Number(p.remainingDays) || 0;
  const isStep = shockType === 'step';
  const evalDays = isStep ? safeRemainingDays : Math.max(0, safeRemainingDays - t);
  const years = evalDays / 365;

  return (interpolateCurveShift(years, targetCurve) || 0) * multiplier;
}

// ─── 일별 평가손익(MTM) 계산 ────────────────────────────────────
export function calculateDailyMTM(
  positions: Position[],
  shockMode: 'parallel' | 'matrix',
  shockType: 'step' | 'ramp',
  baseShockBp: number,
  shockCurves: ShockCurves | null | undefined,
  multiplier: number,
  t: number,
  currentSimDate?: Date
): number {
  return positions.reduce((total, p) => {
    if (currentSimDate && p.maturityDate) {
      const mat = parseISO(p.maturityDate);
      if (!isBefore(currentSimDate, mat)) return total;
    }
    const currentShockBp = getPositionShockBp(p, shockMode, shockType, baseShockBp, shockCurves, multiplier, t);
    const safeRemainingDays = Number(p.remainingDays) || 1;
    const isStep = shockType === 'step';
    const agingFactor = isStep ? 1.0 : Math.max(0, safeRemainingDays - t) / safeRemainingDays;
    const activePVBP = (Number(p.pvbp) || 0) * agingFactor;
    // 채권/IRS 통일: PVBP는 DV01 관행 (receive-fixed=양수, long bond=양수)
    // MTM = pvbp * (-shockBp)  — 금리 상승 시 손실
    const mtmPnL = activePVBP * (-currentShockBp);
    return total + (mtmPnL || 0);
  }, 0);
}

// ─── 일별 캐리 손익 계산 ────────────────────────────────────────
export function calculateDailyCarry(
  positions: Position[],
  shockMode: 'parallel' | 'matrix',
  shockType: 'step' | 'ramp',
  baseShockBp: number,
  shockCurves: ShockCurves | null | undefined,
  activeFundingRate: number,
  multiplier: number,
  t: number,
  currentSimDate?: Date
): number {
  return positions.reduce((total, p) => {
    if (currentSimDate && p.maturityDate) {
      const mat = parseISO(p.maturityDate);
      if (!isBefore(currentSimDate, mat)) return total;
    }
    const currentShockBp = getPositionShockBp(p, shockMode, shockType, baseShockBp, shockCurves, multiplier, t);

    const evalAmt = Number(p.evaluationAmount) || 0;

    if (p.bondType === 'swap') {
      // IRS: Theta(NPV 일일변화분) + 금리 충격에 따른 캐리 증분 (원본 공식 유지)
      return total + ((Number(p.expectedThetaPnL) || 0) + (evalAmt * (currentShockBp / 10000)) / 365);
    }

    // 채권(Bond/Cash): 시가(evaluationAmount) 기준 이자수익 - 조달비용
    const carryRate = (Number(p.mtmYield) || 0) + currentShockBp / 100;
    const dailyInterest = (evalAmt * (carryRate / 100)) / 365;
    const dailyFundingCost = (evalAmt * activeFundingRate) / 365;
    return total + (dailyInterest - dailyFundingCost);
  }, 0);
}
