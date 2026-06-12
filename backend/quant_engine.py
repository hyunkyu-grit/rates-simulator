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
        if T <= 1.0 + 1e-9:
            # 단기: DF(T) = 1/(1+c*T)  →  r = -ln(DF)/T
            df_T = 1.0 / (1.0 + c * T) if T > 1e-9 else 1.0
        else:
            # 장기: 분기 DF 합산 후 역산
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


def zero_rate(t: float, zc: np.ndarray) -> float:
    """Zero Curve에서 연속복리 Zero Rate 선형 보간 (extrapolate flat)"""
    if zc is None or len(zc) == 0:
        return 0.035
    return float(np.interp(t, zc[:, 0], zc[:, 1], left=float(zc[0, 1]), right=float(zc[-1, 1])))


def df(t: float, zc: np.ndarray) -> float:
    """Discount Factor : DF(t) = exp(-r(t) * t)"""
    if t <= 0:
        return 1.0
    return float(np.exp(-zero_rate(t, zc) * t))


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
) -> float:
    """
    Full Revaluation NPV

    Fixed Leg PV = Σ N * (fixedRate/100) * fixed_freq * DF(t_i)
    Float Leg PV (IRS) :
        현재 구간  → N * (currentFloat/100) * t_next * DF(t_next)   [확정 픽싱]
        미래 구간  → Σ N * f_simple(t_start, t_end) * Δt * DF(t_end) [포워드 픽싱]
    Float Leg PV (OIS) :
        현재 구간  → N * (currentFloat/100) * t_next * DF(t_next)
        미래 구간  → Σ N * (DF(t_start) - DF(t_end))                 [DF 차분 공식]

    NPV = direction * (Fixed PV - Float PV)
    """
    fixed_rate  = fixed_rate_pct  / 100.0
    float_rate0 = current_float_rate_pct / 100.0
    is_ois      = (sector == "OIS")

    t_next = max(t_next_payment, 1 / 365)  # 최소 1일

    # ── Fixed Leg ─────────────────────────────────────────────────────────────
    fixed_pv = 0.0
    t = t_next
    while t <= t_maturity + 1e-9:
        cf_t = min(t, t_maturity)
        fixed_pv += notional * fixed_rate * fixed_freq * df(cf_t, zc)
        if cf_t >= t_maturity - 1e-9:
            break
        t = round(t + fixed_freq, 10)

    # ── Float Leg ─────────────────────────────────────────────────────────────
    float_pv = 0.0

    # 현재 구간: 이미 fixing된 금리 사용
    float_pv += notional * float_rate0 * t_next * df(t_next, zc)

    if is_ois:
        # OIS: DF 차분 = Overnight 복리의 정확한 PV
        #   Σ DF(t_start) - DF(t_end)  over future periods
        t_s = t_next
        while t_s < t_maturity - 1e-9:
            t_e = min(t_s + float_freq, t_maturity)
            float_pv += notional * (df(t_s, zc) - df(t_e, zc))
            t_s = t_e
    else:
        # IRS: 3M Simple Forward Rate
        #   f(t_start, t_end) = (DF(t_start)/DF(t_end) - 1) / Δt
        t_s = t_next
        while t_s < t_maturity - 1e-9:
            t_e = min(t_s + float_freq, t_maturity)
            fwd = forward_rate_simple(t_s, t_e, zc)  # 포워드 CD 금리
            dt  = t_e - t_s
            float_pv += notional * fwd * dt * df(t_e, zc)
            t_s = t_e

    # direction: +1 = receive fixed  →  NPV = Fixed - Float  (채권처럼 Long)
    #            -1 = pay   fixed  →  NPV = Float - Fixed  (채권처럼 Short)
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
) -> float:
    """
    Spot Theta = NPV(t+1일) − NPV(t)   [커브 고정, 시간만 경과]

    시간 경과로 인한 순수 NPV 변화량:
      '할인율 언와인딩(Carry)' + '커브 롤다운(Roll-down)' 포함
    """
    DT = 1.0 / 365.0
    short_r      = current_float_rate_pct / 100.0
    par_anchored = _inject_short_anchors(par_rates, short_r)
    zc = bootstrap_zero_curve(par_anchored)

    npv_today = compute_irs_npv(
        notional, fixed_rate_pct, direction, t_maturity,
        t_next_payment, current_float_rate_pct, sector, zc,
        fixed_freq, float_freq,
    )
    # 내일: 만기/지급일 각 1일 앞당김
    npv_tomorrow = compute_irs_npv(
        notional, fixed_rate_pct, direction,
        max(t_maturity - DT, 0.0),
        max(t_next_payment - DT, DT),   # 최소 1일 잔존
        current_float_rate_pct, sector, zc,
        fixed_freq, float_freq,
    )
    return npv_tomorrow - npv_today


# ══════════════════════════════════════════════════════════════════════════════
# 6. 편의 함수: dict 형태 irsCurves → par_rates tuple list 변환
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
