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

`platform/` 폴더에 **9개의 인터랙티브 페이지**가 있습니다. 인증·고객·통화·대시보드·팀 영역은 Phase 1~4를 거치며 실 API로 동작하고, 나머지 일부 위젯은 아직 데모 데이터입니다 (페이지별 `(API)` / `(demo)` 라벨 참고).

| 페이지 | 경로 | 주요 인터랙션 |
|---|---|---|
| 🏠 **대시보드** | [`platform/dashboard.html`](platform/dashboard.html) | KPI 4장 + 최근 통화 5건 실 API (`/dashboard/summary`) · 시장 트렌드 / 추천 To-Do / 팀 활동은 demo (헤더에 라벨) · 미인증 배너 |
| 📅 **오늘의 일** | [`platform/daily.html`](platform/daily.html) | 시장 트렌드 + 추천 To-Do + 경쟁사 동향 + **관심사 키워드 설정** + **5포맷 다운로드 (HTML/PDF/Word/Excel/PPT)** (demo) |
| 📞 **실시간 통화** | [`platform/live.html`](platform/live.html) | 통화 타이머 · 인증 WebSocket으로 transcript / sentiment / suggestion 실시간 수신 · 빠른 메모 저장 · 통화 종료(WS `end_call`)가 DB 영속화 + `customers.last_contacted_at` 갱신 |
| 📚 **통화 기록** | [`platform/calls.html`](platform/calls.html) | 종료된 통화가 실제 기록으로 남고, 검색·상태 필터·우측 상세 패널에서 메모/대화 내용/액션 아이템을 확인. `phase_4_e2e` 8 시나리오 회귀 |
| 👥 **고객 관리** | [`platform/customers.html`](platform/customers.html) | 4 KPI · status/sort 2 그룹 필터 chip · 검색 + URL query sync · CRUD 모달 듀얼 모드 (실 API + 24명 seed). `phase_2_customers_e2e` 7 시나리오 회귀 |
| ✉️ **뉴스레터** | [`platform/newsletter.html`](platform/newsletter.html) | 캠페인 5개 + 통계 · AI 챗봇으로 메일 초안 자동 생성 (demo) |
| 🏢 **팀 & 계정** | [`platform/team.html`](platform/team.html) | `/teams` · `/memberships` · `/invitations` 실 API — 멤버 목록 / 역할 변경 / 직원 초대 모달. `phase_3_e2e` 33 assertion 회귀 |
| ⚙️ **설정** | [`platform/settings.html`](platform/settings.html) | 12개 카테고리 (프로필/회사/통화환경/AI/통합/알림/보안/데이터/플랜/API/언어/위험영역) + 스크롤스파이 TOC (demo) |

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

