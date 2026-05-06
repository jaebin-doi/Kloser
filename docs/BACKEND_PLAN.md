# Kloser 백엔드 구현 계획 (v0.3)

> **변경 이력**
> - v0.1 → v0.2: 실시간 통화 보조 트랙을 `DESKTOP_APP_PLAN.md`로 분리. 멀티테넌트·Auth 경계·프론트 데이터 계층·큐·보안을 Phase 0/1로 승격. AI 모델 작업별 분리.
> - v0.2 → v0.3: **분리를 잘못 함**. v0.2에서 통화 백엔드(WebSocket 세션·이벤트 스키마·STT 어댑터·calls/transcripts 스키마)까지 데스크톱 트랙으로 같이 보냈는데, 이건 본 트랙의 제품 핵심이라 다시 끌어옴. 데스크톱 앱(Electron/Tauri/WPF, WASAPI 캡처)만 별도 트랙. **Phase 0.5(Live 스파이크)** 신설 — Auth보다 먼저 WebSocket 이벤트 파이프라인을 텍스트 청크로 검증. **첫 완성 CRUD 페이지는 customers.html**로 명시. STT 표현은 "WebSocket 모드"가 아니라 "서버 내부 gRPC STT adapter".
>
> **범위**
> - 포함: 실시간 통화 백엔드(WebSocket 세션·이벤트·STT 어댑터·`live.html`/`calls.html` 백엔드), Customers, Team, Newsletter, Daily, Dashboard, Settings, 알림, 통합
> - 제외: PC 데스크톱 앱 자체(Electron/Tauri/WPF 결정·WASAPI 캡처·디바이스 등록·자동 업데이트·파일럿 환경 표준화) — `docs/DESKTOP_APP_PLAN.md` 참조

---

## Phase 0 — 결정사항 (착수 전 확정)

### 0.1 확정 사항

- **백엔드**: Node.js + Fastify + TypeScript
- **DB / 인증 인프라**: Supabase (PostgreSQL + Auth + Storage)
- **모노레포**: 단일 repo, `server/` 디렉토리 추가

### 0.2 추가 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| **Auth 책임 경계** | 프론트가 `supabase-js`로 signup/login/refresh 직접 호출 → JWT를 Fastify에 보냄 → Fastify는 검증만. 초대 토큰 검증과 org attach만 Fastify 담당 | 책임 단순화, 토큰 갱신 로직 중복 방지, Supabase Auth 기능(SSO, OAuth) 그대로 활용 |
| **큐 / 워커** | BullMQ + Redis. `server/src/jobs/` 디렉토리. 워커 프로세스는 동일 코드베이스에서 별도 entry (`pnpm worker`) | 가이드 11절(Redis Streams 추천)과 정합. BullMQ는 Redis 위에서 retry/backoff/dashboard DX 우수 |
| **프론트 데이터 계층** | `platform/api.js` 신설: `apiFetch()` 래퍼(JWT 자동 첨부·재시도·에러 통일), `escapeHtml()`/`renderList()` 헬퍼, loading/empty/error 상태 패턴 | mock → API 전환 시 동일 패턴 적용. XSS 방지 일원화 |
| **WebSocket 라이브러리** | Socket.io (`@fastify/websocket` 위) | 자동 재연결·room·네임스페이스 기본 제공. 통화 세션 단위 room 관리 자연스러움 |
| **AI 모델** | 작업별 분리. 통화 후 요약·뉴스레터 초안·통화 중 추천 = Claude Sonnet 4.6. 빠른 분류·태깅·감정 = Claude Haiku 4.5. 운영 진입 시 Opus 4.7 비교 | 통화 중 추천은 발화 단위(1~2초)로 묶어 호출 → 저지연 + 품질 균형은 Sonnet |
| **이메일 발송** | Resend | DX·로그·webhook 가장 단순 |
| **시크릿 관리** | `.env` + dotenv (개발), Railway secrets (운영) | 운영 진입 시 Doppler 재검토 |
| **배포** | Railway | WebSocket 대응, 빠른 배포, 비용 합리적 |

