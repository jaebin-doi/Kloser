# Kloser

> **AI 기반 세일즈 어시스턴트 SaaS — 인바운드 상담부터 고객 관리, 팀 성과까지 한 번에.**

Kloser는 영업 조직이 더 많은 거래를 "Close" 할 수 있도록 돕는 B2B 세일즈 플랫폼입니다. 통화 중 AI가 실시간으로 응대 방향을 제안하고, 통화 후 자동으로 메모를 정리하며, 매일 아침 시장 트렌드 기반의 영업 To-Do를 제시합니다.

```
🚀 라이브 데모  →  platform/dashboard.html (회원가입 없이 바로 체험)
🏠 마케팅 사이트 →  index.html
📑 도입 가이드   →  docs/guide.html
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
| 👥 **고객 관리** | [`platform/customers.html`](platform/customers.html) | 통계 4종 · 6개 필터 · 12명 mock · 신규 추가 모달(실작동) |
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

> **현재 단계**: **Phase 0.5 라이브 스트림 스파이크 완료** — `server/`(Fastify+Socket.io) ↔ `live.html` 사이 `/calls` 네임스페이스가 실제로 동작하고, 수동 RTT 1ms로 검증됨. STT/LLM 연동, Auth, DB, 영속성은 Phase 1+에서.
> 자세한 계획·결과: [`docs/BACKEND_PLAN.md`](docs/BACKEND_PLAN.md), [`docs/PHASE_0_5_LIVE_SPIKE.md`](docs/PHASE_0_5_LIVE_SPIKE.md), [`docs/PHASE_0_5_FINDINGS.md`](docs/PHASE_0_5_FINDINGS.md).

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
│   └── ws.js                 # 🆕 Socket.io 클라이언트 wrapper (window.kloserWS)
│
├── server/                   # 🆕 백엔드 (Phase 0.5 spike) — Fastify + Socket.io + TS
│   ├── README.md             # 실행 방법, 이벤트/엔드포인트 레퍼런스
│   ├── package.json          # fastify · socket.io · tsx · typescript
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts         # Fastify entry — /health + io.attach
│       ├── ws/calls.ts       # /calls 네임스페이스 (start_call/text_chunk/end_call)
│       ├── fixtures/demo-call.ts   # conversation + aiSequence + sentiment
│       └── __test_client.ts        # Day 1 검증용 throwaway (Phase 1에서 삭제)
│
├── docs/
│   ├── guide.html                          # 도입 가이드 (고객용)
│   ├── pricing.md                          # 가격 정책 (내부 SSOT)
│   ├── realtime-call-assistant-guide.md    # 백엔드 구축 가이드 (개발)
│   ├── BACKEND_PLAN.md                     # 🆕 v0.4 자체 온프레미스 + Phase별 로드맵
│   ├── DESKTOP_APP_PLAN.md                 # 🆕 PC 앱 트랙
│   ├── PHASE_0_5_LIVE_SPIKE.md             # 🆕 Phase 0.5 구체 실행 계획 + 진행 로그
│   ├── PHASE_0_5_FINDINGS.md               # 🆕 spike 결과 + Phase 1 후속 task
│   ├── FASTIFY_GUIDE.md                    # 🆕 Fastify 도입 근거
│   ├── NODE_VS_PYTHON_BACKEND.md           # 🆕 Node vs Python 결정 트레일
│   ├── SUPABASE_VS_ONPREM.md               # 🆕 Supabase managed 미채택 사유
│   ├── SUPABASE_GUIDE.md                   #   (Supabase 이전 검토용 참고 문서)
│   ├── R730xd_server_setup.md              # 🆕 자체 서버 용량 산정
│   ├── SLA_99.9%_서버_구성_정리.md         # 🆕 HA 구성 (LB/app/PG/Redis)
│   └── 운영_핵심_개선_정리.md              # 🆕 RLS/감사로그/마스킹 등 보안 베이스라인
│
├── assets/
│   ├── logo.png / logo.svg / logo2.png
│   ├── favicon.svg / favicon.png
│   └── landing_img/          # 히어로 시안 이미지
│
├── test/                     # 자동화 검증 스크립트
│   ├── README.md             # 실행 방법
│   ├── smoke_desktop.py      # 데스크톱 8 페이지 일괄 검증 (Python)
│   ├── smoke_mobile.py       # 모바일 8 페이지 검증 + 사이드바 토글 (Python)
│   ├── smoke_daily.py        # daily.html 단독 검증 (Python)
│   ├── test_features.py      # 알림/Word 등 기능 검증 (Python)
│   ├── screenshots.py        # 스크린샷 자동 캡처 (Python)
│   ├── phase_0_5_e2e.mjs     # 🆕 Phase 0.5 server↔live.html e2e (Node + Playwright)
│   ├── phase_0_5_e2e.png     # 🆕 e2e 스크린샷 (검증 산출물)
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

상세는 [`docs/pricing.md`](docs/pricing.md), [`docs/guide.html`](docs/guide.html) 참고.

---

## 🛠️ 로컬 실행

### 마케팅 사이트 + 플랫폼 데모 (정적)

정적 HTML/JS/CSS만 사용하므로 빌드 없이 단순 HTTP 서버로 띄우면 됩니다.

```bash
# 프로젝트 루트에서
python -m http.server 8765
# (Python alias 미설치 시) npx http-server . -p 8765 --silent

