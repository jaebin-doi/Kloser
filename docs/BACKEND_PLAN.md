# Kloser 백엔드 구현 계획 (v0.4, On-Premise)

> **결정 변경**
> - v0.3까지는 Supabase managed를 DB/Auth/Storage 인프라로 가정했다.
> - v0.4부터는 **자체 서버 온프레미스 배포**를 기본 전제로 한다.
> - 이유: 자체 서버 보유, 자체 배포 예정, 클라우드 사용량 과금 리스크 회피, 개발 속도가 최우선이 아님.

---

## 0. 최종 아키텍처 결정

### 확정 사항

- **백엔드**: Node.js + Fastify + TypeScript
- **배포**: 자체 서버 온프레미스
- **DB**: 직접 운영 PostgreSQL
- **인증**: Fastify 자체 Auth 구현을 기본값으로 시작
- **파일 저장**: 자체 서버 파일 스토리지 또는 MinIO
- **큐/워커**: Redis + BullMQ
- **Reverse proxy / TLS**: Nginx 또는 Caddy
- **모노레포**: 단일 repo, `server/` 디렉토리 추가

### Supabase managed 제외

Supabase managed는 사용하지 않는다.

이유:

- 클라우드 비용과 egress 비용이 리스크
- 자체 서버에서 배포/운영할 계획
- Auth/DB/Storage를 직접 운영할 여력이 있음
- 개발 속도보다 비용 통제와 데이터 통제가 중요함

### Supabase self-hosted는 보류

Supabase self-hosted는 후보로는 가능하지만 기본값으로 두지 않는다.

이유:

- Supabase Auth/Storage/Studio를 묶음으로 가져올 수 있음
- 하지만 구성요소가 많아져 운영 복잡도가 증가
- Kloser MVP에 필요한 핵심은 PostgreSQL, Auth, Storage, Redis 정도라 직접 구성하는 편이 더 단순함

---

## 1. 온프레미스 전체 구조

```text
[Browser / Platform HTML]
[Desktop App - 별도 트랙]
          |
          | HTTPS / WebSocket
          v
[Nginx or Caddy]
          |
          v
[Fastify API + WebSocket Server]
          |
          +--> [PostgreSQL]
          +--> [Redis + BullMQ]
          +--> [File Storage / MinIO]
          +--> [External APIs]
                 - Clova STT
                 - Claude/OpenAI
                 - Naver Search
                 - Resend or SMTP
                 - HubSpot / Slack
```

Fastify는 제품 로직의 중심이다. PostgreSQL은 직접 운영하고, 인증도 Fastify가 발급하는 JWT/session 기반으로 시작한다.

---

## 2. 서버 디렉토리 구조

```text
kloser/
├── platform/
│   ├── api.js              # fetch wrapper, auth token, error handling
│   ├── ws.js               # WebSocket/Socket.io client wrapper
│   └── ...
├── server/
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── app.ts
│   │   ├── server.ts
│   │   ├── worker.ts
│   │   ├── config/
│   │   │   └── env.ts
│   │   ├── plugins/
│   │   │   ├── db.ts
│   │   │   ├── auth.ts
│   │   │   ├── cors.ts
│   │   │   ├── cookies.ts
│   │   │   └── socket.ts
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── me.ts
│   │   │   ├── customers.ts
│   │   │   ├── team.ts
│   │   │   ├── calls.ts
│   │   │   ├── dashboard.ts
│   │   │   ├── daily.ts
│   │   │   ├── newsletter.ts
│   │   │   └── settings.ts
│   │   ├── services/
│   │   ├── repositories/
│   │   ├── ws/
│   │   ├── jobs/
│   │   ├── integrations/
│   │   │   ├── clova/
│   │   │   ├── anthropic/
│   │   │   ├── openai/
│   │   │   ├── naver/
│   │   │   ├── mail/
│   │   │   └── hubspot/
│   │   ├── schemas/
│   │   └── utils/
│   ├── migrations/
│   └── seeds/
├── shared/
│   └── types/
└── ops/
    ├── docker-compose.yml
    ├── nginx/
    ├── postgres/
    └── systemd/
```

---

## 3. 온프레미스 인프라 구성

### 3.1 PostgreSQL

직접 운영 PostgreSQL을 기본 DB로 사용한다.

권장:

- PostgreSQL 16+
- `pgcrypto` 활성화
- `pgvector`는 RAG 단계에서 활성화
- daily backup
- WAL archiving 또는 PITR은 운영 진입 시 적용
- 주요 테이블 `org_id` index 필수

마이그레이션 도구:

- 1순위: `node-pg-migrate`
- 대안: `drizzle-kit` 또는 `knex`