### 0.3 보안 / 개인정보 베이스라인 (Phase 1 필수)

`realtime-call-assistant-guide.md` 10절 적용:

- TLS 강제 (Railway 기본)
- 조직별 데이터 분리: 모든 테이블 `org_id` + Supabase RLS
- 역할 기반 접근: admin / manager / employee / viewer
- **감사 로그 (`activity_log`)**: 인증·권한·민감 데이터 변경 모두 기록
- 통화 세션 권한 확인 (사용자가 자기 세션·자기 팀 세션만 접근)
- 녹취/전사 저장 토글 (조직 설정), 보관 기간 설정, 삭제 요청 처리
- 민감정보 마스킹 (전화번호·카드번호 정규식 기반 — Phase 5 시점)
- Supabase service role key는 서버에만, 프론트 노출 금지
- PIPA 컴플라이언스 체크리스트 (`docs/SECURITY.md` — Phase 1 deliverable)

### 0.4 WebSocket 이벤트 스키마 (Phase 0.5에서 확정)

통화 세션 단위 room. 이벤트 4종:

| 방향 | 이벤트 | 페이로드 | 비고 |
|---|---|---|---|
| C→S | `audio_chunk` | `{ seq, mime, data }` | 실제 오디오는 Phase 5부터. 0.5 spike에서는 `text_chunk`로 대체 |
| C→S | `text_chunk` | `{ seq, speaker, text }` | spike 전용 |
| S→C | `transcript` | `{ seq, speaker, text, ts_ms, partial }` | 발화 단위 세그먼트 |
| S→C | `suggestion` | `{ kind, payload }` | kind: `direction` / `script` / `warning` / `action` |
| S→C | `sentiment` | `{ mood, interest, stage }` | 1~2초 단위 |
| S→C | `error` | `{ code, message }` | |

---

## 1. 디렉토리 구조

```
kloser/
├── platform/             # 기존 정적 프론트
│   ├── api.js            # ← 신규: fetch 래퍼 + escape + 상태 헬퍼
│   ├── ws.js             # ← 신규 (Phase 0.5): Socket.io 클라이언트 래퍼
│   └── ... (기존 *.html, _shared.js 등)
├── server/               # ← 신규
│   ├── src/
│   │   ├── routes/       # /customers, /team, /daily, /newsletter, /calls, ...
│   │   ├── ws/           # Socket.io 핸들러 (call session, notifications)
│   │   ├── services/     # 비즈니스 로직
│   │   ├── jobs/         # BullMQ 워커 (cron, fan-out, AI 호출, 통화 후 요약)
│   │   ├── integrations/ # naver-search, hubspot, slack, resend, anthropic, clova
│   │   ├── middleware/   # auth(JWT 검증), rls 컨텍스트, audit log
│   │   ├── db/           # Supabase 클라이언트, 타입 생성물
│   │   └── server.ts
│   ├── migrations/       # supabase/migrations/*.sql
│   ├── package.json
│   └── tsconfig.json
├── shared/               # ← 신규: 프론트·백 공통 TypeScript 타입
│   └── types/
└── docs/
    ├── BACKEND_PLAN.md         (이 문서)
    ├── DESKTOP_APP_PLAN.md     (PC 앱 트랙)
    └── realtime-call-assistant-guide.md
```

---

## 2. 도메인 모델 (DB 스키마)

PK는 모두 `uuid`, `created_at`/`updated_at` 공통. **모든 테이블에 `org_id` 직접 보유** (조인 RLS 회피, 트리거로 부모와 동기화 강제).

### 조직 & 인증
- `organizations` (id, name, plan, settings, created_at)
- `users` (id, org_id, email, name, role, team_id, avatar_url) — Supabase `auth.users`와 1:1
- `teams` (id, org_id, name, manager_id)
- `invitations` (id, org_id, email, role, token, expires_at, accepted_at)
- `activity_log` (id, org_id, user_id, action, target_type, target_id, payload, created_at)

