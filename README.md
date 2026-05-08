# Kloser

> **AI 기반 세일즈 어시스턴트 SaaS — 인바운드 상담부터 고객 관리, 팀 성과까지 한 번에.**

Kloser는 영업 조직이 더 많은 거래를 "Close" 할 수 있도록 돕는 B2B 세일즈 플랫폼입니다. 통화 중 AI가 실시간으로 응대 방향을 제안하고, 통화 후 자동으로 메모를 정리하며, 매일 아침 시장 트렌드 기반의 영업 To-Do를 제시합니다.

```
🚀 라이브 데모  →  platform/dashboard.html (회원가입 없이 바로 체험)
🏠 마케팅 사이트 →  index.html
📑 도입 가이드   →  docs/product/guide.html
```

---

## 🎯 한 줄 요약

| 무엇을 | 누구를 위해 | 어떻게 |
|---|---|---|
| AI 통화 보조 + 영업 자동화 SaaS | B2B 영업팀 (1~50명 규모) | 데스크톱 앱 + 웹 콘솔 |

핵심 차별점: **사후 녹음 분석이 아니라, 통화가 흘러가는 동안 실시간으로 응대 추천**.

---

## 🧩 핵심 기능 6선

### 1. 실시간 AI 통화 어시스턴트
- 고객 발화를 STT(Naver Clova)로 실시간 전사
- 회사 가이드 / FAQ를 RAG로 검색해 **2~3초 안에** 응대 멘트 추천
- 감정 분석으로 고객 단계(긍정 → 망설임 → 재고려)를 자동 추적
- 상담원 화면에 추천 카드 + 체크리스트 + 빠른 응대 칩 노출

### 2. 통화 후 자동 메모 & 다음 액션
- 통화 종료 즉시 전체 transcript를 요약
- **3가지 카테고리 자동 분류**: 고객 니즈 / 미해결 이슈 / 다음 액션
- 별도 메모 작성 0초 → 곧바로 다음 업무로

### 3. 매일 자동 영업 To-Do
- 네이버 검색 API로 회사 지정 키워드·경쟁사 동향 수집
- 통화 기록 + 시장 트렌드를 함께 분석해 우선순위 정렬
- 매일 아침 06:00 자동 생성 (시간 설정 가능)

### 4. AI 챗 기반 뉴스레터 자동화
- 통합 고객 DB + 챗봇 인터페이스
- "환영 메일 작성해줘" 한 줄 → 개인화된 초안 즉시 생성
- 발송 통계(전달률 / 오픈율 / 클릭률) 실시간 추적

### 5. 회사 단위 계정 관리
- 관리자 1개 + 직원 서브 계정 (Starter/Pro: 1개, Enterprise: 5개)
- 권한별 접근 제어 (Admin / Manager / Employee / Viewer)
- 회사 단위 데이터 통합 → 떠난 직원의 고객·통화도 보존

### 6. 팀 성과 KPI 대시보드
- 통화 수 / 응답률 / 평균 통화 시간 / 전환율 4종 KPI
- 팀별 주간 성과 막대 차트
- 우수 사례 자동 표시 → 즉시 공유

---

## 🚀 라이브 플랫폼 데모

`platform/` 폴더에 **9개의 인터랙티브 페이지**가 있습니다. 모든 페이지는 mock 데이터로 동작하고 회원가입 없이 즉시 체험 가능합니다.

