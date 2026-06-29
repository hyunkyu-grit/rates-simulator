from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Literal
from datetime import date, timedelta
import os
import numpy as np
import pandas as pd
import quant_engine as qe

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Excel 로데이터 모델 (향후 QuantLib 프라이싱용) ────────────────────────────

class BondPosition(BaseModel):
    종목명: str
    유가증권구분: str
    만기일자: date
    표면이율: float
    잔존일수: int
    액면금액: float
    민평수익율: float
    민평단가: float
    듀레이션: float


class IRSPosition(BaseModel):
    종목명: str
    시작일: date
    만기일: date
    현재액면: float
    고정금리: float
    지급수취방향: Literal["pay", "receive"]
    지급주기: int
    수취주기: int
    current_floating_rate: float
    next_payment_date: date
    fixing_date: date


class CurveData(BaseModel):
    테너: str
    당일_mid: float
    전일비_bp: float
    섹터별_스프레드: dict[str, float]


# ── 프론트엔드 시뮬레이션 요청 모델 ──────────────────────────────────────────

class FrontendPosition(BaseModel):
    id: str = ""
    name: str = ""
    book: str = ""
    bondType: str = "bond"              # 'swap' | 'bond'
    sector: str = ""
    maturityDate: str | None = None
    couponRate: float = 0.0
    frequency: int = 2
    notional: float = 0.0
    entryYield: float = 0.0
    evaluationAmount: float = 0.0
    duration: float = 0.0
    pvbp: float = 0.0
    tenor: str = ""
    remainingDays: float = 0.0
    krdMap: dict[str, float] = {}
    mtmYield: float | None = None
    expectedThetaPnL: float | None = None
    direction: float = 1.0          # IRS: +1=receive-fixed, -1=pay-fixed / Bond: +1=long
    currentFloatRate: float = 0.0   # IRS 현재 구간 변동금리 (% 단위, e.g. 2.81)
    nextFixingDate: str | None = None   # IRS 다음 변동금리 픽싱/지급일 (ISO date string)


class FrontendShockCurves(BaseModel):
    bondCurves: dict[str, list[dict]] = {}  # {섹터키: [{t, val}, ...]}
    swapCurve: list[dict] = []
    fundingEvents: list[dict] = []


class SimulateRequest(BaseModel):
    positions: list[FrontendPosition]
    shockCurves: FrontendShockCurves | None = None         # 시나리오 충격 (chartData 전용)
    dailyShockCurves: FrontendShockCurves | None = None    # 당일 실제 금리변동 (bookDailyPnL 전용)
    fundingRate: float = 0.042
    fundingEvents: list[dict] = []
    simDays: int = 90
    shockType: str = "step"             # 'step' | 'ramp'
    shockMode: str = "parallel"         # 'parallel' | 'matrix'
    baseShockBp: float = 50.0
    baseDate: str = "2026-01-01"
    irsCurves: list[dict] = []          # [{t: float, rate: float}, ...] IRS Par Rate (decimal)
    customPath: list[dict] = []         # [{day: int, bp: float}, ...] 웨이포인트 기반 커스텀 경로


# ── 퀀트 엔진 헬퍼 함수 ───────────────────────────────────────────────────────

def get_sector_curve_key(sector: str) -> str:
    s = sector or ""
    if any(k in s for k in ("국고", "통안", "국채")): return "국채"
    if any(k in s for k in ("시은", "은행")): return "은행채"
    if any(k in s for k in ("특은", "공사")): return "특은채"
    if any(k in s for k in ("여전", "카드")): return "카드채"
    if "회사" in s: return "회사채"
    return "국채"


def parse_tenor_to_years(tenor: str) -> float:
    t = str(tenor).upper().replace("년", "Y").replace("개월", "M").replace("일", "D").strip()
    try:
        if "Y" in t: return float(t.replace("Y", ""))
        if "M" in t: return float(t.replace("M", "")) / 12
        if "D" in t: return float(t.replace("D", "")) / 365
        return float(t)
    except Exception:
        return 0.0


def interpolate_curve_shift(years: float, curve: list[dict]) -> float:
    if not curve:
        return 0.0
    pts = sorted(
        [{"t": float(p.get("t", 0)), "val": float(p.get("val", 0))} for p in curve],
        key=lambda x: x["t"],
    )
    if not pts: return 0.0
    if years <= pts[0]["t"]: return pts[0]["val"]
    if years >= pts[-1]["t"]: return pts[-1]["val"]
    for i in range(len(pts) - 1):
        lo, hi = pts[i], pts[i + 1]
        if lo["t"] <= years <= hi["t"]:
            if hi["t"] == lo["t"]: return lo["val"]
            ratio = (years - lo["t"]) / (hi["t"] - lo["t"])
            return lo["val"] + (hi["val"] - lo["val"]) * ratio
    return 0.0


