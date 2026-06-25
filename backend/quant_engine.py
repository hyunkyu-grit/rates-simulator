"""
IRS / OIS 정밀 프라이싱 엔진 (Full Revaluation)
=================================================
방법론:
  1. Par Rate → Zero Rate 부트스트래핑 (Bootstrapping, ACT/365 연속복리)
  2. Forward Rate 계산
       IRS : 3M Simple Forward Rate  f(t1,t2) = (DF(t1)/DF(t2) - 1) / (t2-t1)
       OIS : DF 차분 공식  FloatPV = N * (DF(t_start) - DF(t_end))
  3. Full Revaluation NPV
       Fixed PV = Σ N * fixed_rate * freq * DF(t_i)
       Float PV = Σ N * f(t_{i-1}, t_i) * Δt * DF(t_i)
       NPV = direction * (Fixed PV - Float PV)
  4. PVBP 역산 (중앙차분법)
       PVBP = (NPV_down - NPV_up) / 2   [par_curve ±1bp 평행이동]
  5. KRD Map : 테너별 +1bp → ΔNPV
  6. Theta  : t+1일 NPV - t NPV  (커브 고정)

단위 규약:
  - couponRate, currentFloatRate : 퍼센트 (%) 단위  e.g. 3.50, 2.81
  - par_rates 입력              : 소수 (decimal) 단위  e.g. 0.035
  - PVBP / NPV 출력             : KRW 원화
"""

import numpy as np
from datetime import date as _date, timedelta
from typing import Optional

# ── KRD 테너 정의 ─────────────────────────────────────────────────────────────
KRD_TENORS = [1 / 365, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0, 7.0, 10.0]
KRD_NAMES  = ["1D", "3M", "6M", "9M", "1Y", "1.5Y", "2Y", "3Y", "4Y", "5Y", "7Y", "10Y"]

_SHORT_ANCHOR_TENORS = [1.0 / 365.0, 0.25]  # 1D, 3M


def _inject_short_anchors(
    par_rates: list[tuple[float, float]],
    short_rate: float,                   # decimal, e.g. 0.0281
) -> list[tuple[float, float]]:
    """
    irsCurves 앞단(1D, 3M) 앵커 노드 삽입.

    문제: irsCurves가 1Y부터 시작하면 0~1Y 구간 zero rate가 1Y로 flat 외삽됨.
         → 1D/3M KRD 버킷을 bump해도 1Y 노드와 동일한 커브를 bump하게 되어
           단기 리스크가 장기 버킷으로 bleed됨.
    해결: currentFloatRate를 1D·3M 앵커 금리로 삽입 →
         short-end를 별도 노드로 고정, KRD bleed 제거.

    중복 테너(절대차 < 1e-6) 는 삽입하지 않음.
    """
    if not par_rates:
        return par_rates
    # short_rate 미제공 시 가장 짧은 par rate 금리로 대체
    _r = short_rate if short_rate > 1e-6 else sorted(par_rates, key=lambda x: x[0])[0][1]
    existing_t = [p[0] for p in par_rates]
    result = list(par_rates)
    for anchor_t in _SHORT_ANCHOR_TENORS:
        if not any(abs(t - anchor_t) < 1e-6 for t in existing_t):
            result.append((anchor_t, _r))
    return sorted(result, key=lambda x: x[0])


# ══════════════════════════════════════════════════════════════════════════════
# 0. 영업일 조정 헬퍼 (주말 전용 — 한국 공휴일 없음)
# ══════════════════════════════════════════════════════════════════════════════

def _next_business_day(d: _date) -> _date:
    """Sat → Mon (+2), Sun → Mon (+1), 평일은 그대로 (주말 전용 규칙)"""
    wd = d.weekday()          # Mon=0 … Fri=4, Sat=5, Sun=6
    if wd == 5:
        return d + timedelta(days=2)
    if wd == 6:
        return d + timedelta(days=1)
    return d


def _bday_adj(t_years: float, sim_date: _date) -> float:
    """연수 t_years(sim_date 기준) → 영업일 조정 후 연수 반환"""
    cal = sim_date + timedelta(days=round(t_years * 365))
    adj = _next_business_day(cal)
    return (adj - sim_date).days / 365.0


def _subtract_months(d: _date, months: int) -> _date:
    """달력 개월 역산 (월말 초과분은 해당 월 말일로 클램프).
    예: Apr 13 - 3 → Jan 13  /  Mar 31 - 1 → Feb 28(29)
    timedelta(91) 근사(±1~2일 오차) 대비 정확한 분기 역산.
    """
    import calendar as _cal
    m = d.month - months
    y = d.year
    while m <= 0:
        m += 12
        y -= 1
    max_day = _cal.monthrange(y, m)[1]
    return _date(y, m, min(d.day, max_day))


# ══════════════════════════════════════════════════════════════════════════════
# 1. Zero Curve 부트스트래핑
# ══════════════════════════════════════════════════════════════════════════════

