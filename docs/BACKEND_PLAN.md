# Kloser 백엔드 구현 계획 (v0.2)

> **변경 이력**
> - v0.1 → v0.2: 실시간 통화 보조 트랙(PC 데스크톱 앱 + STT + RAG)을 `docs/DESKTOP_APP_PLAN.md`로 분리. 멀티테넌트·Auth 경계·프론트 데이터 계층·큐·보안을 Phase 0/1로 승격. AI 모델 선택을 작업별로 분리.
>
> **범위**
> - 포함: Customers, Team, Newsletter, Daily(트렌드/To-Do), Dashboard(통화 외 KPI), Settings, 알림, 통합(HubSpot/Slack)
> - 제외: 실시간 통화 보조 전체(PC 앱·STT·RAG·`live.html`/`calls.html` 백엔드) — `docs/DESKTOP_APP_PLAN.md` 참조

---

## Phase 0 — 결정사항 (착수 전 확정)

### 0.1 확정 사항 (이전 합의)

- **백엔드**: Node.js + Fastify + TypeScript
  - 이유: WebSocket 동시성, 프론트와 타입 공유, AI 작업이 모두 외부 API 호출이라 Python 비교우위 부재
- **DB / 인증 인프라**: Supabase (PostgreSQL + Auth + Storage)
- **모노레포**: 단일 repo, `server/` 디렉토리 추가

### 0.2 추가 결정 사항

| 항목 | 결정 | 이유 |
|---|---|---|
| **Auth 책임 경계** | 프론트가 `supabase-js`로 signup/login/refresh 직접 호출 → JWT를 Fastify에 보냄 → Fastify는 검증만. 초대 토큰 검증과 org attach만 Fastify 담당 | 책임 단순화, 토큰 갱신 로직 중복 방지, Supabase Auth 기능(SSO, OAuth) 그대로 활용 |
| **큐 / 워커** | BullMQ + Redis. `server/src/jobs/` 디렉토리. 워커 프로세스는 동일 코드베이스에서 별도 entry (`pnpm worker`) | 가이드 11절(Redis Streams 추천)과 정합. BullMQ는 Redis 위에서 동작하면서 retry/backoff/dashboard DX 우수 |
| **프론트 데이터 계층** | `platform/api.js` 신설: `apiFetch()` 래퍼(JWT 자동 첨부·재시도·에러 통일), `escapeHtml()`/`renderList()` 헬퍼, loading/empty/error 상태 패턴 | 페이지마다 mock → API 전환 시 동일 패턴 적용. XSS 방지 일원화 |
| **AI 모델** | 작업별 분리. 통화 후 요약·뉴스레터 초안 = Claude Sonnet 4.6. 빠른 분류·태깅 = Claude Haiku 4.5. 운영 진입 시 Opus 4.7 비교. OpenAI는 fallback 후순위 | 본 트랙엔 통화 중 저지연 AI 호출 없음(데스크톱 트랙으로 분리). 품질·비용 균형은 Sonnet이 기본. |
| **이메일 발송** | Resend | DX·로그·webhook 가장 단순 |
| **시크릿 관리** | `.env` + dotenv (개발), Railway secrets (운영) | 운영 진입 시 Doppler 재검토 |
| **배포** | Railway | WebSocket 대응, 빠른 배포, 비용 합리적 |

### 0.3 보안 / 개인정보 베이스라인 (필수)

`realtime-call-assistant-guide.md` 10절을 본 트랙에도 적용. **Phase 1에 반드시 구현**:

- TLS 강제 (Railway 기본)
- 조직별 데이터 분리: 모든 테이블 `org_id` + Supabase RLS
- 역할 기반 접근: admin / manager / employee / viewer
- **감사 로그 (`activity_log`)**: 인증·권한·민감 데이터 변경 모두 기록
- 삭제 요청 처리: 고객 데이터 hard delete API + 30일 grace period 옵션
- 운영자 접근 통제: Supabase service role key는 서버에만, 프론트 노출 금지
- PIPA 컴플라이언스 체크리스트 (별도 문서로 추출 예정 — Phase 1 deliverable)

> 통화 전사·녹취 관련 보안(보관 기간·마스킹 등)은 데스크톱 트랙에서 별도 정의.

---

## 1. 디렉토리 구조

```
kloser/
├── platform/             # 기존 정적 프론트
│   ├── api.js            # ← 신규: fetch 래퍼 + escape + 상태 헬퍼
│   └── ... (기존 *.html, _shared.js 등)
├── server/               # ← 신규
│   ├── src/
│   │   ├── routes/       # /customers, /team, /daily, /newsletter, ...
│   │   ├── services/     # 비즈니스 로직
│   │   ├── jobs/         # BullMQ 워커 (cron, fan-out, AI 호출)
│   │   ├── integrations/ # naver-search, hubspot, slack, resend, anthropic
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
    ├── DESKTOP_APP_PLAN.md     (별도 트랙)
    └── realtime-call-assistant-guide.md
```