초기에는 ORM보다 SQL migration + repository 계층을 권장한다. RLS, index, partial index, partition 같은 DB 기능을 명시적으로 다루기 쉽다.

### 3.2 Auth

초기 기본값은 자체 Auth다.

구성:

- password hash: Argon2id
- access token: JWT, 짧은 만료
- refresh token: DB 저장, rotation
- session table: `sessions`
- email verification: Phase 2 이후
- password reset: Phase 2 이후
- SSO/SAML: Enterprise 단계에서 Keycloak 검토

Keycloak은 처음부터 도입하지 않는다. 이유는 MVP의 조직/권한 모델을 우리가 먼저 확정해야 하고, Keycloak은 운영 구성과 개념 비용이 있다. 단, 엔터프라이즈 SSO가 가까워지면 Keycloak을 붙이는 선택지를 열어둔다.

### 3.3 Storage

초기 선택:

- 단일 서버면 로컬 디스크 + metadata table
- 여러 서버 또는 고객별 격리가 필요하면 MinIO

대상:

- 통화 녹취
- 회사 가이드/FAQ PDF
- 뉴스레터 이미지
- export 결과물

초기 MVP에서는 녹취 원본 저장을 기본 OFF로 둔다. 전사 저장만 먼저 구현하고, 녹취 저장은 조직 설정으로 켜는 구조가 안전하다.

### 3.4 Redis + BullMQ

비동기 작업은 HTTP 요청 안에서 직접 처리하지 않는다.

Job 종류:

- `call.summarize`
- `ai.suggest`
- `daily.refresh`
- `newsletter.send`
- `hubspot.sync`
- `notification.fanout`

Redis는 queue와 rate limit 용도로 쓴다.

### 3.5 Reverse proxy

Nginx 또는 Caddy가 앞단을 맡는다.

역할:

- TLS 종료
- 정적 파일 서빙
- `/api` → Fastify
- `/socket.io` 또는 `/ws` → Fastify WebSocket
- request body limit
- basic rate limit
- access log

---

## 4. 보안 / 개인정보 베이스라인

Phase 1부터 필수:

- HTTPS 강제
- password Argon2id hash
- refresh token rotation
- HttpOnly cookie 또는 Authorization Bearer 중 하나로 정책 확정
- 조직별 데이터 분리: 모든 주요 테이블 `org_id`
- role 기반 권한: `admin`, `manager`, `employee`, `viewer`
- audit log: 인증, 권한 변경, 고객/통화/전사 접근, 삭제 기록
- 통화 전사/녹취 보관 기간 설정
- 삭제 요청 처리
- 민감정보 마스킹: 전화번호, 카드번호, 주민번호 패턴
- 운영자 DB 접근 기록
- DB backup 암호화

**PostgreSQL RLS는 Phase 1부터 default-deny로 켠다.** 모든 org-스코프 테이블에 `org_id` 컬럼 + `ENABLE ROW LEVEL SECURITY` + `USING (org_id = current_setting('app.org_id')::uuid)` 정책. Fastify auth 미들웨어가 매 요청 시작 시 `SET LOCAL app.org_id = '<jwt의 org_id>'`를 트랜잭션에 주입한다. Repository 계층의 `org_id` filter는 RLS와 중복 방어선으로 유지.

이유: repository에서 `org_id` 한 줄 빠뜨리는 실수는 PR 리뷰로 잡기 어렵고 잡혔을 땐 이미 조직 데이터 누출. RLS가 default-deny면 `org_id` 누락 시 결과가 0건이라 조용한 누출이 사고로 즉시 드러남. "운영 전에 RLS 추가"는 첫 고객 데이터가 들어온 뒤가 되어 마이그레이션 비용이 큼 — 처음부터 켜는 것이 노력 차이는 작고 위험 차이는 천 배.

워커 프로세스는 `app.org_id` 주입을 명시적으로 처리하거나 별도의 service-role connection으로 우회 (BullMQ job context에서 `org_id` 페이로드 → 매 쿼리 전에 SET).

---

## 5. 핵심 DB 모델

모든 주요 테이블은 `id uuid`, `org_id uuid`, `created_at`, `updated_at`를 가진다.

### 조직 / 인증

- `organizations`  
  `id`, `name`, `plan`, `settings`

- `users`  
  `id`, `email`, `password_hash`, `name`, `avatar_url`, `email_verified_at`, `disabled_at`

- `memberships`  
  `id`, `org_id`, `user_id`, `role`, `team_id`, `status`

- `sessions`  
  `id`, `user_id`, `refresh_token_hash`, `user_agent`, `ip`, `expires_at`, `revoked_at`