def bootstrap_zero_curve(par_rates: list[tuple[float, float]]) -> np.ndarray:
    """
    Par Rate (decimal) → Continuously Compounded Zero Rate 부트스트래핑

    알고리즘:
      T ≤ 1Y : 단순이자 DF(T) = 1/(1 + c*T) → r = -ln(DF)/T
      T > 1Y : 분기 쿠폰 스왑 공식 역산
                1 = c * Σ[i=0.25 to T-0.25] DF(ti)*0.25 + DF(T)*(1 + c*0.25)
                DF(T) = (1 - c * sum_df) / (1 + c*0.25)
                r(T)  = -ln(DF(T)) / T

    입력 : [(T_years, par_rate_decimal), ...]  오름차순
    출력 : np.ndarray shape (N,2)  → col0=T, col1=zero_rate
    """
    if not par_rates:
        # 커브 없음 → flat 3.5% fallback
        return np.array([[0.001, 0.035], [30.0, 0.035]])

    pts = sorted(par_rates, key=lambda x: x[0])
    zero_t: list[float] = []
    zero_r: list[float] = []

    def _interp_zero(t: float) -> float:
        """현재까지 구축된 포인트로 zero rate 선형 보간"""
        if not zero_t:
            return pts[0][1]  # 첫 par rate로 대체
        return float(np.interp(t, zero_t, zero_r, left=zero_r[0], right=zero_r[-1]))

    def _df(t: float) -> float:
        """DF(t) = exp(-r(t)*t)"""
        return float(np.exp(-_interp_zero(t) * max(t, 1e-12)))

    for T, c in pts:
        if T <= 0.26 + 1e-9:
            # 단기(≤3M): 단순이자 DF(T) = 1/(1+c*T)  →  r = -ln(DF)/T
            # 1D·3M 앵커는 머니마켓(단일지급) → 단순이자 적절
            df_T = 1.0 / (1.0 + c * T) if T > 1e-9 else 1.0
        else:
            # 6M 이상: 분기 쿠폰 스왑 공식 역산 (6M/9M/1Y/2Y/…)
            # DF(T) = (1 - c * Σ DF(t_i)·0.25) / (1 + c·0.25)  for t_i = 0.25,…,T-0.25
            sum_df = 0.0
            t_step = 0.25
            while t_step <= T - 0.25 + 1e-9:
                sum_df += _df(t_step) * 0.25
                t_step = round(t_step + 0.25, 10)  # float 누적 오차 방지
            df_T = (1.0 - c * sum_df) / (1.0 + c * 0.25)
            df_T = max(df_T, 1e-12)  # 음수 / 0 방지

        r_T = float(-np.log(df_T) / T) if T > 1e-9 else c
        zero_t.append(T)
        zero_r.append(r_T)

    return np.column_stack([zero_t, zero_r])


def df(t: float, zc: np.ndarray) -> float:
    """Discount Factor: Log-linear 보간 (ln DF = -r·T 를 선형 보간 → DF 로그선형)"""
    if t <= 0:
        return 1.0
    if zc is None or len(zc) == 0:
        return float(np.exp(-0.035 * t))
    # 각 노드의 ln(DF) = -r*T 를 계산 후 선형 보간 → log-linear on DF
    log_dfs = -(zc[:, 1] * zc[:, 0])          # -r·T at each node
    log_df_t = float(np.interp(t, zc[:, 0], log_dfs,
                                left=float(log_dfs[0]),
                                right=float(log_dfs[-1])))
    return float(np.exp(log_df_t))


def zero_rate(t: float, zc: np.ndarray) -> float:
    """Log-linear DF 보간에서 역산한 연속복리 제로금리 (보고/감사용)"""
    if zc is None or len(zc) == 0:
        return 0.035
    if t <= 1e-12:
        return float(zc[0, 1])
    return float(-np.log(max(df(t, zc), 1e-12)) / t)


def forward_rate_simple(t1: float, t2: float, zc: np.ndarray) -> float:
    """
    Simple Forward Rate for period [t1, t2]:
        f(t1, t2) = (DF(t1) / DF(t2) - 1) / (t2 - t1)

    의미: 미래 구간 [t1, t2]에서 예상되는 CD / IRS 픽싱 금리 (연율, decimal)
    """
    if t2 <= t1 + 1e-10:
        return zero_rate((t1 + t2) / 2, zc)
    df1 = df(t1, zc)
    df2 = df(t2, zc)
    if df2 < 1e-12:
        return 0.0
    return (df1 / df2 - 1.0) / (t2 - t1)


# ══════════════════════════════════════════════════════════════════════════════
# 2. IRS / OIS Full Revaluation NPV
# ══════════════════════════════════════════════════════════════════════════════