---

## 2. 도메인 모델 (DB 스키마)

PK는 모두 `uuid`, `created_at`/`updated_at` 공통. **모든 테이블에 `org_id` 직접 보유** (조인 기반 RLS 회피, 트리거로 부모와 동기화 강제).

### 조직 & 인증
- `organizations` (id, name, plan, settings, created_at)
- `users` (id, org_id, email, name, role, team_id, avatar_url) — Supabase Auth `auth.users`와 1:1 (id 동일)
- `teams` (id, org_id, name, manager_id)
- `invitations` (id, org_id, email, role, token, expires_at, accepted_at)
- `activity_log` (id, org_id, user_id, action, target_type, target_id, payload, created_at) — 감사

### CRM
- `customers` (id, **org_id**, name, company, email, phone, plan, status, last_contact_at, owner_id)
- `customer_notes` (id, **org_id**, customer_id, author_id, body)
- `customer_tags` (id, **org_id**, customer_id, tag)

### Daily / 인사이트
- `keywords` (id, **org_id**, term, source, active)
- `competitors` (id, **org_id**, name, domain, last_checked_at)
- `trend_snapshots` (id, **org_id**, keyword_id, volume, change_rate, articles_count, captured_at) — 시계열
- `todos` (id, **org_id**, assignee_id, body, priority, source, source_ref, status, due_at, completed_at)

### 뉴스레터
- `newsletter_campaigns` (id, **org_id**, subject, body_html, template_id, status, scheduled_at, sent_at, sender_id)
- `newsletter_recipients` (id, **org_id**, campaign_id, customer_id, sent_at, opened_at, clicked_at, bounced)
- `newsletter_templates` (id, **org_id**, name, body_html, system)

### 알림
- `notifications` (id, **org_id**, user_id, kind, title, body, link, read_at)

### 통합
- `integrations` (id, **org_id**, kind, status, credentials_encrypted, settings, last_sync_at)
  - kind: `hubspot` / `slack` / `naver_search` / `resend` / `webhook`

> RLS: 각 테이블에 `USING (org_id = auth.jwt() ->> 'org_id'::uuid)` 형태의 단순 정책. `service_role` 우회 가능 (서버 워커용).

---

## 3. API 엔드포인트

REST 중심. WebSocket은 알림 푸시 한 채널만. 모든 엔드포인트 JWT 검증 + org 스코핑.

### Auth (Fastify에 두는 것은 최소)
- `GET  /me` — 현재 유저 + org + role + permissions
- `POST /invitations/accept` — 초대 토큰 검증 + org attach
- (나머지 signup/login/refresh는 프론트가 supabase-js로 직접 호출)

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
- `POST  /team/invitations` — 초대 토큰 발급 + Resend로 메일 (Phase 2.5에서 Resend 도입 후 활성화, 그 전엔 토큰만 반환)
- `PATCH /team/members/:id` — role/team 변경 (admin/manager만)
- `DELETE /team/members/:id`
- `GET   /team/performance?range=7d`

### Dashboard (통화 외)
- `GET /dashboard/summary` — 신규 고객·뉴스레터 발송·To-Do 진행률·트렌드 변화
- `GET /dashboard/recent-activity?limit=10`

> 통화 관련 KPI는 데스크톱 트랙 완료 후 추가.

### Daily
- `GET  /daily/snapshot?date=YYYY-MM-DD`
- `POST /daily/refresh` — Naver Search 즉시 갱신 트리거 (BullMQ 잡 enqueue)
- `GET  /trends?range=7d&keyword_id=`
- `CRUD /todos`
- `CRUD /keywords`
- `CRUD /competitors`

### Newsletter
- `GET   /newsletter/campaigns`
- `POST  /newsletter/campaigns` (draft)
- `PATCH /newsletter/campaigns/:id`
- `POST  /newsletter/campaigns/:id/send` — 즉시/예약 (BullMQ fan-out)
- `GET   /newsletter/campaigns/:id/analytics`
- `CRUD  /newsletter/templates`
- `POST  /newsletter/ai-draft` — Claude Sonnet 4.6 호출
- `POST  /webhooks/resend` — open/click/bounce 수신

### Settings
- `GET / PATCH /settings/profile`
- `GET / PATCH /settings/company`
- `GET / PATCH /settings/integrations/:kind`
- `POST /settings/integrations/:kind/test` — 연결 테스트
- `POST /webhooks/:kind/incoming` — Slack/HubSpot inbound