- `teams`  
  `id`, `org_id`, `name`, `manager_id`

- `invitations`  
  `id`, `org_id`, `email`, `role`, `token_hash`, `expires_at`, `accepted_at`

- `activity_log`  
  `id`, `org_id`, `user_id`, `action`, `target_type`, `target_id`, `payload`

### CRM

- `customers`
- `customer_notes`
- `customer_tags`

### 통화

- `calls`
- `transcripts`
- `call_checklist`
- `ai_suggestions`
- `knowledge_bases`
- `knowledge_chunks`

### Daily

- `keywords`
- `competitors`
- `trend_snapshots`
- `todos`

### 뉴스레터 / 알림 / 통합

- `newsletter_campaigns`
- `newsletter_recipients`
- `newsletter_templates`
- `notifications`
- `integrations`

---

## 6. API 설계

### Auth

- `POST /auth/signup`
- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `POST /auth/password/forgot`
- `POST /auth/password/reset`
- `GET /me`
- `POST /invitations/accept`

### Customers

- `GET /customers?q=&status=&plan=&page=&limit=`
- `POST /customers`
- `GET /customers/:id`
- `PATCH /customers/:id`
- `DELETE /customers/:id`
- `POST /customers/:id/notes`

### Team

- `GET /team/members`
- `POST /team/invitations`
- `PATCH /team/members/:id`
- `DELETE /team/members/:id`
- `GET /team/performance?range=7d`

### Calls

- `GET /calls?status=&customer=&q=&page=&from=&to=`
- `POST /calls`
- `GET /calls/:id`
- `GET /calls/:id/transcript?from_seq=&limit=`
- `POST /calls/:id/notes`
- `POST /calls/:id/end`

### Live WebSocket

네임스페이스: `/calls`

클라이언트 → 서버:

- `start_call`
- `text_chunk` (Phase 0.5 spike)
- `audio_chunk` (Phase 5)
- `end_call`

서버 → 클라이언트:

- `transcript`
- `suggestion`
- `sentiment`
- `checklist_update`
- `error`

### Dashboard / Daily / Newsletter / Settings

v0.3의 endpoint 구조를 유지하되, 인증과 DB 접근은 자체 Auth/PostgreSQL 기준으로 구현한다.

---

## 7. 외부 연동

| 통합 | 용도 | Phase | 주의 |
|---|---|---:|---|
| Naver Clova STT | 실시간 전사 | 5 | 서버 내부 gRPC adapter. 클라이언트가 직접 Clova에 붙지 않음 |
| Claude/OpenAI | 통화 추천, 요약, 뉴스레터 초안 | 5~6 | 작업별 모델 분리, rate limit 필요 |
| Naver Search | Daily 트렌드 | 6 | cron + cache 필수 |
| SMTP/Resend | 초대, 알림, 뉴스레터 | 3~6 | 클라우드 비용 회피가 중요하면 자체 SMTP도 후보 |
| HubSpot | 고객 sync | 6 | 초기 read-only |
| Slack | 알림 outbound | 6 | webhook |

---

## 8. 단계별 로드맵

### Phase 0.5 — Live 스트림 스파이크 (3~5일)

목표: Auth/DB보다 먼저 Kloser 핵심인 실시간 이벤트 파이프라인을 확인한다.

- [ ] `server/` Fastify + TypeScript 부트스트랩
- [ ] Socket.io 또는 native WebSocket 적용
- [ ] `/calls` namespace
- [ ] `start_call`, `text_chunk`, `end_call`
- [ ] 서버가 더미 `transcript`, `suggestion`, `sentiment` 이벤트 푸시
- [ ] `platform/ws.js` 추가
- [ ] `live.html`의 `setTimeout` mock을 WebSocket 이벤트 기반으로 교체
- [ ] 지연시간 측정

완료 기준: 텍스트 청크를 보내면 1~3초 안에 transcript/suggestion/sentiment가 live 화면에 표시된다.

### Phase 1 — 온프레미스 기반 + 자체 Auth (1.5~2주)

- [ ] `ops/docker-compose.yml`: postgres, redis, app
- [ ] PostgreSQL migration 도구 적용
- [ ] core schema: organizations, users, memberships, sessions, teams, invitations, activity_log
- [ ] **모든 org-스코프 테이블 RLS default-deny ENABLE** (Phase 2 이후 추가되는 모든 테이블도 동일 정책 강제)
- [ ] **auth 미들웨어에서 `SET LOCAL app.org_id` 트랜잭션 주입** + 워커 컨텍스트 동등 처리
- [ ] **RLS 격리 단위 테스트**: 다른 org JWT로 타 org 데이터 조회/변경 차단 확인 (PR 머지 게이트)
- [ ] Argon2id password hash
- [ ] login/signup/refresh/logout
- [ ] auth middleware + role middleware
- [ ] `GET /me`
- [ ] `platform/api.js`
- [ ] seed 데이터 (org 2개 이상 — RLS 격리 자체 검증용)
- [ ] Nginx/Caddy reverse proxy 초안