| 페이지 | 경로 | 주요 인터랙션 |
|---|---|---|
| 🏠 **대시보드** | [`platform/dashboard.html`](platform/dashboard.html) | 4 KPI · 트렌드 위젯 · To-Do 체크박스 · 최근 통화 · 팀 활동 피드 · **알림 패널** |
| 📅 **오늘의 일** | [`platform/daily.html`](platform/daily.html) | 시장 트렌드 + 추천 To-Do + 경쟁사 동향 + **관심사 키워드 설정** + **5포맷 다운로드 (HTML/PDF/Word/Excel/PPT)** |
| 📞 **실시간 통화** | [`platform/live.html`](platform/live.html) | 통화 타이머 · STT Transcript 자동 추가 · AI 추천 동적 갱신 · 감정 분석 단계 변화 · 알림 패널 |
| 📚 **통화 기록** | [`platform/calls.html`](platform/calls.html) | 검색·필터 · 8건 mock 통화 · 클릭 시 우측 상세 패널 슬라이드 |
| 👥 **고객 관리** | [`platform/customers.html`](platform/customers.html) | 4 KPI · status/sort 2 그룹 필터 chip · 검색 + URL query sync · CRUD 모달 듀얼 모드 (실 API + 24명 seed). `phase_2_customers_e2e` 7 시나리오 회귀 |
| ✉️ **뉴스레터** | [`platform/newsletter.html`](platform/newsletter.html) | 캠페인 5개 + 통계 · AI 챗봇으로 메일 초안 자동 생성 |
| 🏢 **팀 & 계정** | [`platform/team.html`](platform/team.html) | 14명 구성원 + 우수 사례 랭킹 + 권한 매트릭스 + 직원 초대 모달 |
| ⚙️ **설정** | [`platform/settings.html`](platform/settings.html) | 12개 카테고리 (프로필/회사/통화환경/AI/통합/알림/보안/데이터/플랜/API/언어/위험영역) + 스크롤스파이 TOC |

### 🎬 동적 시뮬레이션 하이라이트

**실시간 통화 (live.html)** — 4.5초 간격으로 발화 자동 추가 + 5/14/23/36초 시점에 AI 추천 자동 갱신, 고객 감정이 긍정 → 관심 → 망설임 → 재고려로 진화. **Phase 0.5 스파이크 이후로는 setTimeout mock이 아니라 백엔드(`server/`)가 WebSocket(`/calls`)으로 푸시하는 실시간 이벤트**로 동작 — 데모 외관은 동일하지만 통신 경로는 진짜.

**AI 챗봇 (newsletter.html)** — 사용자 프롬프트(환영/업데이트/웨비나/갱신)에 따라 **다른 메일 초안 자동 생성** + 타이핑 점 애니메이션

**오늘의 일 (daily.html)** — 키워드/경쟁사 chip 추가·삭제, To-Do 체크박스 토글, **모니터링 관심사 모달**로 실시간 편집

---

## 📥 회의 자료 내보내기 (오늘의 일)

`daily.html` 우측 상단 **[내보내기 ▾]** 버튼에서 **5가지 포맷**으로 다운로드:

| 포맷 | 라이브러리 | 특징 |
|---|---|---|
| **HTML** | 자체 빌드 (Blob) | Pretendard 폰트 임베드, 메일 첨부에 최적 |
| **PDF** | `jsPDF` + `html2canvas` | 한글 그대로, A4 다중 페이지 자동 분할 |
| **Word (.docx)** | `html-docx-js` | Microsoft Word에서 그대로 편집 가능 |
| **Excel (.xlsx)** | `SheetJS` | **5개 시트 자동 분리** (요약·트렌드·주간·To-Do·경쟁사) |
| **PowerPoint (.pptx)** | `PptxGenJS` | **6장 슬라이드** 자동 구성 (표지·KPI·트렌드·To-Do·경쟁사·마무리) |

파일명 규칙: `Kloser_오늘의일_2026-05-03.{확장자}`

---

## 🎨 디자인 시스템

- **폰트**: Pretendard Variable (한글) + Inter (영문)
- **컬러**: Slate (텍스트) + Blue/Cyan (액센트) + Emerald/Amber/Rose/Violet (상태)
- **레이아웃**: 232px 사이드바 + 60px 상단바 + 메인 컨텐츠
- **반응형**: 1024px 미만에서 사이드바가 드로어로 전환, 멀티컬럼이 단일컬럼으로 stack
- **인터랙션**: 모든 페이지에 fade-in / 모달 / 토스트 / 스크롤스파이 적용

---

## 🏗️ 아키텍처 (구상)

