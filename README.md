# 📊 Fixed Income & Swap Portfolio PnL Simulator

> **현업 퀀트 데스크를 위한 채권·IRS 스왑 포트폴리오 Total Return 분석 및 시나리오 손익 예측 시스템**

---

## 🧭 프로젝트 소개

채권(국채, 은행채, 특은채, 여전채, 회사채) 및 IRS 스왑 포트폴리오의 **MTM(평가손익)** 과 **Carry(이자수익)** 를 통합하여 **Total Return** 을 실시간으로 분석하고, 다양한 금리 충격 시나리오 하에서 **손익 궤적(P&L Path)** 을 예측하는 퀀트 데스크용 시뮬레이터입니다.

엑셀로 관리되는 실무 데이터(포지션, 커브 변동표)를 그대로 업로드하면, 퀀트 엔진이 자동으로 파싱·계산하여 인터랙티브 차트와 요약 지표를 제공합니다.

---

## ✨ 주요 기능

### 1. 📂 다중 커브 Shift Matrix 파싱 및 프록시 매핑
- 엑셀 기반 **채권 변동표** / **스왑 변동표** 시트를 자동 파싱
- 국채, 은행채, 특은채(공사채), 카드채(여전채), 회사채 등 **섹터별 독립 충격 커브** 지원
- 섹터명 키워드 매핑으로 포지션을 가장 적합한 충격 커브에 **자동 프록시(Proxy)** 연결
- 선형 보간(Linear Interpolation)으로 임의 테너의 충격 bp 추출

### 2. 📐 동적 PVBP 감가 (KRD + Pull-to-Par)
- 잔존만기가 줄어들수록 PVBP가 감소하는 **Pull-to-Par(Aging Factor)** 효과를 수식으로 반영
- **Step 모드**: 즉각적인 금리 충격 → PVBP 고정, MTM 수평선 유지
- **Ramp 모드**: 점진적 금리 충격 → PVBP 동적 감소, 현실적인 MTM 곡선 재현
- KRD(Key Rate Duration) 버킷: `3M` ~ `10Y` + `30Y`(10년 초과 통합) 지원

### 3. 🏦 이벤트 드리븐 동적 캐리 (Event-Driven Dynamic Carry)
- **조달 변동표** 시트를 통해 특정 날짜(예: 금통위 기준금리 결정일)에 조달 금리가 **계단식(Step-up/down)** 으로 변동하는 이벤트를 등록
- 시뮬레이션 루프 내 `date-fns`를 활용한 날짜 기반 이벤트 처리
- 이벤트 적용 이후 날짜부터 **동적 조달 금리(activeFundingRate)** 가 자동 누적 반영되어 캐리 계산

### 4. 📈 시나리오 P&L 차트 및 BEP 분석
- MTM손익, 누적캐리, 총손익(Total Return) 3개 라인을 **Recharts** 로 인터랙티브하게 시각화
- **손익분기점(BEP)** 자동 탐지 및 차트 참조선 표시
- 병렬(Parallel) 충격 모드와 매트릭스(Matrix) 충격 모드 전환 지원

---

## 🛠️ 기술 스택

| 분류 | 기술 |
|---|---|
| **Framework** | [Next.js](https://nextjs.org/) (App Router) |
| **UI** | React, Tailwind CSS |
| **차트** | [Recharts](https://recharts.org/) |
| **엑셀 파싱** | [xlsx (SheetJS)](https://sheetjs.com/) |
| **날짜 처리** | [date-fns](https://date-fns.org/) |
| **언어** | TypeScript |

---

## 🗂️ 엑셀 입력 파일 구성

### 📋 포지션 파일 (통합 포트폴리오 파일)

단일 엑셀 파일에 아래 3종의 데이터 시트가 통합되어 있습니다.

#### 1) 채권 로데이터 (Bond Raw Data)
국채, 특은채, 은행채, 여전채, 회사채 등 채권 포지션 및 민감도 정보

| 열 | 내용 |
|---|---|
| `종목명` | 채권 종목명 및 섹터 식별자 |
| `펀드명` | 북(Book) 구분 |
| `결제장부수량(만)` | 액면 수량 |
| `평가금액` | 시가 평가금액 |
| `민평수익율` | MTM 기준 YTM |
| `듀레이션` | 수정듀레이션 |
| `잔존일수` | 만기까지 잔여 일수 |

#### 2) IRS 로데이터 (IRS Raw Data)
페이(Pay) / 리시브(Receive) 스왑 포지션 정보

| 열 | 내용 |
|---|---|
| `종목명` | IRS 포지션명 및 방향(Pay/Receive) 식별자 |
| `펀드명` | 북(Book) 구분 |
| `명목금액` | 스왑 명목원금 |
| `고정금리` | 계약 고정금리 (Fixed Rate) |
| `듀레이션` | 수정듀레이션 |
| `잔존일수` | 만기까지 잔여 일수 |

#### 3) IRS Par Rate (스왑 커브)
스왑 평가 및 캐리 계산의 베이스가 되는 테너별 Par Rate 커브 데이터

| 열 | 내용 |
|---|---|
| `테너` | 스왑 만기 테너 (예: `1Y`, `2Y`, `3Y`, `5Y`, `10Y`) |
| `Par Rate` | 해당 테너의 시장 고시 Par Rate (%) |

---

### 📉 금리변동표 파일 (Shift Matrix)
| 시트명 | 내용 |
|---|---|
| `채권 변동표` | 섹터별(열) × 테너별(행) 충격 bp |
| `스왑 변동표` | 테너별 IRS 스왑 충격 bp |
| `조달 변동표` | 날짜별 조달 금리 변동폭(bp) |

---

## 🚀 로컬 실행

```bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 접속 후, `/portfolio` 페이지로 이동하세요.

---

## 📁 프로젝트 구조

```
ytm-calculator/
├── app/
│   └── portfolio/
│       └── page.tsx             # 메인 대시보드 페이지
├── components/
│   ├── ExcelUploader.tsx        # 포지션 엑셀 파서 (채권 + IRS 스왑)
│   ├── ShiftMatrixUploader.tsx  # 금리변동표 파서 (다중 커브 + 조달 이벤트)
│   ├── ScenarioSimulator.tsx    # 시나리오 시뮬레이션 엔진 + 차트 UI
│   └── dashboard/
│       ├── PVBPTable.tsx        # KRD 민감도 테이블
│       ├── BookPnLTable.tsx     # 북별 일일 P&L 테이블
│       └── PortfolioSummary.tsx # 포지션 요약 카드
├── hooks/
│   └── usePortfolioMetrics.ts   # 포트폴리오 지표 계산 훅
└── types/
    └── portfolio.ts             # 공유 TypeScript 인터페이스
```