### CRM
- `customers` (id, **org_id**, name, company, email, phone, plan, status, last_contact_at, owner_id)
- `customer_notes` (id, **org_id**, customer_id, author_id, body)
- `customer_tags` (id, **org_id**, customer_id, tag)

### 통화 (Phase 4~5)
- `calls` (id, **org_id**, customer_id, agent_id, started_at, ended_at, duration_s, direction, status, summary, sentiment_score, recording_url)
- `transcripts` (id, **org_id**, call_id, speaker, text, ts_ms, partial, sentiment) — 시계열, 인덱스 (call_id, ts_ms)
- `call_checklist` (id, **org_id**, call_id, item, done)
- `ai_suggestions` (id, **org_id**, call_id, kind, payload, accepted, ts_ms)
- `knowledge_bases` (id, **org_id**, name, kind) — RAG 컨테이너 (Phase 5 후반)
- `knowledge_chunks` (id, **org_id**, kb_id, text, embedding vector(1536)) — pgvector

### Daily / 인사이트
- `keywords` (id, **org_id**, term, source, active)
- `competitors` (id, **org_id**, name, domain, last_checked_at)
- `trend_snapshots` (id, **org_id**, keyword_id, volume, change_rate, articles_count, captured_at) — 시계열
- `todos` (id, **org_id**, assignee_id, body, priority, source, source_ref, status, due_at, completed_at)

### 뉴스레터
- `newsletter_campaigns` (id, **org_id**, subject, body_html, template_id, status, scheduled_at, sent_at, sender_id)
- `newsletter_recipients` (id, **org_id**, campaign_id, customer_id, sent_at, opened_at, clicked_at, bounced)
- `newsletter_templates` (id, **org_id**, name, body_html, system)

### 알림 / 통합
- `notifications` (id, **org_id**, user_id, kind, title, body, link, read_at)
- `integrations` (id, **org_id**, kind, status, credentials_encrypted, settings, last_sync_at)
  - kind: `hubspot` / `slack` / `naver_search` / `resend` / `clova_stt` / `webhook`

> RLS: 각 테이블에 `USING (org_id = auth.jwt() ->> 'org_id'::uuid)`. `service_role` 우회 가능 (서버 워커용).

---

## 3. API 엔드포인트

REST + Socket.io. 모든 엔드포인트 JWT 검증 + org 스코핑.

### Auth (Fastify에 두는 것은 최소)
- `GET  /me` — 현재 유저 + org + role + permissions
- `POST /invitations/accept` — 초대 토큰 검증 + org attach

### Customers
- `GET    /customers?q=&status=&plan=&page=&limit=`
- `POST   /customers`
- `GET    /customers/:id`
- `PATCH  /customers/:id`
- `DELETE /customers/:id`  → soft delete (30일 grace)
- `POST   /customers/import` — HubSpot/CSV (BullMQ로 큐잉)
- `POST   /customers/:id/notes`

### Team
- `GET   /team/members`
- `POST  /team/invitations` — 초대 토큰 발급 + Resend 메일
- `PATCH /team/members/:id`
- `DELETE /team/members/:id`
- `GET   /team/performance?range=7d`

### Calls (Phase 4)
- `GET /calls?status=&customer=&q=&page=&from=&to=`
- `GET /calls/:id` — detail
- `GET /calls/:id/transcript?from_seq=&limit=` — 페이지네이션 / lazy
- `POST /calls/:id/notes`
- `POST /calls` — 수동 생성 (테스트·import용)

### Live 통화 세션 (Socket.io, Phase 0.5 스파이크 → Phase 5 실 STT)
- 네임스페이스: `/calls`
- 인증: JWT (handshake에 토큰)
- 클라이언트가 통화 시작 시 `start_call({ customer_id })` → 서버가 `call_id` 발급, room 조인
- 이후 0.4의 이벤트 4종으로 양방향 스트리밍
- `end_call` → 서버 `calls.ended_at` 기록 → BullMQ `call.summarize` 잡 enqueue