def get_position_shock_bp(
    p: FrontendPosition,
    shock_mode: str,
    shock_type: str,
    base_shock_bp: float,
    shock_curves: FrontendShockCurves | None,
    multiplier: float,
    t: int,
) -> float:
    if shock_mode == "parallel":
        return (base_shock_bp or 0.0) * multiplier
    if not shock_curves:
        return 0.0
    safe_remaining = max(p.remainingDays or 0, 0)
    eval_days = safe_remaining if shock_type == "step" else max(0, safe_remaining - t)
    years = eval_days / 365.0
    if p.bondType == "swap":
        return interpolate_curve_shift(years, shock_curves.swapCurve) * multiplier
    curve_key = get_sector_curve_key(p.sector)
    target = (
        shock_curves.bondCurves.get(curve_key)
        or shock_curves.bondCurves.get("국채")
        or []
    )
    return interpolate_curve_shift(years, target) * multiplier


def _is_matured(p: FrontendPosition, current_date: date) -> bool:
    if p.maturityDate:
        try:
            return current_date >= date.fromisoformat(p.maturityDate)
        except Exception:
            pass
    return False


def calculate_daily_mtm(
    positions: list[FrontendPosition],
    shock_mode: str,
    shock_type: str,
    base_shock_bp: float,
    shock_curves: FrontendShockCurves | None,
    multiplier: float,
    t: int,
    current_date: date | None = None,
    short_multiplier: float | None = None,  # 잔존 1Y 미만 채권에 적용 (BOK 계단 함수)
) -> float:
    total = 0.0
    for p in positions:
        if current_date and _is_matured(p, current_date):
            continue

        initial_remaining = max(float(p.remainingDays or 1), 1.0)
        initial_pvbp = p.pvbp or 0.0

        if p.bondType != "swap":
            # 채권: 잔존일수·PVBP를 매일 재산정
            current_remaining = max(initial_remaining - t, 0.0)

            if current_remaining <= 0:
                continue  # 만기 Roll-off: MTM = 0

            current_pvbp = initial_pvbp * (current_remaining / initial_remaining)

            # 잔존기간별 팩터 결정:
            #   < 3M (0.25Y) : BOK 계단 함수 (기준금리 직결)
            #   3M ~ 1Y      : BOK ↔ 웨이포인트 선형 보간
            #   >= 1Y        : 웨이포인트 경로
            r_years = current_remaining / 365.0
            if short_multiplier is not None:
                if r_years < 0.25:
                    eff_mult = short_multiplier
                elif r_years < 1.0:
                    blend = (r_years - 0.25) / (1.0 - 0.25)   # 0 at 3M → 1 at 1Y
                    eff_mult = short_multiplier * (1.0 - blend) + multiplier * blend
                else:
                    eff_mult = multiplier
            else:
                eff_mult = multiplier

            if shock_mode == "parallel":
                shock_bp = (base_shock_bp or 0.0) * eff_mult
            else:
                if not shock_curves:
                    shock_bp = 0.0
                else:
                    curve_key = get_sector_curve_key(p.sector)
                    target = (
                        shock_curves.bondCurves.get(curve_key)
                        or shock_curves.bondCurves.get("국채")
                        or []
                    )
                    # BOK 이벤트는 기준금리(KTB) 성분에만 적용; 크레딧 스프레드는 장기 경로를 따름
                    # → 특은채 등에 크레딧 스프레드가 포함된 경우 eff_mult가 스프레드까지 스케일하는 오류 방지
                    ktb_curve  = shock_curves.bondCurves.get("국채") or []
                    ktb_at_r   = interpolate_curve_shift(r_years, ktb_curve)
                    total_at_r = interpolate_curve_shift(r_years, target)
                    credit_addon = total_at_r - ktb_at_r   # 크레딧 스프레드 성분
                    shock_bp = ktb_at_r * eff_mult + credit_addon * multiplier

            total += current_pvbp * (-shock_bp)
        else:
            # IRS: PVBP는 DV01 관행 (receive-fixed=양수, pay-fixed=음수)
            # MTM = pvbp * (-shock_bp)  — 채권과 동일 공식
            if current_date and _is_matured(p, current_date):
                continue
            shock_bp = get_position_shock_bp(p, shock_mode, shock_type, base_shock_bp, shock_curves, multiplier, t)
            aging = 1.0 if shock_type == "step" else max(0.0, initial_remaining - t) / initial_remaining
            total += initial_pvbp * aging * (-shock_bp)

    return total