def compute_irs_npv(
    notional: float,
    fixed_rate_pct: float,          # % 단위  e.g. 3.50
    direction: int,                  # +1 = receive fixed,  -1 = pay fixed
    t_maturity: float,               # 만기까지 연수 (ACT/365)
    t_next_payment: float,           # 다음 변동 레그 지급까지 연수
    current_float_rate_pct: float,   # 현재 구간 확정 변동금리 (% 단위)
    sector: str,                     # 'IRS' | 'OIS'
    zc: np.ndarray,
    fixed_freq: float = 0.25,        # 고정 쿠폰 지급 주기 (분기 = 0.25년)
    float_freq: float = 0.25,        # 변동 레그 리셋 주기
    sim_date: Optional[_date] = None, # 영업일 조정용 기준일 (None이면 조정 생략)
) -> float:
    """
    Full Revaluation NPV

    Fixed Leg PV = Σ N * (fixedRate/100) * fixed_freq * DF(t_i)
    Float Leg PV (IRS) :
        현재 구간  → N * (currentFloat/100) * float_freq * DF(t_next)  [확정 픽싱]
                     └ accrual_tau = float_freq (고정),  할인만 t_next 사용
        미래 구간  → Σ N * f_simple(t_start, t_end) * Δt * DF(t_end)  [포워드 픽싱]
    Float Leg PV (OIS) :
        현재 구간  → N * (currentFloat/100) * float_freq * DF(t_next)
        미래 구간  → Σ N * (DF(t_start) - DF(t_end))                  [DF 차분 공식]

    NPV = direction * (Fixed PV - Float PV)
    """
    fixed_rate  = fixed_rate_pct  / 100.0
    float_rate0 = current_float_rate_pct / 100.0
    is_ois      = (sector == "OIS")

    t_next = max(t_next_payment, 1 / 365)  # 최소 1일

    # ── 지급 스케줄 생성 + 실제 ACT/365 적립 일수 산출 ─────────────────────────
    # t_maturity에서 fixed_freq 간격으로 역방향 생성 → 마지막 지급이 정확히 만기에 위치
    n_periods = round((t_maturity - t_next) / fixed_freq)
    future_pays_raw = [round(t_maturity - k * fixed_freq, 10)
                       for k in range(n_periods - 1, -1, -1)]

    if sim_date is not None:
        # ① 차기지급일 달력 날짜 (nextFixingDate 기준, 이미 영업일 적용됨)
        next_pay_adj = _next_business_day(
            sim_date + timedelta(days=round(t_next * 365))
        )
        # ② 이전지급일 추정: 차기지급일에서 freq_months 개월 정확히 역산 → 영업일 조정
        #    timedelta(91일) 근사(±1~2일 오차) 대신 달력 개월 역산으로 정확도 향상
        #    예: Apr 13 - 3개월 = Jan 13 (정확), Apr 13 - 91일 = Jan 12 (±1일 오차)
        freq_months = max(1, round(float_freq * 12))   # 0.25Y → 3개월
        prev_pay_adj = _next_business_day(
            _subtract_months(next_pay_adj, freq_months)
        )
        current_stub_accrual = (next_pay_adj - prev_pay_adj).days / 365.0

        # ③ 미래 지급일: 달력 날짜 변환 + 주말 영업일 조정
        pay_dates_adj = [
            _next_business_day(sim_date + timedelta(days=round(t * 365)))
            for t in future_pays_raw
        ]
        future_pays = [(d - sim_date).days / 365.0 for d in pay_dates_adj]

        # ④ 미래 쿠폰 실제 적립 일수: 인접 지급일 간 달력 일수 / 365
        prev_date = next_pay_adj
        future_accruals: list[float] = []
        for adj_date in pay_dates_adj:
            future_accruals.append((adj_date - prev_date).days / 365.0)
            prev_date = adj_date
    else:
        # sim_date 없음: 기존 균일 fixed_freq 사용 (폴백)
        future_pays      = future_pays_raw
        current_stub_accrual = float_freq
        future_accruals  = [fixed_freq] * len(future_pays_raw)

    # ── Fixed Leg ─────────────────────────────────────────────────────────────
    fixed_pv = 0.0
    # 현재 Stub: 실제 ACT/365 적립일수 사용 (이전지급일 → 차기지급일)
    fixed_pv += notional * fixed_rate * current_stub_accrual * df(t_next, zc)
    # 미래 쿠폰: 각 구간 실제 일수
    for pay_t, accrual in zip(future_pays, future_accruals):
        fixed_pv += notional * fixed_rate * accrual * df(pay_t, zc)

    # ── Float Leg ─────────────────────────────────────────────────────────────
    float_pv = 0.0

    # 현재 구간: 픽싱 확정 금리 × 실제 Stub 적립일수 (할인은 t_next 기준)
    float_pv += notional * float_rate0 * current_stub_accrual * df(t_next, zc)

    if is_ois:
        # OIS: DF 차분 = Overnight 복리의 정확한 PV
        t_s = t_next
        for t_e in future_pays:
            float_pv += notional * (df(t_s, zc) - df(t_e, zc))
            t_s = t_e
    else:
        # IRS: 3M Simple Forward Rate (미래 구간은 DF 항등식으로 기간 길이 자동 반영)
        t_s = t_next
        for t_e in future_pays:
            fwd = forward_rate_simple(t_s, t_e, zc)
            dt  = t_e - t_s
            float_pv += notional * fwd * dt * df(t_e, zc)
            t_s = t_e

    # direction: +1 = receive fixed  →  NPV = Fixed - Float
    #            -1 = pay   fixed  →  NPV = Float - Fixed
    return direction * (fixed_pv - float_pv)


# ══════════════════════════════════════════════════════════════════════════════
# 3. PVBP 역산 (중앙차분법, Central Difference)
# ══════════════════════════════════════════════════════════════════════════════