### Phase 2 — Customers 첫 완성 CRUD (1주)

- [ ] customers schema
- [ ] customers repository/service/routes
- [ ] 검색/필터/페이지네이션
- [ ] `customers.html` mock 제거
- [ ] loading/empty/error 상태
- [ ] activity_log 기록
- [ ] org_id 누락 방지 테스트

### Phase 3 — Team + 초대 + 권한 (1~1.5주)

- [ ] team/members API
- [ ] invitations API
- [ ] 초대 메일 발송
- [ ] role matrix 적용
- [ ] `team.html` mock 제거
- [ ] notifications 기본

### Phase 4 — Calls + Dashboard (1.5~2주)

- [ ] calls/transcripts/checklist/suggestions schema
- [ ] calls REST API
- [ ] `calls.html` mock 제거
- [ ] dashboard summary API
- [ ] `dashboard.html` 실데이터 연결
- [ ] `call.summarize` job

### Phase 5 — 실제 STT + AI (2~3주)

- [ ] Clova gRPC STT adapter
- [ ] audio_chunk 처리
- [ ] PCM 16kHz mono 정규화
- [ ] transcript segment 저장
- [ ] AI suggestion job
- [ ] knowledge base + pgvector
- [ ] 민감정보 마스킹
- [ ] 평균 지연 3초 이내 검증

### Phase 6 — Daily / Newsletter / Integrations (2~3주)

- [ ] Naver Search cron
- [ ] daily.html 실데이터 연결
- [ ] newsletter campaign/templates/recipients
- [ ] 발송 queue
- [ ] newsletter.html 실데이터 연결
- [ ] settings.html API 연결
- [ ] HubSpot read-only sync
- [ ] Slack outbound

---

## 9. 운영 배포 방식

초기 단일 서버:

```text
systemd
  - kloser-api.service
  - kloser-worker.service
  - postgresql
  - redis
  - nginx/caddy
```

또는 Docker Compose:

```text
services:
  app
  worker
  postgres
  redis
  minio
  nginx
```

초기에는 Docker Compose가 재현성이 좋다. 운영 안정화 후 systemd + managed local services로 단순화할 수 있다.

필수 운영 작업:

- DB daily backup
- backup restore drill
- log rotation
- disk usage alert
- TLS certificate renewal
- app/worker health check
- Redis persistence 설정
- migration before deploy

---

## 10. 테스트 전략

- unit: services, repositories
- API: Fastify inject/supertest
- auth: signup/login/refresh/logout
- permission: role별 접근 제어
- org isolation: 다른 org 데이터 접근 차단
- WebSocket: text_chunk → transcript/suggestion 이벤트
- Playwright: 기존 smoke test 확장

초기 필수 테스트:

- 비밀번호 hash 검증
- refresh token rotation
- `/me` 인증 성공/실패
- customers CRUD org isolation
- viewer write 차단
- call room unauthorized join 차단

---

## 11. 미정 / 선택 필요

1. Auth token 전달 방식
   - A. HttpOnly cookie
   - B. Authorization Bearer
   - 추천: 웹은 HttpOnly cookie, 데스크톱 앱은 Bearer token

2. 이메일 발송
   - A. 자체 SMTP
   - B. Resend/SES
   - 추천: 초기 자체 SMTP 가능. 뉴스레터 대량 발송 전에는 deliverability 때문에 전문 provider 재검토

3. 파일 저장
   - A. local disk
   - B. MinIO
   - 추천: 초기 local disk, 녹취 저장 켜는 시점에 MinIO

4. Keycloak
   - A. 미도입
   - B. Enterprise SSO 시점 도입
   - 추천: B

> 이전 v0.4 미정 항목 4번 "PostgreSQL RLS"는 §4에서 **Phase 1부터 default-deny ENABLE**로 확정됨 (repository 계층은 중복 방어선으로 유지).

---

## 12. 다음 액션

1. Phase 0.5 착수: `server/` 부트스트랩 + WebSocket live spike
2. `ops/docker-compose.yml` 초안 작성: app, worker, postgres, redis, nginx
3. PostgreSQL migration 도구 확정: `node-pg-migrate` 우선
4. Auth token 전달 방식 확정: 웹은 HttpOnly cookie, 데스크톱 앱은 Bearer token 권장