def calculate_daily_carry(
    positions: list[FrontendPosition],
    shock_mode: str,
    shock_type: str,
    base_shock_bp: float,
    shock_curves: FrontendShockCurves | None,
    active_funding_rate: float,
    multiplier: float,
    t: int,
    current_date: date | None = None,
) -> float:
    total = 0.0
    for p in positions:
        if p.bondType == "swap":
            continue  # IRS carry는 FM 엔진(irs_fm_carry)이 전담
        initial_remaining = max(float(p.remainingDays or 0), 0.0)
        matured = (current_date and _is_matured(p, current_date)) or (initial_remaining > 0 and t >= initial_remaining)
        if matured:
            # 조달의 연속성: 만기 후에도 Notional에 대한 Funding Cost 유지
            total -= (p.notional or 0.0) * active_funding_rate / 365.0
        else:
            shock_bp   = get_position_shock_bp(p, shock_mode, shock_type, base_shock_bp, shock_curves, multiplier, t)
            eval_amt   = p.evaluationAmount or 0.0
            # 금리 경로에 따라 채권 운용수익률도 상승 (carry_rate = mtmYield + 경로상 bp 변동)
            # 조달금리(active_funding_rate)는 금통위 이벤트 시 BOK bp만큼 이미 상승 반영됨
            # → 두 효과가 서로 상쇄되어 순 carry 변화는 (금리경로 - BOK 인상) 차이만큼
            carry_rate = (p.mtmYield or 0.0) + shock_bp / 100.0
            total += (eval_amt * (carry_rate / 100.0)) / 365.0 - (eval_amt * active_funding_rate) / 365.0
    return total


def calc_dynamic_funding_rate(base_rate: float, funding_events: list[dict], current_date: date) -> float:
    total = base_rate or 0.0
    for ev in funding_events:
        try:
            if date.fromisoformat(ev.get("date", "")) <= current_date:
                total += ev.get("shiftBp", 0) / 10000.0
        except Exception:
            pass
    return total


# ── 4가지 결과 산출 함수 ──────────────────────────────────────────────────────

def _build_irs_shock_curve(
    shock_mode: str,
    base_shock_bp: float,
    shock_curves: FrontendShockCurves | None,
) -> list[tuple[float, float]]:
    """IRS FM용 (tenor_years, shock_bp) 충격 커브 구성.
    평행이동: [(0, bp), (30, bp)] 플랫 커브.
    비평행이동: swapCurve [{t, val}] → [(t, val), ...] 변환.

    ※ swapCurve.val은 프론트엔드에서 이미 bp 절댓값(baseShockBp + irsSpread)으로 전달됨.
       base_shock_bp를 곱하면 이중 스케일 오류이므로 val을 그대로 사용한다.
       (simulate()에서 irs_shock_curve_prebuilt가 항상 주입되므로 이 함수는 fallback 경로)
    """
    if shock_mode == "parallel" or not shock_curves or not shock_curves.swapCurve:
        return [(0.0, base_shock_bp), (30.0, base_shock_bp)]
    parsed = [
        (float(p.get("t", 0)), float(p.get("val", 0)))  # val = bp 절댓값, 곱셈 불필요
        for p in shock_curves.swapCurve
        if float(p.get("t", 0)) > 0
    ]
    return parsed if parsed else [(0.0, base_shock_bp), (30.0, base_shock_bp)]


