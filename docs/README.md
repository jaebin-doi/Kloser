# Kloser docs

문서 루트 인덱스입니다. 주제별 5개 폴더 + 두 개의 진입점 (`USER_GUIDE_PHASE_1.md`, 본 인덱스)으로 구성됩니다.

## 빠른 진입

| 너는 누구? | 어디부터? |
|---|---|
| **제품을 평가/검토하는 입장 — 화면을 빠르게 둘러보고 싶다** | [`product/USER_GUIDE.html`](product/USER_GUIDE.html) — 9개 화면 시각 walkthrough |
| **Phase 1이 만든 기반 기능을 시각적으로 이해하고 싶다** | [`product/PHASE_1_FOUNDATIONS.html`](product/PHASE_1_FOUNDATIONS.html) — 6 기둥 (로그인/조직/권한/세션/실시간/데이터) 시각 가이드 |
| **위와 같은 내용을 텍스트로 읽고 싶다** | [`USER_GUIDE_PHASE_1.md`](USER_GUIDE_PHASE_1.md) — 동일 내용의 텍스트 reference |
| **이 레포를 받아서 로컬에서 띄우고 싶다 (개발자)** | [`server/README.md`](../server/README.md) — 실행·검증·엔드포인트 |
| **상위 백엔드 로드맵이 궁금하다** | [`plan/BACKEND_PLAN.md`](plan/BACKEND_PLAN.md) |
| **Phase 1의 진행 상태가 궁금하다** | [`plan/PHASE_1_MASTER.md`](plan/PHASE_1_MASTER.md) |
| **특정 sub-step의 결정과 결과를 보고 싶다** | `plan/PHASE_1_STEP_*` (계획) + `plan/PHASE_1_STEP_*_FINDINGS` (결과) |
| **마케팅/도입/요금 관련 자료** | [`product/`](product/) |

## 폴더별 분류

### `plan/` — Phase별 실행 계획 + 결과 인계 (총 14개)

상위 백엔드 로드맵 + Phase 0.5 spike + Phase 1 sub-steps 1~5의 계획서와 findings 인계 문서.

| 파일 | 내용 |
|---|---|
| [`BACKEND_PLAN.md`](plan/BACKEND_PLAN.md) | v0.4 자체 온프레미스 + Phase별 로드맵 (전체 SSOT) |
| [`DESKTOP_APP_PLAN.md`](plan/DESKTOP_APP_PLAN.md) | PC 데스크톱 앱 트랙 (보류) |
| [`PHASE_0_5_LIVE_SPIKE.md`](plan/PHASE_0_5_LIVE_SPIKE.md) | live stream 스파이크 실행 계획 |
| [`PHASE_0_5_FINDINGS.md`](plan/PHASE_0_5_FINDINGS.md) | spike 결과 + Phase 1 후속 task 인계 |
| [`PHASE_1_MASTER.md`](plan/PHASE_1_MASTER.md) | Phase 1 마스터 — 5개 sub-step 진행 상태 |
| [`PHASE_1_STEP_1_DB_INFRA.md`](plan/PHASE_1_STEP_1_DB_INFRA.md) | Step 1 — DB 인프라 (postgres + migration + RLS + seed) |
| [`PHASE_1_STEP_1_FINDINGS.md`](plan/PHASE_1_STEP_1_FINDINGS.md) | Step 1 결과 인계 |
| [`PHASE_1_STEP_2_RLS_CONTEXT.md`](plan/PHASE_1_STEP_2_RLS_CONTEXT.md) | Step 2 — RLS SET LOCAL + 격리 테스트 |
| [`PHASE_1_STEP_2_FINDINGS.md`](plan/PHASE_1_STEP_2_FINDINGS.md) | Step 2 결과 인계 |
| [`PHASE_1_STEP_3_AUTH_CORE.md`](plan/PHASE_1_STEP_3_AUTH_CORE.md) | Step 3 — Argon2id + JWT + sessions rotation |
| [`PHASE_1_STEP_3_FINDINGS.md`](plan/PHASE_1_STEP_3_FINDINGS.md) | Step 3 결과 인계 |
| [`PHASE_1_STEP_4_CLIENT_WIRING.md`](plan/PHASE_1_STEP_4_CLIENT_WIRING.md) | Step 4 — Client wiring + WS handshake auth |
| [`PHASE_1_STEP_4_FINDINGS.md`](plan/PHASE_1_STEP_4_FINDINGS.md) | Step 4 결과 인계 |
| [`PHASE_1_STEP_5_REVERSE_PROXY.md`](plan/PHASE_1_STEP_5_REVERSE_PROXY.md) | Step 5 — Caddy reverse proxy (진행 예정) |