### Dashboard
- `GET /dashboard/summary` — 통화 KPI(오늘 통화·응답률·평균 통화·신규 전환) + 신규 고객·뉴스레터·To-Do
- `GET /dashboard/recent-calls?limit=5`
- `GET /dashboard/recent-activity?limit=10`

### Daily
- `GET  /daily/snapshot?date=YYYY-MM-DD`
- `POST /daily/refresh` — Naver Search 즉시 갱신 트리거 (BullMQ)
- `GET  /trends?range=7d&keyword_id=`
- `CRUD /todos`, `CRUD /keywords`, `CRUD /competitors`

### Newsletter
- `GET   /newsletter/campaigns`
- `POST  /newsletter/campaigns` (draft)
- `PATCH /newsletter/campaigns/:id`
- `POST  /newsletter/campaigns/:id/send` — 즉시/예약 (BullMQ fan-out)
- `GET   /newsletter/campaigns/:id/analytics`
- `CRUD  /newsletter/templates`
- `POST  /newsletter/ai-draft` — Claude Sonnet 4.6
- `POST  /webhooks/resend`

### Settings
- `GET / PATCH /settings/profile`
- `GET / PATCH /settings/company`
- `GET / PATCH /settings/integrations/:kind`
- `POST /settings/integrations/:kind/test`
- `POST /webhooks/:kind/incoming`

### Notifications
- `GET   /notifications?unread=true&limit=`
- `PATCH /notifications/:id/read`
- `POST  /notifications/mark-all-read`
- Socket.io 네임스페이스 `/notifications` — 실시간 푸시

---

## 4. 외부 연동

| 통합 | 용도 | Phase | 인증 | 주의 |
|---|---|---|---|---|
| **Supabase** | DB · Auth · Storage · Realtime | 1 | Service Role / anon Key | RLS 정책 누락 주의 |
| **Naver Search** | Daily 트렌드 | 6 | Client ID/Secret | 일일 25,000 호출. `trend_snapshots`에 캐시 |
| **Resend** | 이메일 (초대·뉴스레터·알림) | 3 | API Key | webhook으로 open/click/bounce |
| **Anthropic Claude** | 통화 후 요약, 통화 중 추천(RAG), 뉴스레터 초안 | 5 | API Key | Sonnet 4.6 기본, Haiku 4.5 분류용 |
| **Naver Clova STT** | 실시간 전사 | 5 | gRPC API Key | **서버 내부 gRPC STT adapter** — 클라는 WS로 오디오 → 서버가 PCM 16kHz mono로 정규화 → Clova gRPC streaming → 결과를 다시 WS로 클라에 푸시. 클라가 직접 Clova에 붙지 않음 |
| **HubSpot** | 고객 단방향 sync (HubSpot → Kloser, read-only) | 6 | OAuth2 | 양방향은 후순위 |
| **Slack** | 알림 outbound | 6 | Webhook URL | 단순 |

---

## 5. 인증 & 권한 모델

### Auth 흐름
```
[브라우저]
  supabase-js.signInWithPassword() → JWT (access + refresh)
  localStorage 저장, 자동 갱신
       │
       │ REST: Authorization: Bearer <jwt>
       │ WS:   handshake auth.token = <jwt>
       ▼
[Fastify]
  authPlugin: JWT 검증 (Supabase JWKS) → req.user = { id, org_id, role }
  rlsPlugin: PostgREST set_config로 org_id 세션 주입
  routeHandler: 권한 체크 → DB 호출 (RLS 자동 필터)
```

### 역할 권한 매트릭스
| 액션 | admin | manager | employee | viewer |
|---|---|---|---|---|
| 조직 설정·결제 | ✓ | | | |
| 멤버 초대 / 역할 변경 | ✓ | ✓ (자기 팀) | | |
| 모든 고객·통화 read | ✓ | ✓ (자기 팀) | ✓ (담당) | ✓ |
| 고객 write | ✓ | ✓ | ✓ (담당) | |
| 통화 세션 시작 | ✓ | ✓ | ✓ | |
| 뉴스레터 발송 | ✓ | ✓ | | |
| 통합 설정 | ✓ | | | |