def build_chart_data(
    positions: list[FrontendPosition],
    shock_curves: FrontendShockCurves | None,
    funding_rate: float,
    funding_events: list[dict],
    sim_days: int,
    shock_type: str,
    shock_mode: str,
    base_shock_bp: float,
    base_date_str: str,
    irs_curves: list[dict] | None = None,
    irs_shock_curve_prebuilt: list[tuple[float, float]] | None = None,
    custom_path: list[dict] | None = None,
) -> tuple[list[dict], dict]:
    try:
        base_date = date.fromisoformat(base_date_str)
    except Exception:
        base_date = date.today()

    chart_data: list[dict] = []
    cumulative_bond_carry = 0.0   # 채권 캐리 + 만기 재투자 수익
    cumulative_irs_carry  = 0.0   # IRS 일별 캐리 누적
    break_even_day = -1
    is_broken_even = False

    # 만기 채권을 재투자 Cash Pool로 추적
    bond_positions = [p for p in positions if p.bondType != "swap"]
    irs_positions  = [p for p in positions if p.bondType == "swap"]

    # ── IRS FM(Full Revaluation) 경로 사전 계산 ─────────────────────────────
    par_rates       = qe.parse_irs_curves(irs_curves or [])
    irs_fm_mtm      = np.zeros(sim_days + 1)   # 포트폴리오 합산 MTM 궤적
    irs_fm_carry    = np.zeros(sim_days + 1)   # FM 파생 일별 캐리 (리픽싱 비선형 포함)
    irs_shock_curve = (
        irs_shock_curve_prebuilt
        if irs_shock_curve_prebuilt is not None
        else _build_irs_shock_curve(shock_mode, base_shock_bp, shock_curves)
    )
    # BOK 이벤트 당일 KRD 재계산용 — 쇼크커브 numpy 배열로 미리 변환
    _irs_sc_t  = np.array([_st for _st, _ in irs_shock_curve], dtype=float) if irs_shock_curve else np.array([0.0, 30.0])
    _irs_sc_bp = np.array([_sb for _, _sb in irs_shock_curve], dtype=float) if irs_shock_curve else np.array([0.0,  0.0])
    irs_settlement_events: list[dict] = []
    _base_dt = None
    try:
        _base_dt = date.fromisoformat(base_date_str[:10]) if base_date_str else None
    except Exception:
        pass

    for i, p in enumerate(irs_positions):
        t_mat = max(float(p.remainingDays or 0) / 365.0, 1 / 365)
        if p.nextFixingDate:
            try:
                nfd   = date.fromisoformat(str(p.nextFixingDate)[:10])
                ref   = date.fromisoformat(base_date_str[:10])
                t_next = max((nfd - ref).days, 1) / 365.0
            except Exception:
                t_next = 0.25
        else:
            t_next = t_mat * 0.1 if t_mat < 0.25 else 0.25
        t_next = max(min(t_next, t_mat), 1.0 / 365.0)

        try:
            mtm_arr, _, carry_arr, metrics, *_ = qe.simulate_irs_path_fm(
                par_rates              = par_rates,
                notional               = p.notional or 0.0,
                fixed_rate_pct         = p.couponRate or 0.0,
                direction              = int(p.direction or 1),
                t_maturity             = t_mat,
                t_next_payment         = t_next,
                current_float_rate_pct = p.currentFloatRate or 0.0,
                sector                 = p.sector or "IRS",
                shock_curve            = irs_shock_curve,
                days_to_simulate       = sim_days,
                shock_type             = shock_type,
                base_date_str          = base_date_str,
            )
            irs_fm_mtm   += mtm_arr
            irs_fm_carry += carry_arr
            # 정산 이벤트 수집 (scf_s 배열에서 0이 아닌 날 = 리픽싱 정산일)
            scf_arr = metrics.get("scf_s", [])
            for day_idx, scf in enumerate(scf_arr):
                if day_idx > 0 and abs(float(scf)) > 1:
                    event_date = (_base_dt + timedelta(days=day_idx)).isoformat() if _base_dt else None
                    irs_settlement_events.append({
                        "day":          day_idx,
                        "date":         event_date,
                        "positionName": getattr(p, "name", "") or getattr(p, "id", ""),
                        "positionId":   getattr(p, "id", ""),
                        "notional":     p.notional or 0,
                        "direction":    int(p.direction or 1),
                        "fixedRate":    p.couponRate or 0,
                        "settledCf":    round(float(scf)),
                    })
        except Exception as e:
            import traceback as _tb
            print(f"=== [CRITICAL] 엔진 크래시 상세 추적 ({getattr(p, 'id', '')}) ===")
            _tb.print_exc()
            raise ValueError(f"FM Engine Crash ({getattr(p, 'id', '')}): {e}") from e

    # 커스텀 경로 사전 처리 (웨이포인트 기반 factor 보간)
    _sorted_cp = sorted(
        [{"day": int(p.get("day", 0)), "bp": float(p.get("bp", 0))} for p in (custom_path or [])],
        key=lambda x: x["day"],
    ) if custom_path else []

    def _factor(t: int) -> float:
        if _sorted_cp and base_shock_bp != 0:
            if t <= _sorted_cp[0]["day"]:
                return _sorted_cp[0]["bp"] / base_shock_bp
            if t >= _sorted_cp[-1]["day"]:
                return _sorted_cp[-1]["bp"] / base_shock_bp
            for i in range(len(_sorted_cp) - 1):
                lo, hi = _sorted_cp[i], _sorted_cp[i + 1]
                if lo["day"] <= t <= hi["day"]:
                    if hi["day"] == lo["day"]:
                        return lo["bp"] / base_shock_bp
                    r = (t - lo["day"]) / (hi["day"] - lo["day"])
                    return (lo["bp"] + r * (hi["bp"] - lo["bp"])) / base_shock_bp
        return (t / sim_days) if shock_type == "ramp" else (1.0 if t > 0 else 0.0)

    # 단기 이벤트 계단 함수: funding_events 날짜 → D+N 변환
    try:
        _short_evts = sorted(
            [
                {
                    "day": (date.fromisoformat(ev["date"]) - base_date).days,
                    "bp":  float(ev.get("shiftBp", 0)),
                }
                for ev in (funding_events or [])
                if ev.get("date") and 0 <= (date.fromisoformat(ev["date"]) - base_date).days <= sim_days
            ],
            key=lambda x: x["day"],
        )
        _cum_short = sum(e["bp"] for e in _short_evts)
    except Exception:
        _short_evts = []
        _cum_short = 0.0

    def _short_factor(t: int) -> float:
        """잔존 1Y 미만 채권용: BOK 이벤트 누적 변동 기준 정규화 계단 함수."""
        if not _short_evts or _cum_short == 0:
            return _factor(t)
        cum_t = sum(e["bp"] for e in _short_evts if e["day"] <= t)
        return cum_t / _cum_short

    def _get_bond_zone(p: FrontendPosition, day: int) -> str:
        cr = max(float(p.remainingDays or 1) - day, 0.0)
        r = cr / 365.0
        if r < 0.25: return "short"
        if r < 1.0:  return "blend"
        return "long"

    for t in range(sim_days + 1):
        current_date = base_date + timedelta(days=t)
        multiplier = _factor(t)
        short_mult  = _short_factor(t)
        active_rate = calc_dynamic_funding_rate(funding_rate, funding_events, current_date)

        # 채권: 기존 선형 MTM / IRS: FM 결과 직접 사용 (내부에서 이미 ramp/step 적용)
        bond_mtm  = calculate_daily_mtm(bond_positions, shock_mode, shock_type, base_shock_bp, shock_curves, multiplier, t, current_date, short_mult)
        irs_mtm_t = float(irs_fm_mtm[t])

        # BOK 이벤트 당일: 구간별(3M미만/3M~1Y/1Y이상) MTM 변화 분해 (검증용)
        bok_breakdown = None
        if _short_evts and t > 0 and short_mult != _short_factor(t - 1):
            prev_mult_bd = _factor(t - 1)
            prev_sf_bd   = _short_factor(t - 1)
            prev_date_bd = current_date - timedelta(days=1)
            bd: dict[str, object] = {}
            for zone_name in ("short", "blend", "long"):
                z_cur  = [p for p in bond_positions if p.bondType != "swap" and _get_bond_zone(p, t)     == zone_name]
                z_prev = [p for p in bond_positions if p.bondType != "swap" and _get_bond_zone(p, t - 1) == zone_name]
                cur_m  = calculate_daily_mtm(z_cur,  shock_mode, shock_type, base_shock_bp, shock_curves, multiplier,    t,     current_date, short_mult)  if z_cur  else 0.0
                prev_m = calculate_daily_mtm(z_prev, shock_mode, shock_type, base_shock_bp, shock_curves, prev_mult_bd, t - 1, prev_date_bd, prev_sf_bd) if z_prev else 0.0
                # 구간 현재 PVBP 합산 (에이징 반영) — 암묵적 bp 역산용
                zone_pvbp = sum(
                    (p.pvbp or 0.0) * max(float(p.remainingDays or 1) - t, 0.0) / max(float(p.remainingDays or 1), 1.0)
                    for p in z_cur
                )
                bd[f"{zone_name}Delta"] = round(cur_m - prev_m)
                bd[f"{zone_name}Pvbp"]  = round(zone_pvbp)

            # IRS KRD 구간별 분해: BOK 이벤트 당일 에이징된 par커브로 KRD 재계산
            # 단기(1D/3M): BOK 정책금리 직결 → _bok_event_bp 그대로 사용
            # 장기(1Y+):  IRS FM은 항상 linear ramp(factor=day/sim_days) 사용
            #              채권 커스텀 경로(_factor)와 독립적 → IRS 쇼크 커브 × ramp 증분
            _bok_event_bp  = sum(e["bp"] for e in _short_evts if e["day"] == t)
            _irs_ramp_step = 1.0 / max(sim_days, 1)  # IRS daily ramp 증분 (1/sim_days)
            _KRD_PAIRS = [
                ("1D", 1/365), ("3M", 0.25), ("6M", 0.5),  ("9M", 0.75),
                ("1Y", 1.0),   ("1.5Y", 1.5), ("2Y", 2.0), ("3Y", 3.0),
                ("4Y", 4.0),   ("5Y", 5.0),  ("7Y", 7.0),  ("10Y", 10.0),
            ]
            _irs_1p = _irs_3p = _irs_bp = _irs_lp = 0.0  # PVBP 합산
            _irs_1d = _irs_3d = _irs_bd = _irs_ld = 0.0  # P&L 합산
            # BOK 이벤트 당일 shocked par 커브 (IRS는 linear ramp)
            _fac_irs = t / max(sim_days, 1)
            _par_t   = [(tau, r + float(np.interp(tau, _irs_sc_t, _irs_sc_bp)) * _fac_irs * 1e-4)
                        for tau, r in par_rates]
            _FLOAT_Q = 0.25  # 분기 픽싱 표준
            for _p in irs_positions:
                _t_mat_0 = max(float(_p.remainingDays or 0) / 365.0, 1.0/365.0)
                _t_mat_t = max(_t_mat_0 - t / 365.0, 1.0/365.0)
                if _t_mat_t < 2.0/365.0:   # 사실상 만기 → 스킵
                    continue
                # 에이징된 다음 변동일 (backward-from-maturity 분기 스케줄)
                # t_mat에서 float_freq씩 역산 → 가장 가까운 미래 변동일
                _k_fl    = int(_t_mat_t / _FLOAT_Q)  # floor
                _t_nxt_t = _t_mat_t - _k_fl * _FLOAT_Q
                if _t_nxt_t < 1.0/365.0:   # 만기가 정확히 변동일이면 다음 회차
                    _t_nxt_t = _FLOAT_Q
                _t_nxt_t = max(min(_t_nxt_t, _t_mat_t), 1.0/365.0)
                try:
                    _krd = qe.compute_irs_krd_map(
                        par_rates              = _par_t,
                        notional               = _p.notional or 0.0,
                        fixed_rate_pct         = _p.couponRate or 0.0,
                        direction              = int(_p.direction or 1),
                        t_maturity             = _t_mat_t,
                        t_next_payment         = _t_nxt_t,
                        current_float_rate_pct = _p.currentFloatRate or 0.0,
                        sector                 = _p.sector or "IRS",
                    )
                except Exception:
                    # 재계산 실패 시 만기 비율로 t=0 KRD를 1차 근사 스케일링
                    # (정적 krdMap을 그대로 쓰면 모든 BOK 이벤트에서 동일 값이 나옴)
                    _age_scale = _t_mat_t / max(_t_mat_0, 1.0/365.0)
                    _krd = {k: v * _age_scale for k, v in (_p.krdMap or {}).items()}
                for _tn, _ty in _KRD_PAIRS:
                    _kv = _krd.get(_tn, 0.0) or 0.0
                    if abs(_kv) < 1:
                        continue
                    # 해당 테너의 IRS ramp 일별 증분: 쇼크 커브에서 τ별 크기 보간 × (1/sim_days)
                    _irs_d_bp = float(np.interp(_ty, _irs_sc_t, _irs_sc_bp)) * _irs_ramp_step
                    if _ty < 0.1:         # 1D — BOK 정책금리 직결
                        _irs_1p += _kv;  _irs_1d -= _kv * _bok_event_bp
                    elif _ty <= 0.25:     # 3M — BOK 직결
                        _irs_3p += _kv;  _irs_3d -= _kv * _bok_event_bp
                    elif _ty <= 1.0:      # 3M~1Y — BOK ↔ IRS ramp 선형 블렌드
                        _w   = (_ty - 0.25) / 0.75
                        _dbp = _bok_event_bp * (1 - _w) + _irs_d_bp * _w
                        _irs_bp += _kv;  _irs_bd -= _kv * _dbp
                    else:                 # 1Y이상 — IRS linear ramp 기준 (채권 커스텀 경로와 무관)
                        _irs_lp += _kv;  _irs_ld -= _kv * _irs_d_bp
            # 블렌드/장기 대표 변동폭: IRS 쇼크 커브의 5Y 기준 × ramp 증분
            _irs_long_d_bp = float(np.interp(5.0, _irs_sc_t, _irs_sc_bp)) * _irs_ramp_step
            _blend_mid_bp  = round((_bok_event_bp * 0.5 + _irs_long_d_bp * 0.5) * 10) / 10
            bd.update({
                "irs1dPvbp":    round(_irs_1p), "irs1dDelta":    round(_irs_1d),
                "irs3mPvbp":    round(_irs_3p), "irs3mDelta":    round(_irs_3d),
                "irsBlendPvbp": round(_irs_bp), "irsBlendDelta": round(_irs_bd),
                "irsLongPvbp":  round(_irs_lp), "irsLongDelta":  round(_irs_ld),
                "bokShortBp":   round(_bok_event_bp    * 10) / 10,  # BOK 이벤트 실제 bp
                "bokBlendBp":   _blend_mid_bp,                        # IRS 블렌드 중간점
                "bokLongBp":    round(_irs_long_d_bp   * 10) / 10,  # IRS 5Y 기준 장기 변동폭
            })
            bok_breakdown = bd
        # 일별 캐리: 채권만 calculate_daily_carry, IRS는 FM 엔진 리턴 값 사용 (리픽싱 비선형 반영)
        bond_carry  = calculate_daily_carry(bond_positions, shock_mode, shock_type, base_shock_bp, shock_curves, active_rate, multiplier, t, current_date)
        irs_carry_t = float(irs_fm_carry[t])
        # 만기 채권의 재투자 수익: Notional 기준으로 Funding Cost와 정확히 상쇄
        reinvested_cash = sum(
            p.notional or 0.0
            for p in bond_positions
            if float(p.remainingDays or 0) <= t
        )
        daily_cash_return = reinvested_cash * active_rate / 365.0

        # Day 0은 모든 손익이 0에서 출발 — Day 1부터 캐리 누적
        if t > 0:
            cumulative_bond_carry += (bond_carry or 0.0) + daily_cash_return
            cumulative_irs_carry  += (irs_carry_t or 0.0)

        # 스왑손익 = IRS MTM + 누적 IRS 캐리
        swap_pnl  = irs_mtm_t + cumulative_irs_carry
        total_pnl = bond_mtm + cumulative_bond_carry + swap_pnl
        total_mtm = bond_mtm + irs_mtm_t   # BEP 체크용

        if total_pnl >= 0 and total_mtm < 0 and not is_broken_even:
            break_even_day = t
            is_broken_even = True

        entry: dict = {
            "day": t,
            "mtmPnL":         round(bond_mtm)             if bond_mtm             else 0,
            "cumulativeCarry": round(cumulative_bond_carry) if cumulative_bond_carry else 0,
            "swapPnL":        round(swap_pnl)              if swap_pnl             else 0,
            "totalPnL":       round(total_pnl)             if total_pnl            else 0,
        }
        if bok_breakdown:
            entry["bokBreakdown"] = bok_breakdown
        chart_data.append(entry)

    last = chart_data[-1] if chart_data else {}
    summary = {
        "finalMTM":   last.get("mtmPnL", 0),
        "finalCarry": last.get("cumulativeCarry", 0),
        "finalSwap":  last.get("swapPnL", 0),
        "finalTotal": last.get("totalPnL", 0),
        "breakEvenDay": break_even_day,
    }

    return chart_data, summary, irs_settlement_events