### Notifications
- `GET   /notifications?unread=true&limit=`
- `PATCH /notifications/:id/read`
- `POST  /notifications/mark-all-read`
- `WS    /notifications/stream` — 실시간 푸시 (단일 WebSocket 채널)

---

## 4. 외부 연동

| 통합 | 용도 | Phase | 인증 | 주의 |
|---|---|---|---|---|
| **Supabase** | DB · Auth · Storage · Realtime | 1 | Service Role / anon Key | RLS 정책 누락 주의 |
| **Naver Search API** | Daily 트렌드 | 5 | Client ID/Secret | 일일 25,000 호출. 결과는 `trend_snapshots`에 캐시 |
| **Resend** | 이메일 발송 (초대·뉴스레터·알림) | 3 | API Key | webhook으로 open/click/bounce 수신 |
| **Anthropic Claude** | 뉴스레터 AI 초안, 통화 후 요약(데스크톱 트랙) | 6 | API Key | Sonnet 4.6 기본, Haiku 4.5 분류용 |
| **HubSpot** | 고객 단방향 sync (HubSpot → Kloser, read-only) | 7 | OAuth2 | 양방향은 Phase 후순위 |
| **Slack** | 알림 outbound (Incoming Webhook) | 7 | Webhook URL | 단순 |

---

## 5. 인증 & 권한 모델

### Auth 흐름
```
[브라우저]
  supabase-js.signInWithPassword() → JWT (access + refresh)
  localStorage 저장, 자동 갱신
       │
       │ 모든 API 호출에 Authorization: Bearer <jwt>
       ▼
[Fastify]
  authPlugin: JWT 검증 (Supabase JWKS) → req.user = { id, org_id, role }
  rlsPlugin: PostgREST set_config로 org_id를 세션에 주입
  routeHandler: 권한 체크 → DB 호출 (RLS가 자동 필터)
```

### 역할 권한 매트릭스
| 액션 | admin | manager | employee | viewer |
|---|---|---|---|---|
| 조직 설정 변경 | ✓ | | | |
| 결제·플랜 변경 | ✓ | | | |
| 멤버 초대 / 역할 변경 | ✓ | ✓ (자기 팀) | | |
| 모든 고객·통화 read | ✓ | ✓ (자기 팀) | ✓ (담당) | ✓ |
| 고객 write | ✓ | ✓ | ✓ (담당) | |
| 뉴스레터 발송 | ✓ | ✓ | | |
| 통합 설정 | ✓ | | | |

### 초대 플로우
1. admin/manager → `POST /team/invitations` (이메일 + 역할)
2. 서버: 토큰 발급 → `invitations` 저장 → Resend 메일 발송 (Phase 3 이후)
3. 수신자: 초대 링크 클릭 → 프론트 가입 페이지 → `supabase-js.signUp()`
4. 가입 완료 후: 프론트가 `POST /invitations/accept` (토큰 + 새 user_id)
5. 서버: 토큰 검증 → `users` 테이블에 org_id/role 부여 → `accepted_at` 기록

---

## 6. 단계별 로드맵

각 Phase는 독립 배포 가능. 한 번에 한 Phase.

### Phase 1 — 기반 + Customers (1.5~2주)
**가장 먼저 평가하는 가설**: "정적 mock을 API로 대체하는 패턴이 부드럽게 작동하는가?"

- [ ] `server/` 부트스트랩 (Fastify + TS + pino + 기본 plugin)
- [ ] Supabase 프로젝트 생성, `organizations` / `users` / `activity_log` 마이그레이션
- [ ] Auth 미들웨어 (JWT 검증 + RLS 컨텍스트)
- [ ] `GET /me` + `POST /invitations/accept`
- [ ] `customers` 스키마 + RLS + CRUD 5종
- [ ] **`platform/api.js` 신설** — 모든 페이지가 import할 데이터 계층
- [ ] `customers.html` mock 제거 + API 연결 (loading/empty/error 상태 + escape)
- [ ] PIPA 컴플라이언스 체크리스트 문서화 (`docs/SECURITY.md`)
- [ ] CI: lint + test + 타입 체크 + Railway 자동 배포

**완료 정의**: 사용자가 가입 → 고객 추가/수정/삭제/검색 → 새로고침 후 유지. 다른 조직 데이터는 절대 보이지 않음 (RLS 검증).