# 브라우저에서:
# 마케팅 사이트   →  http://localhost:8765/
# 플랫폼 데모     →  http://localhost:8765/platform/
# 도입 가이드     →  http://localhost:8765/docs/guide.html
```

### 라이브 통화 백엔드 (`live.html` 실시간 흐름 보기)

`platform/live.html`이 진짜 WebSocket 이벤트로 동작하는 걸 보려면 별도 터미널에서 백엔드를 띄웁니다 (Phase 0.5 spike 결과물).

```bash
cd server
npm install        # 최초 1회
npm run dev        # tsx watch — port 3001
```

이제 `http://localhost:8765/platform/live.html`을 열면 `server/`가 `start_call → transcript/suggestion/sentiment` 시퀀스를 자동으로 푸시합니다. 자세한 내용은 [`server/README.md`](server/README.md).

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

### 백엔드 (`server/` — Phase 0.5 spike 완료, Phase 1 착수 대기)
- **런타임/언어**: Node.js 20+ / TypeScript
- **프레임워크**: Fastify 5 + Socket.io 4 (`/calls` 네임스페이스)
- **인프라 결정**: 자체 온프레미스 (Supabase managed 미채택 — `docs/SUPABASE_VS_ONPREM.md`)
- **DB**: 직접 운영 PostgreSQL + RLS default-deny (Phase 1부터)
- **큐/캐시**: Redis + BullMQ (Phase 4+)
- **Reverse proxy**: Nginx 또는 Caddy (Phase 1+)

### 외부 연동 (Phase 5~6)
- **STT**: Naver Clova Speech (한국어 영업 도메인 정확도 우선)
- **LLM**: Anthropic Claude / OpenAI GPT — 회사 가이드 RAG 기반
- **벡터 검색**: pgvector
- **데스크톱 앱**: Electron 또는 Tauri (Windows + WASAPI 오디오 캡처) — `docs/DESKTOP_APP_PLAN.md`

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
- 결과 정리: [`docs/PHASE_0_5_FINDINGS.md`](docs/PHASE_0_5_FINDINGS.md)

### v1 — MVP (다음 단계, Phase 1~6)
- **Phase 1**: 자체 Auth (JWT) + PostgreSQL 부트스트랩 + RLS default-deny + customers CRUD
- **Phase 2~4**: Team/초대, Calls REST + Dashboard, 실시간 STT(Clova) + AI suggestion
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