def build_pvbp_sensitivity(positions: list[FrontendPosition]) -> list[dict]:
    sectors = ["국고채", "통안채", "특은채", "시은채", "공사채", "여전채", "회사채", "IRS", "OIS"]
    tenors = ["1D", "3M", "6M", "9M", "1Y", "1.5Y", "2Y", "3Y", "4Y", "5Y", "7Y", "10Y"]

    rows = [
        {"sector": p.sector, **{t: float(p.krdMap.get(t) or 0) for t in tenors}}
        for p in positions
    ]
    df = pd.DataFrame(rows) if rows else pd.DataFrame(columns=["sector"] + tenors)

    result: list[dict] = []
    col_totals = {t: 0.0 for t in tenors}

    for sector in sectors:
        sub = df[df["sector"] == sector][tenors] if not df.empty and sector in df["sector"].values else pd.DataFrame(columns=tenors)
        row_vals = sub.sum().to_dict() if not sub.empty else {t: 0.0 for t in tenors}
        row_total = sum(row_vals.values())
        row_vals["합계"] = row_total
        for t in tenors:
            col_totals[t] = col_totals.get(t, 0.0) + row_vals.get(t, 0.0)
        result.append({"sector": sector, "tenors": row_vals, "total": row_total})

    grand_total = sum(col_totals.values())
    col_totals["합계"] = grand_total
    result.append({"sector": "합계", "tenors": col_totals, "total": grand_total})
    return result