> **현재 단계**: **Phase 7 Step 1~9 완료** — 운영 출시 직전 게이트 4종(Step 1~4) + P1 follow-up 다섯 항목(Step 5 cost map, Step 6 sidebar role visibility, Step 7 보고서 date window + agent drilldown, Step 8 demo-to-real cleanup, Step 9 billing/subscription caps)이 닫혔다. **Step 1 (Resend 실 이메일 + transactional outbox)**: `email_outbox`에 status/provider/sensitive_payload 컬럼 + AES-256-GCM 암호화 + BullMQ `email-delivery` 싱글톤 워커가 lease → decrypt → send → markDelivered+scrub / 지수 백오프 / dead letter. dev 모드(`EMAIL_PROVIDER` unset/empty/`dev_outbox`)는 Phase 3 동작 그대로. **Step 2 (MFA / 세션 강화)**: TOTP 도입 — login challenge gate + refresh 시 MFA required 검사 + 인증된 enroll/disable + 조직 MFA 강제 토글 + `settings.html`·`login.html` frontend wiring. **Step 3 (activity_log / 감사 로그)**: schema hardening + repository + service helper (payload sanitizer) + 보안/멤버십/초대/고객/통화/지식/보고서 audit hook 묶음 + 관리자용 `GET /activity-log` (cursor pagination + cross-org isolation) + `settings.html` 관리자 전용 audit 패널 (모든 audit 값 `textContent` 렌더). **Step 4 (retention enforce cron)**: transcript 3년 hard delete (batch + maxBatches cap, org별 `withOrgContext`) + email_outbox stuck-sending recovery (`status='sending' AND locked_at < cutoff` → `failed` + 락 메타데이터 클리어, `attempt_count` 불변) + aggregate audit row (`retention.transcripts_deleted` / `email_outbox.sending_recovered`) + BullMQ `retention-sweep` 싱글톤 워커 (`KLOSER_RETENTION_ENABLED=true`일 때만 schedule). call_recordings는 recording storage 부재로 not applicable (Phase 8). **Step 5 (LLM 사용 비용 매핑)**: adapter boundary helper `calculateUsageCostUsdMicros` 가 provider/operation/model + tokens를 받아 bigint micro-USD로 integer ceil 계산. Anthropic Sonnet 4.5/4.6 ($3·15), Opus 4.5/4.6/4.7 ($5·25), Haiku 4.5 ($1·5) per MTok + OpenAI text-embedding-3-small ($0.02/MTok) / text-embedding-3-large ($0.13/MTok) 가격 상수에 official URL + verified-on(2026-05-18) 주석. unknown model / missing usage / Clova STT는 cost null + `metadata.cost_status` 마커. 과거 row backfill 없음. **Step 6 (role-based sidebar visibility)**: `platform/_shared.js`에 `SIDEBAR_NAV_VISIBILITY` 맵 + `canShowSidebarPage(page, role)` + `applySidebarNavVisibility(role)` 헬퍼 추가. employee/viewer에게 `팀 보고서` 숨김, viewer는 `실시간 통화/뉴스레터`까지 숨김. `/me` 응답 전에는 공통 nav만 표시해 민감 nav flicker 차단. `hidden` 속성이 `.nav-item { display: flex }`를 이기도록 `.nav-item[hidden] { display: none; }` 추가. backend role policy 무변경 — sidebar는 UX 정리, 직접 URL 접근은 기존 backend 403/banner가 막는다. **Step 7 (보고서 date window + agent drilldown)**: `GET /reports/team-summary`에 `from`/`to` query 추가 (둘 다 omit 시 최근 30일 default, 둘 다 입력 필요 — one-sided 400). 응답에 `window` 메타 + `agent_summaries` 배열 추가 (org scope는 unassigned 버킷 포함, team scope는 own team active members만). 모든 metric/recent/agent SQL에 `started_at >= from_inclusive AND < to_exclusive` 적용. `platform/reports.html`에 7/30/90/직접 preset + custom date input + agent row-click drilldown (client-side recent_calls 필터). audit payload에 `from/to/window_days` 추가 — 키셋이 `[scope, team_id]` → `[scope, team_id, from, to, window_days]`. backward incompat: 기존 omit 동작이 전체 기간 → 최근 30일로 좁혀짐 (의도). **Step 8 (demo-to-real frontend cleanup)**: `dashboard.html`의 `kpiAvgDuration`을 `innerHTML` → textContent 2-span 구조로 전환하고 API 실패 시 demo fallback 대신 banner 표시. demo sub-section 3곳에 `data-source="demo"` 마커. `daily.html`/`_daily.js`의 "매일 06:00 자동 갱신" / "네이버 검색 API로 자동 수집" / "갱신 완료" 문구를 "데모 데이터 (자동 갱신 backend 미연결)" / "데모 새로고침"으로 정리, user-typed 키워드/경쟁사 보간에 `escapeHtml` 추가 (XSS hole 닫음), demo arrays를 `DEMO_TRENDS` / `DEMO_TODOS`로 리네이밍. `newsletter.html`의 발송 UI 카피를 "발송" → "시뮬레이션"으로 일관 교체 ("이메일 발송 (시뮬레이션)", "시뮬레이션 실행 중", "시뮬레이션 완료", "예시 발신: noreply@kloser.com"), 상단 통계 4종에 `(예시)` 라벨, `appendUser` chat 메시지 본문을 textContent로 전환해 XSS hole 닫음, custom 템플릿 카드 user-typed 필드에 `escapeHtml` 추가. transactional `email_outbox` (Step 1)을 newsletter campaign에 연결하지 않고, `activity_log` admin endpoint (Step 3)을 dashboard 팀 활동 feed로 노출하지 않음. **Step 9 (billing / subscription caps)**: `organizations.plan`에 starter/pro/enterprise CHECK + `organization_billing_profiles` 신규 (org-scoped, FORCE RLS, DELETE 미부여, trialing 기본값 backfill). `BILLING_PLAN_LIMITS` 단일 source-of-truth (seats/customers/KB/chunk/monthly_calls hard, monthly_llm_cost soft). `assertPlanAllows`(+`Absolute`)가 `lockCurrentOrganization` FOR UPDATE → usage count → throw `PlanLimitExceededError(403, code='plan_limit_exceeded')` 시퀀스로 race를 직렬화. invitations.createInvitation(+ acceptInvitation servicePool 재검) / customers.createCustomer / calls.createCall(REST+WS 공유) / knowledge.createKnowledgeBase / replaceKnowledgeChunks 경로에 적용. `GET /billing/overview` + `PATCH /billing/profile` admin 전용 (organization+profile+entitlements+usage+limits 반환, 외부 provider id는 `external_provider_configured` boolean만 노출). audit payload는 field name 배열만 — 값 미포함 (PII 보호). settings.html#billing 정적 카드 전체 교체 (가짜 결제 수단/내역 제거 + 사용량 progress bars + tax_id maxlength=64 + email input + 비관리자는 "권한 없음" 정적 패널). 모든 서버 값은 textContent/input.value로만 주입 (XSS 차단). 다음 단계는 **Phase 7 closeout** — Stripe/Toss 실 결제 provider 연동은 외부 돈 이동/회계 계약 동반이라 별도 Phase로 분리.
> 자세한 계획·결과: [`docs/plan/roadmap/BACKEND_PLAN.md`](docs/plan/roadmap/BACKEND_PLAN.md), [`docs/plan/phase-1/PHASE_1_MASTER.md`](docs/plan/phase-1/PHASE_1_MASTER.md), [`docs/plan/phase-2/PHASE_2_MASTER.md`](docs/plan/phase-2/PHASE_2_MASTER.md), [`docs/plan/phase-3/PHASE_3_MASTER.md`](docs/plan/phase-3/PHASE_3_MASTER.md), [`docs/plan/phase-4/PHASE_4_MASTER.md`](docs/plan/phase-4/PHASE_4_MASTER.md), [`docs/plan/phase-5/PHASE_5_MASTER.md`](docs/plan/phase-5/PHASE_5_MASTER.md), [`docs/plan/phase-6/PHASE_6_MASTER.md`](docs/plan/phase-6/PHASE_6_MASTER.md), [`docs/plan/phase-7/PHASE_7_MASTER.md`](docs/plan/phase-7/PHASE_7_MASTER.md), [`docs/plan/phase-7/PHASE_7_STEP_1_FINDINGS.md`](docs/plan/phase-7/PHASE_7_STEP_1_FINDINGS.md), [`docs/plan/phase-6/PHASE_7_HANDOFF.md`](docs/plan/phase-6/PHASE_7_HANDOFF.md). 사용자 가이드: [`docs/USER_GUIDE_PHASE_6.md`](docs/USER_GUIDE_PHASE_6.md) · 시각 가이드: [`docs/product/PHASE_4_FOUNDATIONS.html`](docs/product/PHASE_4_FOUNDATIONS.html).

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
│   ├── USER_GUIDE_PHASE_2.md               # Phase 2 — Customers CRUD
│   ├── USER_GUIDE_PHASE_3.md               # Phase 3 — 셀프서비스 (signup/verify/reset/invite)
│   ├── USER_GUIDE_PHASE_4.md               # Phase 4 — 통화 영속화 / calls 실 API / dashboard
│   ├── plan/                               # Phase별 실행 계획 + 결과 인계
│   │   ├── README.md                       #   plan 폴더 색인
│   │   ├── roadmap/                        #   BACKEND_PLAN / DESKTOP_APP_PLAN
│   │   ├── phase-0.5/                      #   live spike 계획 + findings
│   │   ├── phase-1/                        #   Phase 1 master + Step 1~5
│   │   ├── phase-2/                        #   Phase 2 master + Step 1~6
│   │   ├── phase-3/                        #   Phase 3 master + Step 1~7
│   │   └── phase-4/                        #   Phase 4 master + Step 1~5
│   ├── decision/                           # 기술 선택 트레일 (4)
│   │   ├── FASTIFY_GUIDE.md                #   Fastify 도입 근거 + 패턴
│   │   ├── NODE_VS_PYTHON_BACKEND.md       #   Node vs Python 결정
│   │   ├── SUPABASE_VS_ONPREM.md           #   Supabase managed 미채택 사유
│   │   └── SUPABASE_GUIDE.md               #   (검토 시점 참고, 이력 보존)
│   ├── product/                            # 제품·마케팅·도입 가이드
│   │   ├── USER_GUIDE.html                 #   시각 가이드 — 9개 화면 walkthrough
│   │   ├── PHASE_1_FOUNDATIONS.html        #   Phase 1 시각 가이드 (6 기둥)
│   │   ├── PHASE_2_FOUNDATIONS.html        #   Phase 2 시각 가이드 (5 기둥)
│   │   ├── PHASE_3_FOUNDATIONS.html        #   Phase 3 시각 가이드 (5 기둥)
│   │   ├── PHASE_4_FOUNDATIONS.html        #   Phase 4 시각 가이드 (5 기둥)
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
# 터미널 2: 백엔드 API + WebSocket (:32173)
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