### `decision/` — 기술 선택 트레일 (총 4개)

특정 기술/라이브러리/플랫폼을 채택 또는 거부한 이유를 기록.

| 파일 | 내용 |
|---|---|
| [`FASTIFY_GUIDE.md`](decision/FASTIFY_GUIDE.md) | Fastify 도입 근거 + 패턴 |
| [`NODE_VS_PYTHON_BACKEND.md`](decision/NODE_VS_PYTHON_BACKEND.md) | Node vs Python 결정 트레일 |
| [`SUPABASE_VS_ONPREM.md`](decision/SUPABASE_VS_ONPREM.md) | Supabase managed 미채택 사유 |
| [`SUPABASE_GUIDE.md`](decision/SUPABASE_GUIDE.md) | Supabase 검토 시점 참고 (이력 보존) |

### `ops/` — 운영·인프라 메모 (총 3개)

서버 사양, 가용성 구성, 보안 베이스라인.

| 파일 | 내용 |
|---|---|
| [`R730xd_server_setup.md`](ops/R730xd_server_setup.md) | 자체 서버 용량 산정 |
| [`SLA_99.9%_서버_구성_정리.md`](ops/SLA_99.9%_서버_구성_정리.md) | HA 구성 (LB / app / PG / Redis) |
| [`운영_핵심_개선_정리.md`](ops/운영_핵심_개선_정리.md) | RLS / 감사로그 / 마스킹 등 보안 베이스라인 |

### `product/` — 제품·마케팅·도입 가이드 (총 5개)

고객 또는 의사결정자 대상 자료.

| 파일 | 내용 |
|---|---|
| [`USER_GUIDE.html`](product/USER_GUIDE.html) | **시각 가이드** — 9개 화면 walkthrough + 현재/예정 구분 |
| [`PHASE_1_FOUNDATIONS.html`](product/PHASE_1_FOUNDATIONS.html) | **Phase 1 기반 기능 시각 가이드** — 로그인/조직 분리/권한/세션/실시간 연결/데이터 보호 6 기둥 |
| [`pricing.md`](product/pricing.md) | 가격 정책 (내부 SSOT) |
| [`guide.html`](product/guide.html) | 도입 가이드 (고객용 — 정적 HTML) |
| [`realtime-call-assistant-guide.md`](product/realtime-call-assistant-guide.md) | 제품·아키텍처 정의 (단일 진실원) |

### `research/` — 시장·비용 분석 (총 2개)

외부 시장 또는 외부 서비스 비용 비교.

| 파일 | 내용 |
|---|---|
| [`실시간-STT-시장분석-2026.md`](research/실시간-STT-시장분석-2026.md) | 실시간 STT 시장 분석 (2026) |
| [`AZURE_SPEECH_COST_GUIDE_2026.md`](research/AZURE_SPEECH_COST_GUIDE_2026.md) | Azure Speech 비용 가이드 (2026) |

## 분류 원칙 (왜 이렇게 나눴나)

- **`plan/`** — "**언제 무엇을 할지**". Phase별 실행 계획과 그 결과 인계. 시간 흐름이 핵심.
- **`decision/`** — "**왜 그 기술을 선택했나**". 시간이 지나도 가치가 유지되는 reasoning trail.
- **`ops/`** — "**어떻게 운영할지**". 인프라 사양과 운영 기준선.
- **`product/`** — "**무엇을 누구에게 팔지**". 외부(고객) 또는 의사결정자 대상.
- **`research/`** — "**외부 환경에 대한 사실 정리**". 시장/가격/경쟁사 분석.

새 문서 추가 시 위 5개 중 가장 가까운 폴더에 넣으세요. 어디에도 안 맞으면 `docs/` 루트에 두기보다 5개 카테고리를 재검토하는 게 좋습니다.