### 초대 플로우
1. admin/manager → `POST /team/invitations` (이메일 + 역할)
2. 서버: 토큰 발급 → `invitations` 저장 → Resend 메일 (Phase 3 이후)
3. 수신자: 초대 링크 → `supabase-js.signUp()`
4. 가입 완료 → 프론트 `POST /invitations/accept` (토큰 + 새 user_id)
5. 서버: 토큰 검증 → `users`에 org_id/role 부여 → `accepted_at` 기록

---

## 6. 단계별 로드맵

### Phase 0.5 — Live 스트림 스파이크 (3~5일) ⭐ 최우선
**가설**: "이벤트 기반 실시간 통화 콘솔 흐름이 실제로 동작하고, 우리가 만드는 게 진짜 Kloser 백엔드인지 확인."

- [ ] `server/` 부트스트랩 (Fastify + TS + pino + Socket.io)
- [ ] `/calls` 네임스페이스에 `start_call` / `end_call` / `text_chunk` 핸들러 (오디오 없이 텍스트로)
- [ ] 서버가 더미 워커로 `transcript` / `suggestion` / `sentiment` 이벤트를 1~2초 간격으로 푸시 (스크립트 기반)
- [ ] `platform/ws.js` Socket.io 클라이언트 래퍼
- [ ] `live.html`의 `setTimeout` 시뮬레이션을 WS 이벤트 핸들러로 교체 (UI는 그대로)
- [ ] 평균 라운드트립 지연 측정 (목표: 3초 이내)
- [ ] 세션 권한 모델 초안 (`call_id` 기반 room 격리, 인증되지 않은 클라는 join 거부)
- [ ] 0.4의 이벤트 스키마 확정·문서화

**완료 정의**: 두 개 브라우저 탭에서 같은 세션에 join 불가능 (다른 user)·같은 user는 join 가능. 텍스트 청크 보내면 1~3초 안에 transcript/suggestion/sentiment 이벤트가 양쪽 탭의 live.html에 표시됨.

### Phase 1 — Auth + 공통 API 기반 (1~1.5주)
- [ ] Supabase 프로젝트 생성, `organizations`/`users`/`teams`/`invitations`/`activity_log` 마이그레이션
- [ ] Auth 미들웨어 (JWT 검증 + RLS 컨텍스트)
- [ ] `GET /me`, `POST /invitations/accept`
- [ ] **`platform/api.js`** — `apiFetch()` 래퍼, escape, loading/empty/error 헬퍼
- [ ] Phase 0.5의 스파이크 코드를 Auth 적용으로 업그레이드 (handshake JWT)
- [ ] seed 데이터: 데모 org 1개 + 현재 mock과 유사한 멤버 14명
- [ ] PIPA 컴플라이언스 체크리스트 (`docs/SECURITY.md`)
- [ ] CI: lint + test + 타입 체크 + Railway 배포

### Phase 2 — Customers (첫 완성 CRUD) (1주)
- [ ] `customers` / `customer_notes` / `customer_tags` 스키마 + RLS
- [ ] `/customers` CRUD 5종 + 검색·필터·페이지네이션
- [ ] `customers.html` mock 제거 → API 연결 (`api.js` 패턴 검증)
- [ ] loading / empty / error 상태 일관 적용
- [ ] activity_log 기록 (생성·삭제·소유권 변경)

### Phase 3 — Team & 권한 + Resend (1~1.5주)
- [ ] `teams` / `invitations` 스키마
- [ ] `/team/members` GET/PATCH/DELETE, `/team/invitations` POST
- [ ] 역할 매트릭스 미들웨어 적용
- [ ] Resend 도입 + 도메인 검증 + 초대 메일 발송
- [ ] `team.html` mock 제거
- [ ] 알림 시스템: `notifications` 스키마 + Socket.io `/notifications` + `_shared.js` 알림 패널 연결