### Phase 2 — Team & 권한 (1주)
- [ ] `teams` / `invitations` 스키마
- [ ] `/team/members` GET/PATCH/DELETE
- [ ] `/team/invitations` POST — **초대 토큰만 반환** (메일 발송은 Phase 3에서 stub 교체)
- [ ] 역할 기반 권한 미들웨어 + 매트릭스 적용
- [ ] `team.html` mock 제거 + API 연결
- [ ] activity_log 기본 기록 (role 변경, 멤버 추가/삭제)

### Phase 3 — 알림 + Resend 도입 (1주)
- [ ] `notifications` 스키마
- [ ] `/notifications` REST + WebSocket 채널
- [ ] Resend 연동 + 도메인 검증
- [ ] Phase 2의 초대 메일 발송 활성화
- [ ] `_shared.js`의 알림 패널 mock 제거 + API 연결

### Phase 4 — Dashboard (통화 외 KPI) (3~5일)
- [ ] `/dashboard/summary` — 신규 고객·뉴스레터·To-Do 진행률
- [ ] `/dashboard/recent-activity`
- [ ] `dashboard.html` mock 부분 교체 (통화 KPI는 mock 유지 + 배지 "데모")
- [ ] 캐싱: Redis 키 기반 60초 TTL

### Phase 5 — Daily + Naver Search (1.5주)
- [ ] `keywords` / `competitors` / `trend_snapshots` / `todos` 스키마 + CRUD
- [ ] Naver Search 통합 모듈
- [ ] BullMQ cron: 매일 06:00 KST 전사 키워드 갱신
- [ ] `POST /daily/refresh` — 즉시 갱신 잡
- [ ] `daily.html` mock 제거
- [ ] 트렌드 7일 시계열 조회

### Phase 6 — Newsletter (1.5~2주)
- [ ] 캠페인 CRUD + 템플릿 + 수신자 관리
- [ ] BullMQ fan-out 잡: 캠페인 → 수신자별 메일 enqueue → Resend 발송
- [ ] 발송 분석 (open/click/bounce webhook)
- [ ] `POST /newsletter/ai-draft` — Claude Sonnet 4.6
- [ ] `newsletter.html` mock 제거

### Phase 7 — Settings + 통합 (1.5~2주)
- [ ] `settings.html` 모든 섹션 (프로필·회사·통화환경·AI는 stub) API 연결
- [ ] `integrations` 스키마 + 자격증명 암호화(Supabase Vault 또는 pgcrypto)
- [ ] HubSpot OAuth + 고객 단방향 sync (BullMQ 주기 잡)
- [ ] Slack outbound webhook
- [ ] 통합 연결 테스트 (`/settings/integrations/:kind/test`)

---

## 7. 비기능 요구사항

- **로깅**: pino (구조화 JSON). 운영 진입 시 Axiom/Datadog
- **에러**: Sentry (Phase 1부터)
- **테스트**: vitest + supertest. Phase별 핵심 시나리오 E2E 1~2개. RLS 정책은 단위 테스트 필수
- **마이그레이션**: Supabase CLI. 모든 변경은 forward-only migration
- **API 문서**: `@fastify/swagger`로 OpenAPI 자동 생성
- **CI/CD**: GitHub Actions — lint/test/typecheck → main 푸시 시 Railway 배포
- **타입 동기화**: `supabase gen types typescript` 결과를 `shared/types/db.ts`에 커밋

---

## 8. 미정 / 추후 검토

- **결제**: Pro/Enterprise 플랜 — Stripe vs Toss. Phase 7 이후
- **다국어**: 현재 한국어. 영어 지원 시점 미정
- **모바일**: 반응형 웹만. 네이티브 앱 계획 없음
- **데이터 보존 / 삭제 정책**: 고객·뉴스레터는 30일 grace + hard delete. 더 긴 보존이 필요한 항목 있는지 검토
- **백업**: Supabase 기본 일일 백업으로 충분한가? Point-in-time recovery 필요 여부

---

## 9. 다음 액션

1. **Phase 0.2 결정사항 사용자 확인** ← 지금 여기
2. Supabase 프로젝트 생성 + 환경변수 세팅
3. `server/` 부트스트랩 (Fastify + TS + Supabase 클라이언트 + auth 미들웨어)
4. `platform/api.js` 첫 구현
5. Phase 1 착수 (Customers)

---

## 부록 A — 외부 트랙 / 분리된 항목

- **`docs/DESKTOP_APP_PLAN.md`** — 실시간 통화 보조 (PC 데스크톱 앱 + STT + RAG + `live.html`/`calls.html` 백엔드 + 통화 KPI). 본 트랙과 별개로 진행
- **`docs/realtime-call-assistant-guide.md`** — 위 트랙의 단일 진실원

> 이 문서는 살아있는 문서입니다. 단계별 진행 시 결정·변경 사항을 업데이트.