```
┌─────────────────────────────────────────────────────────────────┐
│  상담원 PC (Windows)                                              │
│  ┌──────────────────────────────────────┐                        │
│  │ Kloser 데스크톱 앱 (Electron / Tauri) │                        │
│  │  ─ 마이크 + 시스템 오디오 캡처         │                        │
│  │  ─ 100~300ms 청크 → WebSocket         │                        │
│  └────────────────────┬─────────────────┘                        │
└──────────────────────│────────────────────────────────────────── ┘
                       ▼
┌──────────────────────────────────────────────────────────────────┐
│  Kloser 서버 (자체 온프레미스 — BACKEND_PLAN.md v0.4)               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐             │
│  │ STT 게이트웨이│→ │ AI 어시스턴트 │→ │ 상담원 콘솔 │              │
│  │ (Naver Clova)│  │ (RAG + LLM)  │  │ (WebSocket) │              │
│  └──────────────┘  └──────┬───────┘  └──────────────┘             │
│                           │                                       │
│                    ┌──────┴───────┐                               │
│                    │ 회사 가이드   │                               │
│                    │ (pgvector)   │                               │
│                    └──────────────┘                               │
│                                                                   │
│  Stack: Fastify + Socket.io + PostgreSQL + Redis/BullMQ + Nginx   │
└───────────────────────────────────────────────────────────────────┘
                       ▲
                       │ Naver 검색 API (매일 06:00)
                       │
              ┌────────┴────────┐
              │ 시장 트렌드 수집  │
              │ (To-Do 자동 생성) │
              └─────────────────┘
```

> **현재 단계**: **Phase 2 완료** (Step 1~6) — Phase 1 기반 위에 customers entity 정착. `customers` 테이블 + RLS 4정책 + 5 partial 인덱스 + 24명 seed, repository (7 함수) + service (6 함수) + 6 REST endpoint (`GET /customers`, `GET /customers/stats`, `GET /customers/:id`, `POST`, `PATCH`, `DELETE`), shared types (zod source-of-truth + JSDoc browser mirror + sync 검증), `platform/customers.html` 실 API CRUD (모달 듀얼 모드 + 2 그룹 필터 chip + URL query sync + `loadAll` 재조회 정책), customers e2e 7 시나리오 + cleanup. **`customers.plan`은 의도적으로 제거** — `organizations.plan` (Kloser 구독 단계)과 도메인 경계 충돌 회피. `npm test` 65/65 + `phase_0_5_e2e` 16/16 + `phase_2_customers_e2e` PASS + `sync_shared_types` PASS. 다음은 Phase 3 (회원가입/이메일/팀 초대).
> 자세한 계획·결과: [`docs/plan/roadmap/BACKEND_PLAN.md`](docs/plan/roadmap/BACKEND_PLAN.md), [`docs/plan/phase-1/PHASE_1_MASTER.md`](docs/plan/phase-1/PHASE_1_MASTER.md), [`docs/plan/phase-2/PHASE_2_MASTER.md`](docs/plan/phase-2/PHASE_2_MASTER.md), [`docs/plan/phase-2/PHASE_2_STEP_5_FINDINGS.md`](docs/plan/phase-2/PHASE_2_STEP_5_FINDINGS.md), [`docs/plan/phase-2/PHASE_2_STEP_6_FINDINGS.md`](docs/plan/phase-2/PHASE_2_STEP_6_FINDINGS.md).

---

## 🗂️ 프로젝트 구조