def compute_irs_pvbp(
    par_rates: list[tuple[float, float]],
    notional: float,
    fixed_rate_pct: float,
    direction: int,
    t_maturity: float,
    t_next_payment: float,
    current_float_rate_pct: float,
    sector: str,
    fixed_freq: float = 0.25,
    float_freq: float = 0.25,
) -> float:
    """
    PVBP = NPV(curve + 1bp) − NPV(base_curve)

    전진차분(Forward Difference) 방식:
      direction은 compute_irs_npv 내부에서 단 1회만 적용됨 (이중반전 없음).

    Float 픽싱 무결성:
      첫 번째 변동 현금흐름 금액(notional * currentFloat * Δt)은 커브와 무관하게 고정.
      커브 범프 시 DF(t_next)만 변하고 픽싱 금액은 불변 → 할인 리스크만 포안.

    부호 규약 (DV01 현업 관행):
      Receive-Fixed → 양수  (Long Bond과 동일)
      Pay-Fixed     → 음수  (Short Bond과 동일)

    시뮬레이션 공식:  MTM += pvbp * (-shock_bp)  (main.py)
    """
    SHIFT = 0.0001  # 1bp = 0.01%

    # 단기 앙커(1D, 3M) 삽입 — KRD bleed 방지 및 short-end 할인 리스크 정확화
    short_r      = current_float_rate_pct / 100.0
    par_anchored = _inject_short_anchors(par_rates, short_r)

    # Base NPV (원본 커브)
    zc_base  = bootstrap_zero_curve(par_anchored)
    npv_base = compute_irs_npv(
        notional, fixed_rate_pct, direction, t_maturity,
        t_next_payment, current_float_rate_pct, sector, zc_base,
        fixed_freq, float_freq,
    )

    # +1bp 시프틸 NPV — 앙커 노드 포함 전체 평행이동
    par_up  = [(t, r + SHIFT) for t, r in par_anchored]
    zc_up   = bootstrap_zero_curve(par_up)
    npv_up  = compute_irs_npv(
        notional, fixed_rate_pct, direction, t_maturity,
        t_next_payment, current_float_rate_pct, sector, zc_up,
        fixed_freq, float_freq,
    )

    # DV01 = -(ΔNPV per +1bp)  현업 관행
    # Receive-Fixed: npv_up < npv_base → -(음수) = 양수 ✓ (Long Bond)
    # Pay-Fixed    : npv_up > npv_base → -(양수) = 음수 ✓ (Short Bond)
    return -(npv_up - npv_base)


# ══════════════════════════════════════════════════════════════════════════════
# 4. KRD Map (테너별 1bp 이동 → ΔNPV)
# ══════════════════════════════════════════════════════════════════════════════

def compute_irs_krd_map(
    par_rates: list[tuple[float, float]],
    notional: float,
    fixed_rate_pct: float,
    direction: int,
    t_maturity: float,
    t_next_payment: float,
    current_float_rate_pct: float,
    sector: str,
    fixed_freq: float = 0.25,
    float_freq: float = 0.25,
) -> dict[str, float]:
    """
    각 KRD 테너 노드: 해당 par rate +1bp 이동 → ΔNPV (재부트스트래핑 후 재평가)

    단기 앙커 포함 Bumping:
      1D KRD → 1/365년 앙커 노드를 1bp bump → DF(t_next) 변화 →
               첫 픽싱 현금흐름의 할인리스크를 1D 버킷에 정확 포안.
      3M KRD → 0.25년 앙커 노드를 1bp bump → 3M~6M 구간 할인리스크.
      앙커 없이 bump 시 단기 리스크가 더 련 장기 버킷으로 bleed → 해결됨.

    유효 상한 (effective_upper):
      t_maturity 이상의 첫 번째 par rate 노드까지만 KRD 산출.
      예) t_maturity=4.98Y, 5Y 노드 존재 → z(4.75)/z(4.98)이 z(5Y)에 보간 의존
          → 5Y KRD 포함.
    """
    short_r      = current_float_rate_pct / 100.0
    par_anchored = _inject_short_anchors(par_rates, short_r)

    zc_base  = bootstrap_zero_curve(par_anchored)
    npv_base = compute_irs_npv(
        notional, fixed_rate_pct, direction, t_maturity,
        t_next_payment, current_float_rate_pct, sector, zc_base,
        fixed_freq, float_freq,
    )

    par_arr = sorted(par_anchored, key=lambda x: x[0])
    avail_t = [p[0] for p in par_arr]
    krd: dict[str, float] = {name: 0.0 for name in KRD_NAMES}

    if not avail_t:
        return krd

    # 유효 상한: t_maturity 이상의 첫 번째 par rate 노드 (앙커 포함)
    effective_upper = next(
        (t for t in avail_t if t >= t_maturity - 1e-9),
        avail_t[-1] if avail_t else t_maturity,
    )

    for t_key, name in zip(KRD_TENORS, KRD_NAMES):
        if t_key > effective_upper + 1e-9:
            continue  # effective_upper 초과: 만기 내 zero curve에 무관
        # 가장 가까운 par rate 노드 선택
        # (1D/3M 앙커 포함으로 단기 KRD가 정확하게 해당 버킷에 포안됨)
        closest = min(avail_t, key=lambda x: abs(x - t_key))
        shifted = [(t, r + 0.0001 if abs(t - closest) < 1e-9 else r) for t, r in par_arr]
        zc_s    = bootstrap_zero_curve(shifted)
        npv_s   = compute_irs_npv(
            notional, fixed_rate_pct, direction, t_maturity,
            t_next_payment, current_float_rate_pct, sector, zc_s,
            fixed_freq, float_freq,
        )
        krd[name] = -(npv_s - npv_base)  # DV01 관행

    return krd


# ══════════════════════════════════════════════════════════════════════════════
# 5. Theta (시간가치) 계산
# ══════════════════════════════════════════════════════════════════════════════