### Phase 4 — Calls + Dashboard (1.5~2주)
- [ ] `calls` / `transcripts` / `call_checklist` / `ai_suggestions` 스키마 + RLS
- [ ] `/calls` REST (목록·상세·트랜스크립트 페이지네이션·노트)
- [ ] `calls.html` mock 제거 → API 연결
- [ ] `/dashboard/summary` + `/dashboard/recent-calls` + `/dashboard/recent-activity`
- [ ] `dashboard.html` 통화 KPI 실데이터 연결
- [ ] BullMQ 잡: `call.summarize` (통화 종료 시 요약 생성)
- [ ] 트랜스크립트 lazy loading (긴 통화 대비)

### Phase 5 — Live 실제 STT + AI (2~3주)
- [ ] **서버 내부 gRPC STT adapter** (`server/src/integrations/clova/`): 들어오는 PCM 청크 → 16kHz mono 정규화 → Clova gRPC streaming → 결과 콜백
- [ ] 0.5의 `text_chunk` 경로를 `audio_chunk` 경로로 확장 (둘 다 유지: demo mode와 real mode)
- [ ] 발화 단위 세그먼트 처리 + VAD 후처리
- [ ] BullMQ 잡: `ai.suggest` (1~2초 단위 배치, RAG 기반 추천)
- [ ] `knowledge_bases` / `knowledge_chunks` (pgvector) + 관리자 페이지에서 FAQ/스크립트 등록
- [ ] 민감정보 마스킹 (전화·카드 정규식)
- [ ] 실패 시 fallback: text demo mode 자동 전환
- [ ] 평균 지연 3초 이내 검증

### Phase 6 — Daily + Newsletter + Integrations (2~3주)
- [ ] `keywords`/`competitors`/`trend_snapshots`/`todos` + Naver Search 통합 + 매일 06:00 KST cron
- [ ] `daily.html` mock 제거
- [ ] 뉴스레터 캠페인·템플릿·수신자 + Resend fan-out + open/click/bounce
- [ ] `POST /newsletter/ai-draft` (Claude Sonnet 4.6)
- [ ] `newsletter.html` mock 제거
- [ ] `settings.html` 모든 섹션 API 연결
- [ ] HubSpot 단방향 sync (BullMQ 주기 잡), Slack outbound
- [ ] `integrations` 자격증명 암호화 (pgcrypto)

---

## 7. 비기능 요구사항

- **로깅**: pino (구조화 JSON). 운영 진입 시 Axiom/Datadog
- **에러**: Sentry (Phase 1부터)
- **테스트**: vitest + supertest. RLS 정책은 단위 테스트 필수. WS 흐름은 e2e (소켓 클라이언트로)
- **마이그레이션**: Supabase CLI. forward-only
- **API 문서**: `@fastify/swagger` (REST) + 0.4 이벤트 스키마(WS) 별도 md
- **CI/CD**: GitHub Actions — lint/test/typecheck → main 푸시 시 Railway 배포
- **타입 동기화**: `supabase gen types typescript` → `shared/types/db.ts`

---

## 8. 미정 / 추후 검토

- **녹취 저장**: Supabase Storage vs S3 vs 미저장 — 법무·PIPA 검토 (Phase 5 진입 전)
- **STT 비용**: Clova vs Deepgram vs OpenAI Realtime — Phase 5 직전 실측
- **결제**: Stripe vs Toss — Phase 6 이후
- **다국어**: 한국어만. 영어 시점 미정
- **모바일**: 반응형 웹만
- **백업**: Supabase 일일 백업 충분한가? PITR 필요 여부

---

## 9. 다음 액션

1. Phase 0.2 결정사항 사용자 최종 확인
2. **Phase 0.5 착수** — `server/` 부트스트랩 + Socket.io + live.html 텍스트 spike

---

## 부록 A — 외부 트랙

- **`docs/DESKTOP_APP_PLAN.md`** — PC 데스크톱 앱(Electron/Tauri/WPF, WASAPI 캡처, 디바이스 등록, 자동 업데이트, 파일럿 환경 표준화). 본 트랙의 통화 백엔드와 인터페이스는 0.4의 이벤트 스키마로 고정
- **`docs/realtime-call-assistant-guide.md`** — 제품 정의 (단일 진실원)