```
kloser/
├── index.html                # 메인 마케팅 랜딩 페이지
├── trial.html                # 무료 체험 신청 페이지
├── README.md
│
├── platform/                 # 🚀 라이브 플랫폼 데모 (9 페이지)
│   ├── index.html            # → dashboard.html 자동 리다이렉트
│   ├── dashboard.html        # 메인 대시보드
│   ├── daily.html            # 오늘의 일 (트렌드 + To-Do + 다운로드)
│   ├── live.html             # 실시간 통화 어시스턴트 (server/와 WebSocket 연결)
│   ├── calls.html            # 통화 기록 + 상세 패널
│   ├── customers.html        # 고객 관리
│   ├── newsletter.html       # AI 뉴스레터 작성
│   ├── team.html             # 팀 & 계정 관리
│   ├── settings.html         # 12개 카테고리 설정
│   ├── _shared.css           # 공통 스타일 (사이드바·테이블·뱃지·버튼)
│   ├── _shared.js            # 공통 사이드바 + 알림 패널 렌더러
│   ├── _daily.js             # daily.html 전용 로직 (4 포맷 export)
│   ├── login.html            # 🆕 Phase 1 Step 4 — dev 로그인 폼 + returnUrl
│   ├── api.js                # 🆕 Phase 1 Step 4 — fetch wrapper (메모리 토큰 + auto-refresh)
│   └── ws.js                 # Socket.io 클라이언트 wrapper (window.kloserWS, JWT handshake)
│
├── server/                   # 백엔드 — Fastify + Socket.io + PostgreSQL/RLS + 자체 Auth
│   ├── README.md             # 실행/검증/엔드포인트/RLS 가이드 (전체 트리는 여기 참고)
│   ├── package.json          # fastify · socket.io · pg · @fastify/{jwt,cookie} · argon2
│   ├── migrations/ · seeds/ · scripts/   # node-pg-migrate + Argon2id 시드
│   ├── test/                 # tsx --test (auth · rls · orgContext · ws_auth = 37 cases)
│   └── src/                  # config · db · plugins · middleware · services
│                             # repositories · routes · ws · fixtures
│
├── docs/                                   # 문서 인덱스: docs/README.md
│   ├── README.md                           # 폴더 인덱스 + 빠른 진입표
│   ├── USER_GUIDE_PHASE_1.md               # Phase 1 사용자/평가자용 텍스트 가이드
│   ├── plan/                               # Phase별 실행 계획 + 결과 인계
│   │   ├── README.md                       #   plan 폴더 색인
│   │   ├── roadmap/                        #   BACKEND_PLAN / DESKTOP_APP_PLAN
│   │   ├── phase-0.5/                      #   live spike 계획 + findings
│   │   ├── phase-1/                        #   Phase 1 master + Step 1~5
│   │   └── phase-2/                        #   Phase 2 master + Step 1~6
│   ├── decision/                           # 기술 선택 트레일 (4)
│   │   ├── FASTIFY_GUIDE.md                #   Fastify 도입 근거 + 패턴
│   │   ├── NODE_VS_PYTHON_BACKEND.md       #   Node vs Python 결정
│   │   ├── SUPABASE_VS_ONPREM.md           #   Supabase managed 미채택 사유
│   │   └── SUPABASE_GUIDE.md               #   (검토 시점 참고, 이력 보존)
│   ├── product/                            # 제품·마케팅·도입 가이드 (5)
│   │   ├── USER_GUIDE.html                 #   🆕 시각 가이드 — 9개 화면 walkthrough
│   │   ├── PHASE_1_FOUNDATIONS.html        #   🆕 Phase 1 기반 기능 시각 가이드 (6 기둥)
│   │   ├── pricing.md                      #   가격 정책 (내부 SSOT)
│   │   ├── guide.html                      #   도입 가이드 (고객용)
│   │   └── realtime-call-assistant-guide.md #  제품·아키텍처 정의 SSOT
│   ├── ops/                                # 운영·인프라 메모 (3)
│   │   ├── R730xd_server_setup.md          #   자체 서버 용량 산정
│   │   ├── SLA_99.9%_서버_구성_정리.md     #   HA 구성 (LB/app/PG/Redis)
│   │   └── 운영_핵심_개선_정리.md          #   RLS/감사로그/마스킹 베이스라인
│   └── research/                           # 시장·비용 분석 (2)
│       ├── 실시간-STT-시장분석-2026.md     #   STT 시장 분석
│       └── AZURE_SPEECH_COST_GUIDE_2026.md #   Azure Speech 비용 가이드
│
├── ops/                      # 인프라 설정 (Phase 1)
│   ├── docker-compose.yml    # postgres 16 + redis 7 dev compose
│   ├── postgres/init/        # 첫 실행 시 app 역할 부트스트랩
│   └── Caddyfile.dev         # 🆕 Phase 1 Step 5 — single-origin reverse proxy (선택)
│
├── assets/
│   ├── logo.png / logo.svg / logo_new.png / logo_old.png
│   ├── favicon.svg / favicon.png
│   ├── landing_img/          # 히어로 시안 이미지
│   └── screenshots/user_guide/  # 🆕 USER_GUIDE.html 캡처 9장
│
├── test/                     # 자동화 검증 스크립트
│   ├── README.md             # 실행 방법
│   ├── smoke_desktop.py      # 데스크톱 8 페이지 일괄 검증 (Python)
│   ├── smoke_mobile.py       # 모바일 8 페이지 검증 + 사이드바 토글 (Python)
│   ├── smoke_daily.py        # daily.html 단독 검증 (Python)
│   ├── test_features.py      # 알림/Word 등 기능 검증 (Python)
│   ├── screenshots.py        # 스크린샷 자동 캡처 (Python)
│   ├── phase_0_5_e2e.mjs     # Phase 0.5 server↔live.html e2e (Node + Playwright)
│   │                         #   Phase 1 Step 5에서 KLOSER_E2E_BASE_URL env로 두 모드 지원
│   ├── phase_0_5_e2e.png     # e2e 스크린샷 (검증 산출물)
│   ├── capture_user_guide_screenshots.mjs  # 🆕 USER_GUIDE.html 캡처 재실행 스크립트
│   └── screenshots/          # 캡처 결과 PNG
│
└── (admin.html · console.html — 별도 관리자 영역, 본 README 범위 외)
```