def compute_irs_theta(
    par_rates: list[tuple[float, float]],
    notional: float,
    fixed_rate_pct: float,
    direction: int,
    t_maturity: float,
    t_next_payment: float,
    current_float_rate_pct: float,
    sector: str,
    fixed_freq: float = 0.25,
    float_freq: float = 0.25,
    base_date: Optional[_date] = None,
) -> float:
    """
    Spot Theta = NPV(t+1일) − NPV(t)   [커브 고정, 시간만 경과]

    시간 경과로 인한 순수 NPV 변화량:
      '할인율 언와인딩(Carry)' + '커브 롤다운(Roll-down)' 포함

    base_date를 전달하면 ACT/365 실일수 기준 스텁 계산 (simulate_irs_path_fm과 일치).
    """
    DT = 1.0 / 365.0
    short_r      = current_float_rate_pct / 100.0
    par_anchored = _inject_short_anchors(par_rates, short_r)
    zc = bootstrap_zero_curve(par_anchored)

    tomorrow: Optional[_date] = base_date + timedelta(days=1) if base_date else None

    npv_today = compute_irs_npv(
        notional, fixed_rate_pct, direction, t_maturity,
        t_next_payment, current_float_rate_pct, sector, zc,
        fixed_freq, float_freq,
        sim_date=base_date,
    )
    # 내일: 만기/지급일 각 1일 앞당김
    npv_tomorrow = compute_irs_npv(
        notional, fixed_rate_pct, direction,
        max(t_maturity - DT, 0.0),
        max(t_next_payment - DT, DT),   # 최소 1일 잔존
        current_float_rate_pct, sector, zc,
        fixed_freq, float_freq,
        sim_date=tomorrow,
    )
    theta = npv_tomorrow - npv_today
    print(
        f"[THETA DEBUG] notional={notional:,.0f}  fixed={fixed_rate_pct}%  float={current_float_rate_pct}%"
        f"  dir={direction}  t_mat={t_maturity:.4f}Y  t_next={t_next_payment:.4f}Y"
        f"  npv_today={npv_today:,.0f}  npv_tomorrow={npv_tomorrow:,.0f}  theta={theta:,.0f}"
    )
    return theta


# ══════════════════════════════════════════════════════════════════════════════
# 6. FM 시뮬레이션 (Full Revaluation Path — NumPy 벡터화)
# ══════════════════════════════════════════════════════════════════════════════