### 백엔드 (`server/` — Phase 7 Step 1~5 완료, Step 6+ 잔여 P1 bundle 대기)
- **런타임/언어**: Node.js 20+ / TypeScript, dev 포트 `:32173`
- **프레임워크**: Fastify 5 + Socket.io 4 (`/calls` 네임스페이스, JWT handshake + WS persistence + WS suggestion hook)
- **REST 표면**: `/auth/*` · `/me` · `/customers` · `/teams` · `/memberships` · `/invitations` · `/calls` (+ `DELETE /call-action-items/:id`) · `/knowledge/*` · `/dashboard/summary` · `/reports/team-summary`
- **인프라 결정**: 자체 온프레미스 (Supabase managed 미채택 — `docs/decision/SUPABASE_VS_ONPREM.md`)
- **DB**: 직접 운영 PostgreSQL + RLS FORCE default-deny (Phase 1부터, Phase 6 신규 `llm_usage_log` 포함 모든 테이블 동일 패턴)
- **큐/캐시**: Redis + BullMQ (Phase 6에서 `callSummary` 큐 + heartbeat sweep + WS suggestion 영속화 도입, Phase 7 Step 1에서 `email-delivery` 싱글톤 repeatable tick 추가)
- **워커**: `server/src/workers/index.ts` 엔트리 — `dev:worker` script로 별 process 실행. callSummary + heartbeatSweep + emailDelivery 3종. e2e는 inline drain helper(`server/scripts/phase6E2eDrain.ts`)로 처리
- **외부 provider**: Anthropic (LLM) / OpenAI (Embedding) / Clova (STT) + **Resend (Email, Phase 7 Step 1)** 어댑터 wire 완료. provider env unset/`mock`/`dev_outbox`이면 기본 dev/mock, real provider 선택 시 필수 키 누락은 fail-fast
- **이메일 전송 (Phase 7 Step 1)**: `email_outbox`를 transactional delivery outbox로 확장. `EMAIL_PROVIDER=resend` 모드에서는 raw URL을 AES-256-GCM으로 `sensitive_payload_*`에만 저장하고 archive(`body_text`/`metadata`)는 `?token=[redacted]`로 마스킹. 워커가 lease(`FOR UPDATE SKIP LOCKED`) → decrypt → adapter.send → markDelivered+scrub / markRetryableFailure(지수 백오프, 1h cap) / markDeadLetter+scrub. 기본 `dev_outbox` 모드는 Phase 3 동작 그대로 유지
- **Reverse proxy**: Nginx 또는 Caddy (Phase 1+ — `ops/Caddyfile.dev`로 single-origin 변형 제공)