---

## 💰 가격 정책 (요약)

| 플랜 | 월 비용 (회사 기준) | 직원 계정 | 핵심 |
|---|---|---|---|
| **Starter** | 29,000원 | 1명 | 핵심 기능 (월 200통, 1,000명) |
| **Pro** ⭐ | 49,000원 | 1명 | 모든 기능 풀 (무제한 통화 + 일일 To-Do + 뉴스레터 + 팀 KPI) |
| **Enterprise** | 299,000원~ | 5명 | Pro + SSO/SAML + SLA 99.9% + 전담 매니저 + 온프레미스 |

- 모든 플랜은 **회사 1곳 기준** 정액제
- 연간 결제 시 **−20%**
- Enterprise는 **연간 구독만 가능** + **현장 방문 초기 셋팅** 필수
- 6명 이상은 Enterprise 맞춤 견적

상세는 [`docs/product/pricing.md`](docs/product/pricing.md), [`docs/product/guide.html`](docs/product/guide.html) 참고.

---

## 🛠️ 로컬 실행

> 현재 코드는 외부 서버에 자동 배포되는 구조가 아닙니다. 아래 절차는 로컬 PC에서 직접 서버를 켜고 브라우저로 접속하는 방법입니다.

### 기본 실행 (`http://localhost:8765`)

`live.html`까지 실제 로그인/API/WebSocket 흐름으로 보려면 터미널 3개가 필요합니다.

```powershell
# 터미널 1: DB + Redis
docker compose -f ops/docker-compose.yml up -d
```

```powershell
# 터미널 2: 백엔드 API + WebSocket (:3001)
cd server
npm install                  # 최초 1회
npm run db:migrate:up        # 최초 1회 또는 migration 변경 시
npm run db:seed              # 최초 1회 또는 seed 재적재 시
npm run dev
```

```powershell
# 터미널 3: 정적 HTML 서버 (:8765), 프로젝트 루트에서 실행
python -m http.server 8765
# Python이 없으면:
# npx http-server . -p 8765 --silent
```

브라우저 접속 주소:

| 목적 | URL |
|---|---|
| 마케팅 사이트 | <http://localhost:8765/> |
| 로그인 | <http://localhost:8765/platform/login.html> |
| 실시간 통화 데모 | <http://localhost:8765/platform/live.html> |
| 플랫폼 데모 홈 | <http://localhost:8765/platform/> |
| 도입 가이드 | <http://localhost:8765/docs/product/guide.html> |
| Phase 1 사용자 가이드 | <http://localhost:8765/docs/product/USER_GUIDE.html> |
| Phase 1 기반 기능 가이드 | <http://localhost:8765/docs/product/PHASE_1_FOUNDATIONS.html> |

`platform/live.html`은 로그인 없이는 `login.html`로 자동 이동합니다. localhost에서는 로그인 화면에 dev 계정 자동 채우기 버튼이 보입니다.

| 역할 | 이메일 | 비밀번호 |
|---|---|---|
| Acme admin | `admin@acme.test` | `acme-admin-1234` |
| Acme employee | `emp@acme.test` | `acme-emp-1234` |
| Beta admin | `admin@beta.test` | `beta-admin-1234` |
| Beta employee | `emp@beta.test` | `beta-emp-1234` |

로그인 후 `http://localhost:8765/platform/live.html`이 인증된 WS로 `start_call → transcript/suggestion/sentiment` 시퀀스를 푸시합니다. 자세한 실행/검증/엔드포인트는 [`server/README.md`](server/README.md).

### Step 5 Caddy 실행 (`https://localhost`)

운영 환경과 비슷하게 정적 파일, REST API, WebSocket을 모두 `https://localhost` 한 origin으로 묶어 보려면 Caddy 모드를 사용합니다. 이 모드에서는 위의 터미널 3 정적 서버가 필요 없고, Caddy가 정적 파일까지 직접 제공합니다.

먼저 터미널 1(DB + Redis)과 터미널 2(백엔드 `npm run dev`)는 그대로 켜둡니다. 그 다음 프로젝트 루트에서 Caddy를 실행합니다.

```powershell
# Caddy 설치 확인
caddy version

# PATH에 caddy가 없으면 winget 설치 위치를 직접 확인
where.exe caddy

# Caddy 실행 (:443)
$env:KLOSER_STATIC_ROOT = (Resolve-Path .).Path
caddy run --config ops/Caddyfile.dev
```

Windows에서 `winget`으로 Caddy를 설치했는데 `caddy` 명령이 PATH에 없으면, 설치된 `caddy.exe` 경로를 직접 실행해도 됩니다.

```powershell
$caddy = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\CaddyServer.Caddy_Microsoft.Winget.Source_8wekyb3d8bbwe\caddy.exe"
& $caddy run --config ops/Caddyfile.dev
```

Caddy 모드 브라우저 접속 주소:

| 목적 | URL |
|---|---|
| 마케팅 사이트 | <https://localhost/> |
| 로그인 | <https://localhost/platform/login.html> |
| 실시간 통화 데모 | <https://localhost/platform/live.html> |
| Health check | <https://localhost/health> |

브라우저에서 인증서 경고가 뜨면 로컬 self-signed 인증서 때문입니다. 임시로는 "고급 → 계속 진행"으로 들어가면 되고, 경고를 없애려면 관리자 권한 터미널에서 한 번 `caddy trust`를 실행합니다.

검증:

```powershell
curl.exe -k https://localhost/health
$env:KLOSER_E2E_BASE_URL = 'https://localhost'
node test/phase_0_5_e2e.mjs
Remove-Item Env:KLOSER_E2E_BASE_URL
```

> **참고**: Tailwind CSS, Pretendard, socket.io-client는 CDN 로딩이라 첫 로드 시 인터넷 연결이 필요합니다.

자동 검증 스크립트(Python smoke + Node e2e)는 [`test/README.md`](test/README.md) 참고.

---

## 🧪 기술 스택

### 프론트엔드 (이 레포)
- **마크업**: 정적 HTML
- **스타일**: Tailwind CSS (CDN) + Pretendard Variable
- **로직**: Vanilla JavaScript (의존성 무)
- **아이콘**: 인라인 SVG (Lucide 스타일)

