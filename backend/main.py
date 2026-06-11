from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Literal
from datetime import date, timedelta
import pandas as pd

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
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


class FrontendShockCurves(BaseModel):
    bondCurves: dict[str, list[dict]] = {}  # {섹터키: [{t, val}, ...]}
    swapCurve: list[dict] = []
    fundingEvents: list[dict] = []


class SimulateRequest(BaseModel):
    positions: list[FrontendPosition]
    shockCurves: FrontendShockCurves | None = None
    fundingRate: float = 0.042
    fundingEvents: list[dict] = []
    simDays: int = 90
    shockType: str = "step"             # 'step' | 'ramp'
    shockMode: str = "parallel"         # 'parallel' | 'matrix'
    baseShockBp: float = 50.0
    baseDate: str = "2026-01-01"


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
            # IRS: 전체 PVBP 기준 aging 로직 유지
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
            if matured:
                continue  # IRS 만기: theta 정지
            total += (p.expectedThetaPnL or 0.0)
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
) -> tuple[list[dict], dict]:
    try:
        base_date = date.fromisoformat(base_date_str)
    except Exception:
        base_date = date.today()

    chart_data: list[dict] = []
    cumulative_carry = 0.0
    break_even_day = -1
    is_broken_even = False

    # 만기 체권을 재투자 Cash Pool로 추적
    bond_positions = [p for p in positions if p.bondType != "swap"]

    for t in range(sim_days + 1):
        current_date = base_date + timedelta(days=t)
        multiplier = (t / sim_days) if shock_type == "ramp" else (1.0 if t > 0 else 0.0)
        active_rate = calc_dynamic_funding_rate(funding_rate, funding_events, current_date)

        daily_mtm = calculate_daily_mtm(positions, shock_mode, shock_type, base_shock_bp, shock_curves, multiplier, t, current_date)
        daily_carry = calculate_daily_carry(positions, shock_mode, shock_type, base_shock_bp, shock_curves, active_rate, multiplier, t, current_date)

        # 만기 체권의 재투자 수익: Notional 기준으로 Funding Cost와 정확히 상쿠
        reinvested_cash = sum(
            p.notional or 0.0
            for p in bond_positions
            if float(p.remainingDays or 0) <= t
        )
        daily_cash_return = reinvested_cash * active_rate / 365.0

        cumulative_carry += (daily_carry or 0.0) + daily_cash_return
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


@app.post("/api/simulate")
def simulate(req: SimulateRequest):
    funding_events = req.fundingEvents or (req.shockCurves.fundingEvents if req.shockCurves else [])

    chart_data, summary = build_chart_data(
        positions=req.positions,
        shock_curves=req.shockCurves,
        funding_rate=req.fundingRate,
        funding_events=funding_events,
        sim_days=req.simDays,
        shock_type=req.shockType,
        shock_mode=req.shockMode,
        base_shock_bp=req.baseShockBp,
        base_date_str=req.baseDate,
    )
    pvbp_sensitivity = build_pvbp_sensitivity(req.positions)
    book_daily_pnls = build_book_daily_pnl(req.positions, req.shockCurves, req.fundingRate)

    return {
        "status": "ok",
        "chartData": chart_data,
        "summary": summary,
        "pvbpSensitivity": pvbp_sensitivity,
        "bookDailyPnLs": book_daily_pnls,
    }