def build_book_daily_pnl(
    positions: list[FrontendPosition],
    shock_curves: FrontendShockCurves | None,
    funding_rate: float,
) -> list[dict]:
    books = list(dict.fromkeys(p.book for p in positions))
    daily_pnls: list[dict] = []

    for book_name in books:
        bp_list = [p for p in positions if p.book == book_name]
        daily_carry = funding_cost = bond_val = swap_val = swap_theta = 0.0

        for p in bp_list:
            if p.bondType == "swap":
                delta = 0.0
                if p.krdMap and shock_curves and shock_curves.swapCurve:
                    for tenor, pvbp_val in p.krdMap.items():
                        sbp = interpolate_curve_shift(parse_tenor_to_years(tenor), shock_curves.swapCurve)
                        # IRS PVBP는 DV01 관행: receive-fixed=양수, pay-fixed=음수
                        # MTM = pvbp * (-sbp)  (채권과 동일)
                        delta += float(pvbp_val or 0) * (-sbp)
                swap_val += delta
                swap_theta += p.expectedThetaPnL or 0.0
            else:
                eval_amt = p.evaluationAmount or 0.0
                daily_carry += (eval_amt * ((p.mtmYield or 0.0) / 100.0)) / 365.0
                funding_cost -= (eval_amt * funding_rate) / 365.0
                curve_key = get_sector_curve_key(p.sector)
                target: list[dict] = []
                if shock_curves:
                    target = shock_curves.bondCurves.get(curve_key) or shock_curves.bondCurves.get("국채") or []
                sbp = interpolate_curve_shift((p.remainingDays or 0) / 365.0, target)
                bond_val += (p.pvbp or 0.0) * (-sbp)

        total = daily_carry + funding_cost + bond_val + swap_val + swap_theta
        daily_pnls.append({
            "bookName": book_name,
            "dailyCarry": round(daily_carry),
            "fundingCost": round(funding_cost),
            "bondValuation": round(bond_val),
            "swapValuation": round(swap_val),
            "swapThetaPnL": round(swap_theta),
            "totalDailyPnL": round(total),
        })

    if daily_pnls:
        daily_pnls.append({
            "bookName": "Total",
            "dailyCarry": sum(d["dailyCarry"] for d in daily_pnls),
            "fundingCost": sum(d["fundingCost"] for d in daily_pnls),
            "bondValuation": sum(d["bondValuation"] for d in daily_pnls),
            "swapValuation": sum(d["swapValuation"] for d in daily_pnls),
            "swapThetaPnL": sum(d["swapThetaPnL"] for d in daily_pnls),
            "totalDailyPnL": sum(d["totalDailyPnL"] for d in daily_pnls),
        })
    return daily_pnls