### 외부 라이브러리 (CDN)
- **Pretendard CDN** (jsdelivr) — 한글 가변 폰트
- **socket.io-client 4.7** — `live.html`이 `/calls` 네임스페이스에 접속
- **html2canvas + jsPDF** — PDF 다운로드
- **html-docx-js** — Word(.docx) 다운로드
- **SheetJS (xlsx)** — Excel(.xlsx) 다운로드
- **PptxGenJS** — PowerPoint(.pptx) 다운로드
- **Simple Icons CDN** — Powered by · Integrates with 로고

### 백엔드 (`server/` — Phase 2 완료, Phase 3 대기)
- **런타임/언어**: Node.js 20+ / TypeScript
- **프레임워크**: Fastify 5 + Socket.io 4 (`/calls` 네임스페이스)
- **인프라 결정**: 자체 온프레미스 (Supabase managed 미채택 — `docs/decision/SUPABASE_VS_ONPREM.md`)
- **DB**: 직접 운영 PostgreSQL + RLS default-deny (Phase 1부터)
- **큐/캐시**: Redis + BullMQ (Phase 4+)
- **Reverse proxy**: Nginx 또는 Caddy (Phase 1+)

### 외부 연동 (Phase 5~6)
- **STT**: Naver Clova Speech (한국어 영업 도메인 정확도 우선)
- **LLM**: Anthropic Claude / OpenAI GPT — 회사 가이드 RAG 기반
- **벡터 검색**: pgvector
- **데스크톱 앱**: Electron 또는 Tauri (Windows + WASAPI 오디오 캡처) — `docs/plan/roadmap/DESKTOP_APP_PLAN.md`

---

## 🗺️ 로드맵

### v0 — 데모 (✅ 완료)
- 9페이지 인터랙티브 데모 + mock 데이터
- 다국어 폰트 / 반응형 / 모달 / 토스트 / 다운로드
- 자동화 검증 스크립트 (Python smoke + Node e2e + Playwright)

### v0.5 — 라이브 스트림 스파이크 (✅ 완료)
- `server/` Fastify + Socket.io 부트스트랩
- `/calls` 네임스페이스: `start_call`/`text_chunk`/`end_call` (snake_case)
- `live.html`의 `setTimeout` mock을 WebSocket 이벤트로 교체
- 수동 RTT 1ms · 자동 데모 재생 · sentiment 자동 전이 · 14/14 e2e PASS
- 결과 정리: [`docs/plan/phase-0.5/PHASE_0_5_FINDINGS.md`](docs/plan/phase-0.5/PHASE_0_5_FINDINGS.md)

### v1 — MVP (다음 단계, Phase 1~6)
- **Phase 1**: PostgreSQL 부트스트랩 + RLS default-deny + 자체 Auth (Argon2id + JWT + refresh rotation) + 클라이언트 wiring + Caddy reverse proxy (Step 1~5)
- **Phase 2**: Customers CRUD
- **Phase 3~5**: Team/초대, Calls REST + Dashboard, 실시간 STT(Clova) + AI suggestion
- Windows 데스크톱 앱 (오디오 캡처)
- Claude RAG 기반 응대 추천 엔진
- 단일 회사·1~5명 직원 기준 PoC

### v2 — Enterprise 베타
- SSO / SAML
- HubSpot / Salesforce 양방향 동기화 (실연동)
- 온프레미스 배포 옵션
- SLA 99.9% 모니터링

### v3 — 확장
- 모바일 앱 (iOS / Android)
- KakaoTalk 채널 발송 통합
- 다국어 지원 (영어 / 일본어)
- 공식 API + Webhook 마켓플레이스

---

## 🤝 기여 / 문의

- **제품 피드백**: cjb@doi-kr.com
- **도입 문의**: 랜딩 페이지 [`구매 문의`](index.html#pricing) 버튼
- **무료 체험 신청**: [`trial.html`](trial.html)

---

## 📄 라이선스

본 프로젝트는 Kloser 팀의 비공개 자산입니다.