### 외부 연동 (Phase 5~7)
- **STT**: Naver Clova Speech (한국어 영업 도메인 정확도 우선)
- **LLM**: Anthropic Claude / OpenAI GPT — 회사 가이드 RAG 기반
- **Email**: Resend (`EMAIL_PROVIDER=resend` + `RESEND_API_KEY` + `EMAIL_FROM` + `EMAIL_OUTBOX_ENCRYPTION_KEY` 세팅 시 활성, 미설정이면 dev outbox)
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

### v1 — MVP (Phase 1~6 + Phase 7 진행)
- **Phase 1** ✅: PostgreSQL 부트스트랩 + RLS default-deny + 자체 Auth (Argon2id + JWT + refresh rotation) + 클라이언트 wiring + Caddy reverse proxy (Step 1~5)
- **Phase 2** ✅: Customers CRUD + RLS 격리 + 실 API UI + e2e
- **Phase 3** ✅: 회원가입 + 이메일 인증 + 비밀번호 재설정 + 동료 초대 + 팀·멤버 관리 + 마지막 admin 보호
- **Phase 4** ✅: 통화/발화/액션 영속화 + `/calls` REST + `/dashboard/summary` + WS persistence hook + 미인증 mutation 차단 + `phase_4_e2e` 8 시나리오
- **Phase 5** ✅: knowledge base + 체크리스트 + suggestion 영속화 + 통화 detail + manager team-scope mutation + customer selection + `phase_5_e2e`
- **Phase 6** ✅: BullMQ + Redis 워커 (AI 자동 요약 + heartbeat sweep + WS suggestion persistence) + 실 provider 어댑터(Anthropic/OpenAI/Clova) + `llm_usage_log` + action item DELETE + 매니저 보고서(`/reports/team-summary` + `platform/reports.html`) + `phase_6_e2e` 7 시나리오
- **Phase 7 Step 1** ✅: Resend 실 이메일 어댑터 + transactional `email_outbox` (status / sensitive_payload AES-256-GCM 암호화 / partial index) + `QueuedEmailProvider` + `emailDelivery` BullMQ 워커 (lease + decrypt + adapter.send + 지수 백오프 + scrub). 기본 `dev_outbox` 모드는 Phase 3 동작 그대로
- **Phase 7 Step 2** ✅: TOTP MFA (login challenge / 인증된 enroll·disable / 조직 MFA 강제) + `login.html`·`settings.html` frontend wiring
- **Phase 7 Step 3** ✅: `activity_log` schema hardening + repository + service helper (payload sanitizer) + 보안/멤버십/초대/고객/통화/지식/보고서 audit hook + 관리자용 `GET /activity-log` + `settings.html` 관리자 감사 로그 패널
- **Phase 7 Step 4** ✅: retention enforce cron — transcript 3년 hard delete (batch+cap) + email_outbox stuck-sending recovery (`attempt_count` 불변, sensitive payload 보존) + aggregate audit row + BullMQ `retention-sweep` 싱글톤 워커 (`KLOSER_RETENTION_ENABLED`로 gate). call_recordings는 storage 부재로 not applicable
- **Phase 7 Step 5** ✅: `llm_usage_log.cost_usd_micros` price map — Anthropic LLM (Sonnet 4.5/4.6, Opus 4.5/4.6/4.7, Haiku 4.5) + OpenAI text-embedding-3-small/large 가격 상수를 bigint micro-USD로 박고 adapter boundary helper가 integer ceil로 계산. 가격 상수에 official source URL + verified-on 주석. unknown model / missing usage / Clova STT는 `cost_usd_micros=NULL` + `metadata.cost_status` 마커. 과거 row backfill 없음
- **Phase 7 Step 6** ✅: role-based sidebar visibility — `platform/_shared.js`의 `SIDEBAR_NAV_VISIBILITY` 맵 + `canShowSidebarPage(page, role)` + `applySidebarNavVisibility(role)`로 `/me.membership.role` 기반 sidebar nav 표시/숨김. employee/viewer는 `팀 보고서` 숨김, viewer는 `실시간 통화/뉴스레터`도 숨김. pre-/me 상태는 공통 nav만 표시해 flicker 차단. `.nav-item[hidden]` CSS로 `display: flex`보다 우선. backend role policy 무변경
- **Phase 7 Step 7** ✅: 보고서 date window + agent drilldown — `GET /reports/team-summary`에 `from`/`to` query 추가 (omit 시 최근 30일 default, one-sided 400). 응답에 `window` 메타 + `agent_summaries` 배열 추가 (org scope는 unassigned 버킷 포함). 모든 metric/recent/agent SQL에 `started_at >= from_inclusive AND < to_exclusive` 파라미터 필터. `reports.html`에 7/30/90/직접 preset + custom date input + agent row-click drilldown. audit payload에 `from/to/window_days` 추가. **Backward incompat**: omit 시 동작이 전체 기간 → 최근 30일로 좁혀짐 (의도)
- **Phase 7 Step 8** ✅: demo-to-real frontend cleanup — `dashboard.html` `kpiAvgDuration`을 innerHTML → textContent 2-span, API 실패 시 banner (demo fallback 금지), demo sub-section 3곳에 `data-source="demo"`. `daily.html`/`_daily.js` "매일 06:00 자동 갱신" / "네이버 검색 API" 문구 정리 + user-typed 키워드/경쟁사 `escapeHtml` (XSS hole 닫음) + demo 배열을 `DEMO_*` 리네이밍. `newsletter.html` 발송 UI 카피 "발송" → "시뮬레이션" 일관 교체 (상단 통계 4종 `(예시)` 라벨, send modal step1/2/3 + footer 카피), `appendUser` chat 메시지 본문 textContent 전환 (XSS hole 닫음) + custom 템플릿 user-typed 필드 `escapeHtml`. transactional `email_outbox`를 newsletter campaign에 연결 안 함, `activity_log` admin endpoint를 dashboard 팀 활동 feed로 노출 안 함
- **Phase 7 Step 9** ✅: billing / subscription caps — `organizations.plan` starter/pro/enterprise CHECK + `organization_billing_profiles` 신규 (FORCE RLS, DELETE 미부여, trialing backfill). `BILLING_PLAN_LIMITS`(seats 2/10/null, customers 100/1000/null, KB 3/50/null, chunks 500/10k/null, monthly_calls 100/5k/null, llm_cost 5M/100M micro-USD/null, llm_cost는 soft) + `assertPlanAllows`/`assertPlanAllowsAbsolute` + `PlanLimitExceededError`(403, code=plan_limit_exceeded, limit_key/plan/current/limit/attempted). invitations(create+accept)/customers/calls(REST+WS)/knowledge KB/chunk replace 경로에 강제. `GET /billing/overview` + `PATCH /billing/profile` admin 전용. audit payload는 field name only(값 미포함). 외부 provider id는 `external_provider_configured` boolean만 노출. settings.html#billing API-backed 재작성, 가짜 결제 수단/영수증 제거, 모든 서버 값 textContent/input.value 주입 (tax_id XSS 차단 검증)
- **Phase 7 closeout** (다음): 실 결제 provider(Stripe/Toss) 연동 — 외부 돈 이동/회계 계약 동반이라 별도 Phase로 분리
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
