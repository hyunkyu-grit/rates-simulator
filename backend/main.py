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

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    os.environ.get("FRONTEND_URL", ""),  # Render 환경변수로 Vercel URL 주입
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o for o in ALLOWED_ORIGINS if o],
    allow_credentials=True,
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

            if shock_mode == "parallel":
                shock_bp = (base_shock_bp or 0.0) * multiplier
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
                    shock_bp = interpolate_curve_shift(current_remaining / 365.0, target) * multiplier

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
        initial_remaining = max(float(p.remainingDays or 0), 0.0)
        matured = (current_date and _is_matured(p, current_date)) or (initial_remaining > 0 and t >= initial_remaining)

        if p.bondType != "swap":
            if matured:
                # 조달의 연속성: 만기 후에도 Notional에 대한 Funding Cost 유지
                total -= (p.notional or 0.0) * active_funding_rate / 365.0
            else:
                shock_bp = get_position_shock_bp(p, shock_mode, shock_type, base_shock_bp, shock_curves, multiplier, t)
                eval_amt = p.evaluationAmount or 0.0
                carry_rate = (p.mtmYield or 0.0) + shock_bp / 100.0
                total += (eval_amt * (carry_rate / 100.0)) / 365.0 - (eval_amt * active_funding_rate) / 365.0
        else:
            continue  # IRS carry는 FM 엔진(irs_fm_carry)이 전담 — static theta 이중 계산 방지
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
    """
    if shock_mode == "parallel" or not shock_curves or not shock_curves.swapCurve:
        return [(0.0, base_shock_bp), (30.0, base_shock_bp)]
    parsed = [
        (float(p.get("t", 0)), float(p.get("val", 0)))
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
) -> tuple[list[dict], dict]:
    try:
        base_date = date.fromisoformat(base_date_str)
    except Exception:
        base_date = date.today()

    chart_data: list[dict] = []
    cumulative_carry = 0.0
    break_even_day = -1
    is_broken_even = False

    # 만기 채권을 재투자 Cash Pool로 추적
    bond_positions = [p for p in positions if p.bondType != "swap"]
    irs_positions  = [p for p in positions if p.bondType == "swap"]

    # ── IRS FM(Full Revaluation) 경로 사전 계산 ─────────────────────────────
    par_rates       = qe.parse_irs_curves(irs_curves or [])
    irs_fm_mtm      = np.zeros(sim_days + 1)   # 포트폴리오 합산 MTM 궤적
    irs_fm_carry    = np.zeros(sim_days + 1)   # FM 파생 일별 캐리 (리픽싱 비선형 포함)
    # Bug 1: 포트폴리오 합산 일별 NPV / 정산 CF 배열
    port_npv_s      = np.zeros(sim_days + 1)
    port_npv_b      = np.zeros(sim_days + 1)
    port_scf_b      = np.zeros(sim_days + 1)
    port_scf_s      = np.zeros(sim_days + 1)
    first_pos_audit_rows: list[dict] = []      # 포트폴리오 CSV용 첫 번째 종목 상세 데이터
    print(f"[BUILD] IRS 종목 {len(irs_positions)}개 시뮬레이션 시작 (bond≈{len(bond_positions)}개)")
    irs_shock_curve = (
        irs_shock_curve_prebuilt
        if irs_shock_curve_prebuilt is not None
        else _build_irs_shock_curve(shock_mode, base_shock_bp, shock_curves)
    )

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

        print(f"  [T_NEXT] 종목 {i+1} id={getattr(p,'id','')} "
              f"nextFixingDate={p.nextFixingDate!r} "
              f"remainingDays={p.remainingDays} t_mat={t_mat:.4f}Y "
              f"→ t_next={t_next:.4f}Y ({round(t_next*365)}일)")
        try:
            mtm_arr, _, carry_arr, metrics, pos_audit = qe.simulate_irs_path_fm(
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
                audit                  = (i == 0 and sim_days > 0),
            )
            irs_fm_mtm   += mtm_arr
            irs_fm_carry += carry_arr
            # Bug 1: 포트폴리오 NPV / CF 합산 (모든 종목 += 로 누적)
            port_npv_s   += metrics["npv_s"]
            port_npv_b   += metrics["npv_b"]
            port_scf_b   += metrics["scf_b"]
            port_scf_s   += metrics["scf_s"]
            if i == 0:
                first_pos_audit_rows = pos_audit   # 첫 번째 종목 커브/금리 상세 데이터 보존
            print(f"  [BUILD] 종목 {i+1}/{len(irs_positions)} id={getattr(p, 'id', '')} "
                  f"notional={p.notional:,.0f} dir={p.direction} → 최종 MTM={mtm_arr[-1]:,.0f}")
        except Exception as e:
            import traceback as _tb
            print(f"=== [CRITICAL] 엔진 크래시 상세 추적 ({getattr(p, 'id', '')}) ===")
            _tb.print_exc()
            raise ValueError(f"FM Engine Crash ({getattr(p, 'id', '')}): {e}") from e

    for t in range(sim_days + 1):
        current_date = base_date + timedelta(days=t)
        multiplier = (t / sim_days) if shock_type == "ramp" else (1.0 if t > 0 else 0.0)
        active_rate = calc_dynamic_funding_rate(funding_rate, funding_events, current_date)

        # 채권: 기존 선형 MTM / IRS: FM 결과 직접 사용 (내부에서 이미 ramp/step 적용)
        bond_mtm  = calculate_daily_mtm(bond_positions, shock_mode, shock_type, base_shock_bp, shock_curves, multiplier, t, current_date)
        daily_mtm = bond_mtm + float(irs_fm_mtm[t])
        # 일별 캐리: 채권만 calculate_daily_carry, IRS는 FM 엔진 리턴 값 사용 (리픽싱 비선형 반영)
        bond_carry = calculate_daily_carry(bond_positions, shock_mode, shock_type, base_shock_bp, shock_curves, active_rate, multiplier, t, current_date)
        irs_carry_t = float(irs_fm_carry[t])
        daily_carry = bond_carry + irs_carry_t
        # 만기 체권의 재투자 수익: Notional 기준으로 Funding Cost와 정확히 상쿠
        reinvested_cash = sum(
            p.notional or 0.0
            for p in bond_positions
            if float(p.remainingDays or 0) <= t
        )
        daily_cash_return = reinvested_cash * active_rate / 365.0

        cumulative_carry += (daily_carry or 0.0) + daily_cash_return
        if abs(irs_carry_t) > 50_000_000 or abs(daily_cash_return) > 50_000_000:
            print(f"[CARRY-DIAG] Day {t}: irs_carry={irs_carry_t:,.0f}  "
                  f"bond_carry={bond_carry:,.0f}  cash_return={daily_cash_return:,.0f}  "
                  f"cum_carry={cumulative_carry:,.0f}")
        total_pnl = daily_mtm + cumulative_carry

        if total_pnl >= 0 and daily_mtm < 0 and not is_broken_even:
            break_even_day = t
            is_broken_even = True

        chart_data.append({
            "day": t,
            "mtmPnL": round(daily_mtm) if daily_mtm else 0,
            "cumulativeCarry": round(cumulative_carry) if cumulative_carry else 0,
            "totalPnL": round(total_pnl) if total_pnl else 0,
        })

    last = chart_data[-1] if chart_data else {}
    summary = {
        "finalMTM": last.get("mtmPnL", 0),
        "finalCarry": last.get("cumulativeCarry", 0),
        "finalTotal": last.get("totalPnL", 0),
        "breakEvenDay": break_even_day,
    }

    # ── 포트폴리오 합산 Audit CSV (종목별 덮어쓰기 없이, 시뮬레이션 종료 후 1회 저장) ──
    if sim_days > 0 and chart_data:
        try:
            from pathlib import Path

            # 포트폴리오 일별 요약 (좌측 콜럼: chart 3종 + 우측 콜럼: Bug 1 합산값)
            port_rows = []
            for row in chart_data:
                t = row["day"]
                port_rows.append({
                    "Day":                    t,
                    "Portfolio_MTM":          row["mtmPnL"],
                    "Portfolio_Cum_Carry":    row["cumulativeCarry"],
                    "Portfolio_Total":        row["totalPnL"],
                    # Bug 1: 모든 IRS 종목 합산된 포트폴리오 레벨 NPV / CF
                    "Port_NPV_Shocked":       round(float(port_npv_s[t])) if t < len(port_npv_s) else 0,
                    "Port_NPV_Base":          round(float(port_npv_b[t])) if t < len(port_npv_b) else 0,
                    "Port_Settled_CF_Base":   round(float(port_scf_b[t])) if t < len(port_scf_b) else 0,
                    "Port_Settled_CF_Shock":  round(float(port_scf_s[t])) if t < len(port_scf_s) else 0,
                    "Port_Daily_IRS_Carry":   round(float(irs_fm_carry[t])) if t < len(irs_fm_carry) else 0,
                    "Port_Daily_IRS_MTM":     round(float(irs_fm_mtm[t])) if t < len(irs_fm_mtm) else 0,
                })
            port_df = pd.DataFrame(port_rows)

            # 첫 번째 IRS 종목의 커브/금리 상세 콜럼만 병합 (포트폴리오 레벨 NPV/CF는 위에서 이미 포함)
            if first_pos_audit_rows:
                detail_df = pd.DataFrame(first_pos_audit_rows)
                # NPV/CF 콜럼은 포트폴리오 합산값으로 대체하므로 제외
                exclude = {"NPV_Shocked", "NPV_Base", "Settled_CF_Base",
                           "Settled_CF_Shock", "Cum_CF_Diff",
                           "Daily_FM_Carry", "Daily_Clean_MTM"}
                # "Day"는 detail_df.columns에 이미 존재 — 중복 삽입 금지
                curve_cols = [c for c in detail_df.columns if c not in exclude]
                audit_df = port_df.merge(detail_df[curve_cols], on="Day", how="left")
            else:
                audit_df = port_df

            out_path = Path(__file__).resolve().parent.parent / "fm_simulation_audit.csv"
            audit_df.to_csv(out_path, index=False, encoding="utf-8-sig")
            print(f"\n[AUDIT] ══ 포트폴리오 합산 Audit CSV 저장 완료 ══")
            print(f"[AUDIT] 경로: {out_path}")
            print(f"[AUDIT] {len(irs_positions)}개 IRS 종목 합산 | {len(audit_df)}행 | {len(audit_df.columns)}콜럼")
            print(audit_df[["Day","Portfolio_MTM","Portfolio_Cum_Carry",
                             "Port_NPV_Base","Port_Settled_CF_Base"]].head(5).to_string(index=False))
            if len(audit_df) > 5:
                print(f"... (이하 {len(audit_df)-5}행 생략 — 전체는 CSV 참조)\n")
        except Exception as _ae:
            print(f"[AUDIT] CSV 저장 실패 (시뮬레이션 결과는 정상): {_ae}")

    return chart_data, summary


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
    # ── [DEBUG] 엔드포인트 진입 즉시 확인 (가장 먼저 실행) ────────────────────
    print("\n" + "="*60)
    print("=== [DEBUG] /api/simulate 진입 ===")
    print(f"  positions={len(req.positions)}  simDays={req.simDays}")
    print(f"  shockMode={req.shockMode!r}  shockType={req.shockType!r}  baseShockBp={req.baseShockBp}")
    print(f"  irsCurves_len={len(req.irsCurves)}  shockCurves={req.shockCurves is not None}")

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

    parsed_shock_curve = {f"{t}Y": round(bp, 4) for t, bp in irs_shock_curve}
    print("=== [DEBUG] /api/simulate Parsed Shock ===", parsed_shock_curve)
    print(f"  swapCurve_raw_len={len(_swap_raw)}  irs_shock_curve_nodes={len(irs_shock_curve)}")
    print("="*60)

    # ── IRS 포지션에 백엔드 프라이싱 결과 주입 ────────────────────────────────
    try:
        positions = enrich_irs_pvbp(req.positions, req.irsCurves, req.baseDate)
    except Exception as _e:
        import traceback as _tb
        print(f"[CRITICAL] enrich_irs_pvbp 실패: {_e}")
        print(_tb.format_exc())
        raise

    funding_events = req.fundingEvents or (req.shockCurves.fundingEvents if req.shockCurves else [])

    chart_data, summary = build_chart_data(
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
    )
    pvbp_sensitivity = build_pvbp_sensitivity(positions)
    # bookDailyPnL: 당일 실제 금리변동만 반영. dailyShockCurves 없으면 shockCurves로 fallback
    daily_curves = req.dailyShockCurves if req.dailyShockCurves is not None else req.shockCurves
    book_daily_pnls = build_book_daily_pnl(positions, daily_curves, req.fundingRate)

    # ── DEBUG: IRS Raw Data 터미널 출력 ─────────────────────────────────────────
    irs_pos = [p for p in positions if p.bondType == "swap"]
    if irs_pos:
        print("\n[DEBUG /api/simulate] ── IRS Positions Raw Data ──────────────────")
        for p in irs_pos:
            print(f"  id={getattr(p,'id',None)} sector={p.sector} direction={p.direction} "
                  f"notional={p.notional} couponRate={p.couponRate}% "
                  f"currentFloatRate={p.currentFloatRate}%")
            print(f"    pvbp={p.pvbp:.0f}  krdMap={p.krdMap}")
        print("[DEBUG] ─────────────────────────────────────────────────────────\n")

    return {
        "status": "ok",
        "chartData": chart_data,
        "summary": summary,
        "pvbpSensitivity": pvbp_sensitivity,
        "bookDailyPnLs": book_daily_pnls,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