# ── 엔드포인트 ────────────────────────────────────────────────────────────────

@app.get("/api/hello")
def hello():
    return {"message": "Hello World"}


def enrich_irs_pvbp(
    positions: list[FrontendPosition],
    irs_curves: list[dict],
    base_date_str: str = "2026-01-01",
) -> list[FrontendPosition]:
    """
    IRS 포지션의 pvbp / krdMap / expectedThetaPnL을 quant_engine으로 산출하여 채워 반환.

    irsCurves가 비어있으면 flat 3% 커브를 fallback으로 사용.
    채권 포지션은 그대로 통과.
    """
    par_rates = qe.parse_irs_curves(irs_curves)

    enriched: list[FrontendPosition] = []
    for p in positions:
        if p.bondType != "swap":
            enriched.append(p)
            continue

        t_mat = max(float(p.remainingDays or 0) / 365.0, 1 / 365)
        # 다음 변동 지급일: nextFixingDate 필드 우선 사용, 없으면 3개월 근사
        if p.nextFixingDate:
            try:
                nfd = date.fromisoformat(str(p.nextFixingDate)[:10])
                ref = date.fromisoformat(str(base_date_str)[:10])
                days_to_next = max((nfd - ref).days, 1)
                t_next = days_to_next / 365.0
            except Exception:
                t_next = 0.25
        else:
            t_next = t_mat * 0.1 if t_mat < 0.25 else 0.25
        t_next = max(min(t_next, t_mat), 1.0 / 365.0)

        pvbp = qe.compute_irs_pvbp(
            par_rates          = par_rates,
            notional           = p.notional or 0.0,
            fixed_rate_pct     = p.couponRate or 0.0,       # % 단위
            direction          = int(p.direction or 1),
            t_maturity         = t_mat,
            t_next_payment     = t_next,
            current_float_rate_pct = p.currentFloatRate or 0.0,  # % 단위
            sector             = p.sector or "IRS",
        )
        krd = qe.compute_irs_krd_map(
            par_rates          = par_rates,
            notional           = p.notional or 0.0,
            fixed_rate_pct     = p.couponRate or 0.0,
            direction          = int(p.direction or 1),
            t_maturity         = t_mat,
            t_next_payment     = t_next,
            current_float_rate_pct = p.currentFloatRate or 0.0,
            sector             = p.sector or "IRS",
        )
        theta = qe.compute_irs_theta(
            par_rates          = par_rates,
            notional           = p.notional or 0.0,
            fixed_rate_pct     = p.couponRate or 0.0,
            direction          = int(p.direction or 1),
            t_maturity         = t_mat,
            t_next_payment     = t_next,
            current_float_rate_pct = p.currentFloatRate or 0.0,
            sector             = p.sector or "IRS",
            base_date          = date.fromisoformat(base_date_str[:10]),
        )

        # Pydantic 모델은 immutable이므로 copy(update=...) 사용
        enriched.append(p.model_copy(update={
            "pvbp": pvbp,
            "krdMap": krd,
            "expectedThetaPnL": theta,
        }))

    return enriched


