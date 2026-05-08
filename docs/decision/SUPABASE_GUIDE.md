# Kloser Supabase 가이드

> **상태 변경**: 이 문서는 Supabase managed를 검토하던 시점의 참고 문서다. 현재 백엔드 결정은 `docs/plan/roadmap/BACKEND_PLAN.md` v0.4 기준 **자체 온프레미스**다. Supabase managed는 기본 선택에서 제외되었고, Supabase self-hosted는 추후 필요 시 후보로만 검토한다.

> **목적**: Supabase를 선택했을 때의 역할 분담을 기록한 참고 문서다. 현재 구현 계획의 기준 문서는 아니다.

---

## 1. Supabase를 쓰는 이유

Kloser는 고객, 통화, 전사, 팀, 알림, 뉴스레터, 외부 연동 데이터가 모두 조직 단위로 묶이는 B2B SaaS다. 이 구조에서는 다음이 필수다.

- 관계형 데이터 모델
- 조직별 데이터 격리
- 사용자 인증과 세션 관리
- 직원 초대와 권한 관리
- 녹취/첨부 파일 저장
- 운영 가능한 마이그레이션과 백업

Supabase는 이 중 **PostgreSQL, Auth, Storage, RLS**를 한 번에 제공한다. 그래서 Kloser는 인증/DB/파일 저장의 기반 작업을 줄이고, Fastify 서버에서는 제품 고유 로직에 집중할 수 있다.

중요한 점은 Supabase가 Kloser의 전체 백엔드가 아니라는 것이다. Supabase는 인프라 계층이고, 실시간 통화 세션, STT 어댑터, AI 추천, Naver 검색 cron, 뉴스레터 발송, 외부 연동은 Fastify 서버와 worker가 담당한다.

```text
platform/*.html / Desktop app
  -> Fastify API / WebSocket server
    -> Supabase Auth
    -> Supabase PostgreSQL
    -> Supabase Storage
    -> External APIs: Clova, Claude/OpenAI, Naver, Resend, HubSpot
```

---

## 2. Supabase가 담당하는 범위

### 2.1 PostgreSQL

Kloser의 핵심 데이터 저장소다.

대상 데이터:

- 조직: `organizations`
- 구성원/권한: `profiles`, `memberships`, `invitations`
- 고객: `customers`, `customer_notes`, `customer_tags`
- 통화: `calls`, `transcripts`, `call_checklist`, `ai_suggestions`
- Daily: `keywords`, `competitors`, `trend_snapshots`, `todos`
- 뉴스레터: `newsletter_campaigns`, `newsletter_recipients`, `newsletter_templates`
- 알림/감사: `notifications`, `activity_log`
- 통합: `integrations`

PostgreSQL을 쓰는 이유는 Kloser 데이터가 문서형보다 관계형에 가깝기 때문이다. 예를 들어 `organization -> membership -> customer -> call -> transcript -> todo`처럼 조인이 자연스럽고, 권한도 `org_id` 기준으로 관리된다.

### 2.2 Supabase Auth

로그인, 회원가입, 세션 갱신, 비밀번호 재설정, 이메일 인증 같은 일반 인증 기능은 Supabase Auth가 담당한다.

Kloser가 직접 담당하는 것은 제품 도메인에 가까운 부분이다.

- 유저가 어느 조직에 속하는지
- 어떤 role을 가지는지
- 초대 토큰이 어느 조직/역할에 연결되는지
- 퇴사자 데이터를 조직에 남길지
- admin/manager/employee/viewer가 무엇을 할 수 있는지

권장 책임 분리는 다음과 같다.

```text
프론트:
  supabase-js로 signup/login/refresh 수행
  Supabase access token을 Fastify API에 Authorization 헤더로 전달

Fastify:
  access token 검증
  /me 응답
  초대 수락 시 org attach
  role 기반 API 권한 검사

Supabase DB:
  RLS로 org_id 기준 최종 접근 제한
```

### 2.3 Supabase Storage

파일 저장이 필요한 영역에 사용한다.

예상 대상:

- 통화 녹취 파일
- 회사 가이드/FAQ PDF
- 뉴스레터 이미지
- Daily export 결과물
- 고객 첨부 파일

초기 MVP에서는 녹취 원본 저장 여부를 반드시 결정해야 한다. 저장하지 않고 전사만 남기는 옵션도 가능하다. 저장한다면 bucket을 조직 단위로 분리하거나 object path에 `org_id`를 포함하고, Storage policy로 접근을 제한한다.

---

## 3. Fastify와 Supabase의 책임 분리

Supabase를 쓴다고 API 서버가 없어지는 것은 아니다. Kloser는 Fastify 서버가 필요하다.

Fastify가 담당할 일:

- WebSocket 통화 세션 관리
- STT gRPC adapter
- AI 추천/요약 호출
- Naver Search API 호출
- Resend 발송
- HubSpot/Slack 연동
- 비동기 job enqueue
- API 권한 검사
- 도메인 validation
- OpenAPI 문서 생성

Supabase가 담당할 일:

- 데이터 저장
- 인증 세션
- 파일 저장
- RLS 기반 데이터 격리
- DB migration 적용

원칙:

- 클라이언트가 민감한 비즈니스 로직을 직접 Supabase에 쓰지 않는다.
- 단순 조회도 가능하면 Fastify를 통해 시작한다.
- 운영 안정화 후 일부 read-only 화면만 Supabase direct query를 검토한다.
- service role key는 절대 브라우저에 노출하지 않는다.

---

## 4. Kloser 멀티테넌트 설계

Kloser는 회사 단위 SaaS이므로 모든 주요 데이터는 `org_id`를 가져야 한다.

권장 원칙:

- 모든 핵심 테이블에 `org_id uuid not null`
- child table도 가능하면 `org_id`를 직접 가진다.
- RLS policy는 `org_id in user_memberships` 형태로 통일한다.
- API 서버에서도 `org_id`를 명시적으로 검증한다.
- DB가 최종 방어선, Fastify가 1차 방어선이다.

예시:

```sql
create table customers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id),
  name text not null,
  company text,
  email text,
  phone text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

RLS 방향:

```sql
alter table customers enable row level security;

create policy "members can read org customers"
on customers
for select
using (
  exists (
    select 1
    from memberships
    where memberships.org_id = customers.org_id
      and memberships.user_id = auth.uid()
  )
);
```

실제 정책은 role별 권한까지 포함해야 한다.

---

## 5. 권한 모델

역할은 Phase 0.3 기준 네 가지다.

| Role | 권한 방향 |
|---|---|
| `admin` | 조직 설정, 결제, 통합, 모든 데이터 접근 |
| `manager` | 팀 관리, 자기 팀 통계, 팀 고객/통화 접근 |
| `employee` | 자기 고객/통화 R/W, 팀 데이터 일부 read |
| `viewer` | read only |

DB에는 role을 `memberships`에 둔다.

```text
auth.users
  -> profiles
  -> memberships
    -> organizations
```

권한 검사는 두 단계로 한다.

1. Fastify route에서 명시적 검사  
   예: `requireRole(['admin', 'manager'])`

2. Supabase RLS에서 최종 격리  
   예: 해당 `org_id` membership이 없으면 select/update 불가

이중 검사를 두는 이유는 API 실수와 직접 DB 접근 실수를 모두 막기 위해서다.

---

## 6. 초기 스키마 방향

최소 시작 스키마:

```text
organizations
profiles
memberships
invitations
customers
activity_log
```

그 다음 확장:

```text
calls
transcripts
ai_suggestions
call_checklist
notifications
```

이후:

```text
keywords
competitors
trend_snapshots
todos
newsletter_campaigns
newsletter_recipients
newsletter_templates
integrations
```

처음부터 전체 테이블을 모두 만들 수는 있지만, 실제 연동은 `customers.html`부터 진행하는 것이 좋다. 고객 CRUD가 가장 단순하고, API wrapper, RLS, validation, loading/error UI 패턴을 검증하기에 적합하다.

---

## 7. 환경변수

개발 환경:

```env
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
```

주의:

- `SUPABASE_ANON_KEY`는 브라우저에 노출 가능하지만 RLS가 반드시 켜져 있어야 한다.
- `SUPABASE_SERVICE_ROLE_KEY`는 서버 전용이다.
- service role key는 RLS를 우회할 수 있으므로 일반 API 처리에 남용하지 않는다.
- 운영에서는 해당 배포 환경의 secret store에 저장한다.

---

## 8. 마이그레이션 운영

마이그레이션은 Supabase CLI로 관리한다.

권장 흐름:

```bash
supabase migration new init_core_schema
supabase db push
```

원칙:

- DB 변경은 SQL migration으로 남긴다.
- 콘솔에서 직접 만든 변경도 migration으로 되돌려 기록한다.
- RLS policy도 migration에 포함한다.
- seed 데이터는 별도 파일로 관리한다.

---

## 9. 개발 단계별 적용

### Phase 0.5

Supabase 없이도 가능한 Live WebSocket 텍스트 스파이크를 먼저 검증한다. 이 단계의 목적은 실시간 이벤트 구조를 잡는 것이다.

### Phase 1

Supabase Auth, 핵심 조직 스키마, `GET /me`, RLS baseline을 만든다.

### Phase 2

`customers.html`을 실제 DB/API로 전환한다.

### Phase 3

Team/Auth 초대 플로우를 완성한다.

### Phase 4+

Calls, transcripts, notifications, Daily, Newsletter 순서로 확장한다.

---

## 10. Supabase 사용 시 주의점

- RLS가 꺼진 테이블은 멀티테넌트 사고로 이어질 수 있다.
- child table에 `org_id`가 없으면 RLS가 복잡해진다.
- service role key를 편하게 쓰면 RLS의 장점이 사라진다.
- Auth는 쉬워지지만 조직/role 모델은 직접 설계해야 한다.
- 실시간 통화/STT는 Supabase가 해결해주지 않는다.
- 운영 보안 요구가 커지면 자체 Postgres 또는 온프레미스 이전을 검토해야 한다.

---

## 11. 참고 문서

- Supabase Docs: https://supabase.com/docs
- Supabase Auth: https://supabase.com/docs/guides/auth
- Supabase Row Level Security: https://supabase.com/docs/guides/database/postgres/row-level-security
- Supabase Storage: https://supabase.com/docs/guides/storage
- Supabase Self-Hosting: https://supabase.com/docs/guides/self-hosting