def simulate_irs_path_fm(
    par_rates: list[tuple[float, float]],
    notional: float,
    fixed_rate_pct: float,
    direction: int,
    t_maturity: float,
    t_next_payment: float,
    current_float_rate_pct: float,
    sector: str,
    shock_curve: list[tuple[float, float]],
    days_to_simulate: int = 180,
    fixed_freq: float = 0.25,
    float_freq: float = 0.25,
    shock_type: str = "step",           # 'step': Day 1부터 100% 즉시 / 'ramp': 매일 d/D 비율 증가
    base_date_str: str = "",            # 기준일 ISO 문자열 (e.g. '2026-03-24') — 영업일 조정용
    audit: bool = False,               # True 시 Day 0~10 감사 로그를 CSV로 저장
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict, list]:
    """
    True Path-Dependent FM: 매일 루프 + 롤오프(Roll-off) + 동적 리픽싱(Refixing).

    충격 가정:
      • step : Day 0 MTM = 0, Day 1+ 부터 100% 충격 즉시 반영
      • ramp : day/sim_days 비율로 매일 새로운 부트스트래핑 커브 생성

    현금흐름 처리:
      • 경과 일수 만큼 t_maturity / t_next_payment 단축 → 만기 도래 CF 자동 제외
      • 변동금리 지급일 통과 시 해당 일차 충격 제로커브의 3M 포워드금리로 재확정

    Returns:
        mtm_pnl   : shape (days_to_simulate+1,) — 일별 Shocked NPV − Base NPV  [KRW]
        daily_pvbp: shape (days_to_simulate+1,) — 일별 PVBP [KRW/bp, DV01 관행]
        daily_carry: shape (days_to_simulate+1,) — 일별 정산 보정 캐리 [KRW]
        audit_rows: list[dict] — audit=True일 때 일별 감사 데이터 (CSV는 호출자가 작성)
    """
    SHIFT    = 1e-4
    DT       = 1.0 / 365.0
    par_anch = _inject_short_anchors(par_rates, current_float_rate_pct / 100.0)

    if shock_curve:
        _sc_t  = np.array([t for t, _ in shock_curve], dtype=float)
        _sc_bp = np.array([b for _, b in shock_curve], dtype=float)
    else:
        _sc_t  = np.array([0.0, 30.0])
        _sc_bp = np.array([0.0,  0.0])

    def _zc(factor: float) -> np.ndarray:
        """factor 비율로 shock_curve 반영한 제로커브 부트스트래핑."""
        return bootstrap_zero_curve(
            [(t, r + float(np.interp(t, _sc_t, _sc_bp)) * factor * SHIFT)
             for t, r in par_anch]
        )

    D           = days_to_simulate + 1
    mtm_pnl     = np.zeros(D)
    daily_pvbp  = np.zeros(D)
    daily_carry = np.zeros(D)   # 일별 캐리: base NPV 경로의 하루 변화량

    # ── 정적 기준 커브 (무충격, 전 구간 고정) ─────────────────────────────────
    zc_base = _zc(0.0)

    # ── 기준일 파싱 (영업일 조정용) ───────────────────────────────────────────────
    _base_date: Optional[_date] = None
    if base_date_str:
        try:
            _base_date = _date.fromisoformat(base_date_str[:10])
        except Exception:
            _base_date = None

    # ── currentFloatRate 폴백: 0이면 base 커브 3M forward 사용 (400M 점프 방지) ──
    if current_float_rate_pct <= 0.0:
        _fwd = forward_rate_simple(0.0, float_freq, zc_base) * 100.0
        current_float_rate_pct = _fwd

    # ── 커브 사전 계산: step shock은 Day 1 이후 충격 커브가 고정 → 1회만 부트스트래핑 ──
    # ramp shock은 매일 factor가 달라 캐싱 불가 → 루프 내 계산
    _zc_full   = _zc(1.0)   # factor=1.0 충격 커브 (Day 0 PVBP + step 전 구간 공용)
    _zc_full1b = bootstrap_zero_curve(
        [(t, r + float(np.interp(t, _sc_t, _sc_bp)) * SHIFT + SHIFT)
         for t, r in par_anch]
    )  # factor=1.0 + 1bp 추가 커브 (step 전 구간 PVBP 공용)

    # ── Day 0: 참조 상태, MTM = 0  / PVBP는 base 커브 기준 1bp 병렬이동 ───────
    t0_nxt = max(t_next_payment, DT)
    daily_pvbp[0] = -(
        compute_irs_npv(notional, fixed_rate_pct, direction,
                        t_maturity, t0_nxt, current_float_rate_pct,
                        sector, _zc_full, fixed_freq, float_freq)
        - compute_irs_npv(notional, fixed_rate_pct, direction,
                          t_maturity, t0_nxt, current_float_rate_pct,
                          sector, zc_base, fixed_freq, float_freq)
    )

    # ── 경로 상태: Shocked 경로 / Base 경로 각각 독립 관리 ────────────────────
    t_mat_s, t_nxt_s, flt_s = t_maturity, t0_nxt, current_float_rate_pct
    t_mat_b, t_nxt_b, flt_b = t_maturity, t0_nxt, current_float_rate_pct

    # Day 0 기준 base NPV
    npv_b_prev = compute_irs_npv(
        notional, fixed_rate_pct, direction,
        t_maturity, t0_nxt, current_float_rate_pct,
        sector, zc_base, fixed_freq, float_freq,
        sim_date=_base_date,
    )
    # IRS MTM 기준점: Day 0 NPV (무충격, factor=0 → zc_s = zc_base)
    # 이후 모든 MTM = (npv_s - npv_s_initial) + cum_cf_s
    # IRS carry = 0 (리픽싱 금리가 시나리오 경로를 따르므로 carry/MTM 분리 의미 없음)
    npv_s_initial = npv_b_prev
    cum_cf_s = 0.0  # 충격 경로 누적 정산 현금흐름 (리픽싱 데이마다 누적)
    cum_cf_b = 0.0  # 기준 경로 누적 정산 현금흐름

    # Bug 1: 포트폴리오 합산용 일별 NPV / 정산 CF 배열 (호출자에서 += 로 집계)
    daily_npv_s = np.zeros(D)
    daily_npv_b = np.zeros(D)
    daily_scf_b = np.zeros(D)
    daily_scf_s = np.zeros(D)
    # Day 0 NPV 기록: 기준일 par curve 기준 초기값 (audit CSV의 Day 0 행에 표시)
    daily_npv_b[0] = npv_b_prev
    daily_npv_s[0] = npv_b_prev  # Day 0: 충격 없음 → shocked = base

    # ── Audit 준비 (audit=True 시만) ──────────────────────────────────────────
    if audit:
        def _fmt_tenor(t_yr: float) -> str:
            d = t_yr * 365.0
            if d < 25:   return f"{int(round(d))}D"
            if d < 350:  return f"{int(round(d / 30.4375))}M"
            yr = round(t_yr, 2)
            return f"{int(yr)}Y" if yr == int(yr) else f"{yr}Y"
        curve_tenors: list[tuple[str, float]] = [(_fmt_tenor(t), t) for t, _ in par_anch]

    audit_rows: list[dict] = []

    # ── 메인 시뮬레이션 루프: Day 1 ~ sim_days ────────────────────────────────
    for day in range(1, D):
        try:
            # 1. 롤오프(Roll-off): 하루 경과 → 모든 잔존 시간 단축
            t_mat_s -= DT;  t_mat_b -= DT
            t_nxt_s -= DT;  t_nxt_b -= DT

            # 2. 해당 일차 충격 비율 (step / ramp)
            factor = (day / max(days_to_simulate, 1)) if shock_type == "ramp" else 1.0

            # 3. 해당 일차 제로커브 생성
            # step: 매일 factor=1.0 고정 → 사전 계산된 커브 재사용 (핵심 최적화)
            # ramp: 매일 factor가 달라 새로 부트스트래핑 불가피
            if shock_type == "step":
                zc_s  = _zc_full
                zc_s1 = _zc_full1b
            else:
                zc_s  = _zc(factor)
                zc_s1 = bootstrap_zero_curve(
                    [(t, r + float(np.interp(t, _sc_t, _sc_bp)) * factor * SHIFT + SHIFT)
                     for t, r in par_anch]
                )

            # 4. 구 픽싱 저장 (정산액 계산용 — 만기/리픽싱 공통)
            flt_s_old = flt_s
            flt_b_old = flt_b
            refixed_s = False
            refixed_b = False

            # 5. 동적 리픽싱 — Bug 2: 만기일에도 먼저 수행해야 마지막 쿠폰이 정산됨
            if t_nxt_s <= DT * 0.5:
                refixed_s = True
                flt_s     = forward_rate_simple(0.0, float_freq, zc_s) * 100.0
                t_nxt_s   = min(float_freq, t_mat_s)

            if t_nxt_b <= DT * 0.5:
                refixed_b = True
                flt_b     = forward_rate_simple(0.0, float_freq, zc_base) * 100.0
                t_nxt_b   = min(float_freq, t_mat_b)

            # 6. 정산 현금흐름 (사용자 지정 공식: Net CF Netting 보장)
            #    Receive Fixed (+1): net_rate = fixed - float  → CF = N × net_rate/100 × freq
            #    Pay    Fixed  (-1): net_rate = float - fixed  → CF = N × net_rate/100 × freq
            _is_pay = (direction == -1)
            if refixed_s:
                _net_s      = (flt_s_old - fixed_rate_pct) if _is_pay else (fixed_rate_pct - flt_s_old)
                settled_cf_s = notional * (_net_s / 100.0) * float_freq
                cum_cf_s    += settled_cf_s
            else:
                settled_cf_s = 0.0

            if refixed_b:
                _net_b      = (flt_b_old - fixed_rate_pct) if _is_pay else (fixed_rate_pct - flt_b_old)
                settled_cf_b = notional * (_net_b / 100.0) * float_freq
                cum_cf_b    += settled_cf_b
            else:
                settled_cf_b = 0.0

            # 7. 만기 도래 감지 (Bug 2 fix): 최종 CF 기록 후 루프 종료
            if t_mat_s <= DT * 0.5:
                # 리픽싱 없이 만기를 맞은 스텁 구간: 실제 남은 기간으로 최종 CF 정산
                if not refixed_s:
                    accrual_s    = max(t_nxt_s + DT, DT)
                    _net_s_mat   = (flt_s_old - fixed_rate_pct) if _is_pay else (fixed_rate_pct - flt_s_old)
                    settled_cf_s = notional * (_net_s_mat / 100.0) * accrual_s
                    cum_cf_s    += settled_cf_s
                if not refixed_b:
                    accrual_b    = max(t_nxt_b + DT, DT)
                    _net_b_mat   = (flt_b_old - fixed_rate_pct) if _is_pay else (fixed_rate_pct - flt_b_old)
                    settled_cf_b = notional * (_net_b_mat / 100.0) * accrual_b
                    cum_cf_b    += settled_cf_b

                npv_s = 0.0;  npv_b = 0.0   # 만기: NPV는 정확히 0
                mtm_pnl[day:]    = (npv_s - npv_s_initial) + cum_cf_s  # 만기 이후 전 일자 실현손익 carry-forward
                daily_pvbp[day]  = 0.0
                daily_carry[day] = 0.0  # IRS: 전부 MTM으로 처리
                daily_npv_s[day] = npv_s
                daily_npv_b[day] = npv_b
                daily_scf_b[day] = settled_cf_b
                daily_scf_s[day] = settled_cf_s

                if audit:
                    row: dict = {
                        "Day": day, "Aging_Days": day,
                        "Shock_Type": shock_type,
                        "Ramp_Factor_pct": round(factor * 100, 1),
                        "Float_Shocked_pct": round(flt_s, 4),
                        "Float_Base_pct":    round(flt_b, 4),
                        "t_nxt_s_yr":        round(t_nxt_s, 4),
                    }
                    for lbl, t_yr in curve_tenors:
                        row[f"Shock_{lbl}_bp"]      = round(float(np.interp(t_yr, _sc_t, _sc_bp)) * factor, 2)
                        row[f"ZeroCurve_{lbl}_pct"] = round(float(np.interp(t_yr, zc_s[:, 0], zc_s[:, 1])) * 100, 4)
                    row["NPV_Shocked"]      = 0
                    row["NPV_Base"]         = 0
                    row["Settled_CF_Base"]  = round(settled_cf_b)
                    row["Settled_CF_Shock"] = round(settled_cf_s)
                    row["Cum_CF_Diff"]      = round(cum_cf_s - cum_cf_b)
                    row["Daily_FM_Carry"]   = round(float(daily_carry[day]))
                    row["Daily_Clean_MTM"]  = round(float(mtm_pnl[day]))
                    audit_rows.append(row)

                break  # 만기 이후: 잔여 배열은 0 유지 (zero-padding)

            # 8. Full Revaluation (FM) NPV 재평가 (만기 전)
            # sim_date=None: 시뮬레이션 루프에서는 영업일 조정 생략 (균일 고정 주기 사용)
            # 이 옵션이 단순 MTM 경로 추적에서 약 50% 속도 향상을 제공함
            # (ACT/365 정밀도 영향: ±2일 오차 → 할인 오차 < 0.02%, MTM 차이값에서 상쇄)
            npv_s  = compute_irs_npv(notional, fixed_rate_pct, direction,
                                      t_mat_s, t_nxt_s, flt_s, sector, zc_s,
                                      fixed_freq, float_freq, sim_date=None)
            npv_b  = compute_irs_npv(notional, fixed_rate_pct, direction,
                                      t_mat_b, t_nxt_b, flt_b, sector, zc_base,
                                      fixed_freq, float_freq, sim_date=None)
            npv_s1 = compute_irs_npv(notional, fixed_rate_pct, direction,
                                      t_mat_s, t_nxt_s, flt_s, sector, zc_s1,
                                      fixed_freq, float_freq, sim_date=None)

            # 9. IRS 총 P&L = MTM (시나리오 경로 기준) — carry = 0
            # mtm_pnl[day]: Day 0 대비 누적 P&L 레벨 (리픽싱 금리도 shocked curve 반영)
            mtm_pnl[day]     = (npv_s - npv_s_initial) + cum_cf_s
            daily_pvbp[day]  = -(npv_s1 - npv_s)
            daily_carry[day] = 0.0  # IRS carry 없음 — 전부 MTM
            npv_b_prev       = npv_b

            # Bug 1: 포트폴리오 집계용 일별 NPV / 정산 CF 기록
            daily_npv_s[day] = npv_s
            daily_npv_b[day] = npv_b
            daily_scf_b[day] = settled_cf_b
            daily_scf_s[day] = settled_cf_s

            # ── NaN / Inf 오염 감지 ──────────────────────────────────────────
            if not np.isfinite(mtm_pnl[day]):
                print(
                    f"\n[★★★ NaN/Inf ALERT ★★★] Day {day}: mtm_pnl={mtm_pnl[day]!r} "
                    f"| factor={factor:.6f} | npv_s={npv_s:.2f} | npv_b={npv_b:.2f} "
                    f"| flt_s={flt_s:.4f}% | t_nxt_s={t_nxt_s:.6f} | t_mat_s={t_mat_s:.6f}"
                )
                raise ValueError(f"Day {day} mtm_pnl 오염: {mtm_pnl[day]!r}")
            if not np.isfinite(daily_pvbp[day]):
                print(
                    f"\n[★★★ NaN/Inf ALERT ★★★] Day {day}: daily_pvbp={daily_pvbp[day]!r} "
                    f"| npv_s1={npv_s1:.2f} | npv_s={npv_s:.2f}"
                )
                raise ValueError(f"Day {day} daily_pvbp 오염: {daily_pvbp[day]!r}")

            # 10. Audit 데이터 수집 (전체 시뮬레이션 일수 — 절단 없음)
            if audit:
                row: dict = {
                    "Day": day, "Aging_Days": day,
                    "Shock_Type": shock_type,
                    "Ramp_Factor_pct": round(factor * 100, 1),
                    "Float_Shocked_pct": round(flt_s, 4),
                    "Float_Base_pct":    round(flt_b, 4),
                    "t_nxt_s_yr":        round(t_nxt_s, 4),
                }
                for lbl, t_yr in curve_tenors:
                    row[f"Shock_{lbl}_bp"]      = round(float(np.interp(t_yr, _sc_t, _sc_bp)) * factor, 2)
                    row[f"ZeroCurve_{lbl}_pct"] = round(float(np.interp(t_yr, zc_s[:, 0], zc_s[:, 1])) * 100, 4)
                row["NPV_Shocked"]      = round(npv_s)
                row["NPV_Base"]         = round(npv_b)
                row["Settled_CF_Base"]  = round(settled_cf_b)
                row["Settled_CF_Shock"] = round(settled_cf_s)
                row["Cum_CF_Diff"]      = round(cum_cf_s - cum_cf_b)
                row["Daily_FM_Carry"]   = round(float(daily_carry[day]))
                row["Daily_Clean_MTM"]  = round(float(mtm_pnl[day]))
                audit_rows.append(row)

        except Exception as _err:
            import traceback as _tb
            print(f"\n[CRITICAL ERROR] ══════════════════════════════════════════════════")
            print(f"[CRITICAL ERROR] Day {day} 연산 중 뻗음: {_err}")
            print(f"[CRITICAL ERROR] 상세:\n{_tb.format_exc()}")
            print(f"[CRITICAL ERROR] ══════════════════════════════════════════════════\n")
            raise

    # ── audit_rows는 호출자(build_chart_data)가 포트폴리오 합산 후 단일 CSV 저장 ──
    if audit and audit_rows:
        n_tenors = len(curve_tenors)
        print(f"[AUDIT] 종목 감사 데이터 수집 완료: {n_tenors} 테너, {len(audit_rows)} 행 — CSV는 포트폴리오 루프 종료 후 저장")

    daily_metrics = {
        "npv_s": daily_npv_s,
        "npv_b": daily_npv_b,
        "scf_b": daily_scf_b,
        "scf_s": daily_scf_s,
    }
    return mtm_pnl, daily_pvbp, daily_carry, daily_metrics, audit_rows


# ══════════════════════════════════════════════════════════════════════════════
# 7. 편의 함수: dict 형태 irsCurves → par_rates tuple list 변환
# ══════════════════════════════════════════════════════════════════════════════

def parse_irs_curves(irs_curves: list[dict]) -> list[tuple[float, float]]:
    """
    프론트엔드 전송 형식 [{t: float, rate: float}, ...]  (rate = decimal)
    →  [(T_years, par_rate_decimal), ...]  오름차순 정렬
    """
    result = []
    for item in irs_curves:
        t    = float(item.get("t", 0))
        rate = float(item.get("rate", 0))
        if t > 0:
            result.append((t, rate))
    return sorted(result, key=lambda x: x[0])