@app.post("/api/simulate")
def simulate(req: SimulateRequest):
    # ── Shock Curve 명시적 빌드 (엔드포인트 레벨) ────────────────────────────
    _swap_raw = req.shockCurves.swapCurve if req.shockCurves else []
    if req.shockMode == "matrix" and _swap_raw:
        _parsed = [
            (float(p.get("t", 0)), float(p.get("val", 0)))
            for p in _swap_raw
            if float(p.get("t", 0)) > 0
        ]
        irs_shock_curve = _parsed if _parsed else [(0.0, req.baseShockBp), (30.0, req.baseShockBp)]
    else:
        irs_shock_curve = [(0.0, req.baseShockBp), (30.0, req.baseShockBp)]

    # ── IRS 포지션에 백엔드 프라이싱 결과 주입 ────────────────────────────────
    try:
        positions = enrich_irs_pvbp(req.positions, req.irsCurves, req.baseDate)
    except Exception as _e:
        import traceback as _tb
        print(f"[CRITICAL] enrich_irs_pvbp 실패: {_e}")
        print(_tb.format_exc())
        raise

    funding_events = req.fundingEvents or (req.shockCurves.fundingEvents if req.shockCurves else [])

    chart_data, summary, irs_settlement_events = build_chart_data(
        positions=positions,
        shock_curves=req.shockCurves,
        funding_rate=req.fundingRate,
        funding_events=funding_events,
        sim_days=req.simDays,
        shock_type=req.shockType,
        shock_mode=req.shockMode,
        base_shock_bp=req.baseShockBp,
        base_date_str=req.baseDate,
        irs_curves=req.irsCurves,
        irs_shock_curve_prebuilt=irs_shock_curve,
        custom_path=req.customPath or None,
    )
    pvbp_sensitivity = build_pvbp_sensitivity(positions)
    # bookDailyPnL: 당일 실제 금리변동만 반영. dailyShockCurves 없으면 shockCurves로 fallback
    daily_curves = req.dailyShockCurves if req.dailyShockCurves is not None else req.shockCurves
    book_daily_pnls = build_book_daily_pnl(positions, daily_curves, req.fundingRate)

    return {
        "status": "ok",
        "chartData": chart_data,
        "summary": summary,
        "pvbpSensitivity": pvbp_sensitivity,
        "bookDailyPnLs": book_daily_pnls,
        "irsSettlementEvents": irs_settlement_events,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
