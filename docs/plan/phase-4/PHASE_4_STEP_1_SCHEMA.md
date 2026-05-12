# Phase 4 — Step 1 Schema Plan

> **상위**: `PHASE_4_MASTER.md` §3 Step 1.
> **출력 형태**: 본 문서는 schema 설계서다. 마이그레이션 SQL 파일은 본 문서 통과 후 작성한다.
> **AGENTS.md Phase Workflow §1 (schema migration first)을 따른다.** 본 step 통과까지는 어떤 repo/route/frontend 파일도 만들지 않는다.

---

## 0. Step 1 목표

Phase 4 영속화의 기반이 되는 3개 테이블 (`calls` / `transcripts` / `call_action_items`) + 부속 grant가 RLS FORCE / 인덱스 / 제약 조건 / 트랜잭션 일관성까지 깨끗이 깔린다. Step 2 (repository layer)가 진입할 때 schema가 "이거 어떻게 쓰지" 같은 질문을 만들지 않는다. Demo seed는 schema-only 지시에 따라 후속 step에서 결정한다.

---

## 1. 산출물 (Step 1 통과 시 생성)

| 종류 | 경로 | 비고 |
|---|---|---|
| plan | `docs/plan/phase-4/PHASE_4_STEP_1_SCHEMA.md` | 본 문서 |
| findings | `docs/plan/phase-4/PHASE_4_STEP_1_FINDINGS.md` | 구현 후 결과 인계 |
| migration | `server/migrations/<ts>_phase4_calls.sql` | `calls` 테이블 + RLS 4 정책 + 부분 인덱스 4개 |
| migration | `server/migrations/<ts>_phase4_transcripts.sql` | `transcripts` 테이블 + RLS 4 정책 + 인덱스 2개 |
| migration | `server/migrations/<ts>_phase4_call_action_items.sql` | `call_action_items` 테이블 + RLS 4 정책 + 인덱스 2개 |
| migration | `server/migrations/<ts>_phase4_grants.sql` | `app` role grant: SELECT/INSERT/UPDATE/DELETE on 3 신규 테이블 |
| seed | `server/seeds/0004_phase4_demo.sql` | 후속 step에서 결정 (schema-only Step 1에서는 미작성) |

> **Step 1 구현 결과**: migration 4개 + findings 1개를 생성했다. Demo seed는 후속 step에서 결정한다.

---

## 2. 사전 결정 (Step 1 시작 전 확정)

### 도메인 결정

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 1-1 | `calls.customer_id` NULL 허용 | **YES** — composite FK `(org_id, customer_id) REFERENCES customers(org_id, id) ON DELETE SET NULL (customer_id)` | unknown caller / 등록 안 된 발신자가 거는 통화 케이스. 시간이 지나 매칭되면 service가 UPDATE. Composite FK로 Acme call → Beta customer 오염 차단 |
| 1-2 | `calls.agent_user_id` NULL 허용 | **YES** — composite FK `(org_id, agent_user_id) REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (agent_user_id)` | 사용자가 조직을 떠나도 통화 이력은 보존. NULL이면 "전 사용자"로 표시. Membership FK로 agent가 같은 org 소속임을 DB가 강제 |
| 1-3 | `calls.direction` enum 값 | `'inbound' / 'outbound' / 'meeting'` 3종 | dashboard mock에 "신규 인바운드 / 후속 미팅 / 클로징 / 신규 문의"가 섞여 있지만, `meeting`은 일정 잡힌 후속, `outbound`는 우리가 거는 통화, `inbound`는 들어오는 통화로 정규화. "신규 문의"는 inbound의 한 상태로 흡수 |
| 1-4 | `calls.status` enum 값 | `'in_progress' / 'ended' / 'missed' / 'dropped'` 4종 | `in_progress`는 진행 중. `ended`는 정상 종료. `missed`는 응답 안 됨 (음성 메시지). `dropped`는 네트워크 끊김 (Phase 0.5 spike에서 발견) |
| 1-5 | `calls.duration_seconds` 계산 시점 | service.endCall() 트랜잭션에서 `EXTRACT(EPOCH FROM (ended_at - started_at))::int` | DB GENERATED ALWAYS AS는 timestamptz 차이가 numeric이라 cast 복잡. service에서 한 번 계산이 단순 |
| 1-6 | `calls.summary` / `needs` / `issues` 분리 vs 단일 컬럼 | **분리 3개 컬럼 (text NULL 허용)** | mock UI가 세 영역으로 명확히 구분 (고객 니즈 / 미해결 이슈 / 다음 액션). 합치면 AI 자동 생성 후 분리 어려움 |
| 1-7 | `calls.next_actions` 위치 | **`call_action_items` 별 테이블** (calls 행에 jsonb 컬럼 미사용) | 결정 master §2-7. 1:N + 담당자 / 상태 / 완료 시각이 별개 라이프사이클 |
| 1-8 | `calls.sentiment` 값 | `'positive' / 'neutral' / 'cautious' / 'negative'` 또는 NULL | UI 표시 라벨 ("긍정 / 보통 / 망설임 / 부정")과 1:1. live.html sentiment fixture와 일치. NULL은 분석 전 상태 |
| 1-9 | `calls.notes` 별도 컬럼 | **YES — 자유 형식 text** | UI의 "통화 중 빠른 메모"가 `summary`와 별개. agent의 raw 노트 보존 |
| 1-10 | `calls.title` 자동 생성 | **service 레이어에서 시작 시 `customer.name + ' · ' + direction_label`로 자동 set, 비어도 무방** | 목록에서 식별용. 사용자가 직접 수정 가능 (Phase 4 시점은 mutation 없음, Phase 5+에서 PATCH) |
| 1-11 | `transcripts.seq` 발급 | **server-side service가 `MAX(seq)+1 FOR UPDATE` 패턴 또는 advisory lock** | Step 2 plan에서 정밀화. WS persistence는 통화 1건당 단일 클라이언트라 race 가능성 낮지만, sequence per call PER 통화 advisory lock이 안전 |
| 1-12 | `transcripts.speaker` enum 값 | `'agent' / 'customer' / 'system'` 3종 | live.html은 `who: 'agent' / 'customer'` 둘만. `system`은 "통화 시작 안내" 같은 자동 멘트 (settings 토글 시 inserted) — 도입 여지 |
| 1-13 | `transcripts.confidence` 정밀도 | `numeric(4,3)` (0.000~1.000) | STT 신뢰도 — Phase 0.5 fixture는 1.000 고정. Phase 5 실 STT 도입 시 사용 |
| 1-14 | `call_action_items.due_date` 타입 | **`date` (시각 무관)** | "내일까지" 같은 일 단위. `timestamptz` 까지 정밀도는 불필요 |
| 1-15 | `call_action_items.status` enum | `'open' / 'done' / 'dropped'` 3종 | open이 기본. done은 완료 (`completed_at` 동시 set). dropped는 취소 (예: 고객 변심) |
| 1-16 | `call_action_items.completed_at` | status='done' 변경 시 service가 같은 트랜잭션 안에서 `now()` set | trigger 미사용 — 결정 master §2-5와 일관 |
| 1-17 | `customers.last_contacted_at` 갱신 정책 | service.endCall 트랜잭션 안에서 `UPDATE customers SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, 'epoch'), $ended_at) WHERE id = $customer_id AND org_id = $org_id` | 단조 증가 (옛 통화가 늦게 종료돼도 마지막 연락 시각이 뒤로 가지 않음). customer_id NULL 통화는 갱신 안 함 |
| 1-18 | 시드 데이터 prefix | `phase4test-` 또는 e2e용은 시드와 별개 | dev seed는 prefix 없이 자연스러운 한국어 이름 (시드 customers 12명 활용). e2e가 만드는 임시 데이터만 `phase4test-` prefix |

### 보안 결정

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 2-1 | RLS FORCE 적용 | **3 신규 테이블 모두 `FORCE ROW LEVEL SECURITY`** — Phase 1·2·3 일관 | superuser 외 모든 role이 RLS 강제. app role도 우회 불가 |
| 2-2 | RLS 정책 4종 | SELECT / INSERT WITH CHECK / UPDATE USING+WITH CHECK / DELETE — 모두 `org_id = current_app_org_id()` | Phase 2 customers 4 정책 그대로 |
| 2-3 | `transcripts.org_id` 비정규화 | **YES** — RLS 평가가 JOIN 없이 transcripts.org_id 단독으로. `(org_id, call_id) REFERENCES calls(org_id, id)` composite FK로 drift 차단 | 결정 master §2-2와 일관. service 레이어가 INSERT 시 `calls.org_id`를 넣고 DB가 한 번 더 강제 |
| 2-4 | `kloser_service` (BYPASSRLS) grant | **본 phase에 적용 안 함** | calls 흐름은 모두 인증된 사용자 — anonymous accept 같은 흐름 없음. service role 표 손대지 않음 |
| 2-5 | `app` role grant | SELECT / INSERT / UPDATE / DELETE on `calls` + `transcripts` + `call_action_items` | Phase 2 customers / Phase 3 invitations와 동일. Dev init default privileges가 있어도 migration 계약을 명시하기 위해 별도 grant migration을 둔다 |
| 2-6 | soft delete 정책 표면 | `calls.deleted_at`만 추가. `transcripts` / `call_action_items`는 부모 CASCADE — 독립 soft delete 컬럼 없음 | 결정 master §3과 일관. soft delete된 통화의 발화는 SELECT 시 자연스럽게 부분 인덱스로 제외 (RLS는 그대로 적용되지만 read query가 `WHERE deleted_at IS NULL`을 calls 측에서 거름) |
| 2-7 | `customers.last_contacted_at` UPDATE 권한 | service.endCall이 같은 transaction에서 customers UPDATE — RLS는 `app.org_id` GUC로 동일 org 강제 | 별도 grant 추가 불요 (app role은 이미 customers UPDATE 권한 보유) |
| 2-8 | retention enforce | **DB 레벨 0건** — 모든 retention 정책 표면화는 Phase 6+ (cron / archive) | 결정 master §17과 일관 |

### 기술 결정

| # | 항목 | 결정 | 근거 |
|---|---|---|---|
| 3-1 | migration 분리 단위 | **테이블당 1 file + grant 1 file (총 4 file)** | Phase 1·3 패턴. 한 migration이 한 테이블 책임 — review·rollback 용이 (단, 본 schema는 forward-only이므로 down은 없음) |
| 3-2 | timestamp prefix | `<ts>_phase4_calls.sql` 등 — 기존 패턴 `1715000XXX000` 다음 번호 | Phase 3 마지막 migration은 `1715000008000`. Phase 4는 `1715000009000` ~ `1715000012000` |
| 3-3 | `gen_random_uuid()` 사용 | YES — Phase 1~3 일관 | `uuid_generate_v4()` (pgcrypto extension)와 달리 13+에서 built-in |
| 3-4 | timestamptz vs timestamp | **timestamptz** — Phase 1~3 일관 | server timezone 변경 / 다중 지역 운영 시 안전 |
| 3-5 | FK ON DELETE 정책 | `calls.org_id` CASCADE / `(calls.org_id, calls.customer_id)` SET NULL(customer_id) / `(calls.org_id, calls.agent_user_id)` SET NULL(agent_user_id) / `(transcripts.org_id, transcripts.call_id)` CASCADE / `(call_action_items.org_id, call_action_items.call_id)` CASCADE / `(call_action_items.org_id, assignee_user_id)` SET NULL(assignee_user_id) | org 삭제 시 통화 cascade는 의도. 고객·사용자/membership 삭제는 통화 보존이 운영 의도. Composite FK로 cross-org 참조를 DB 레벨에서 차단 |
| 3-6 | 부분 인덱스 vs 전체 인덱스 | **부분 인덱스 `WHERE deleted_at IS NULL`** (calls에만 적용. transcripts / call_action_items는 부모 CASCADE라 deleted_at 컬럼 자체 없음) | Phase 2 customers 5개 부분 인덱스 패턴. 인덱스 크기·write 비용 절감 |
| 3-7 | CHECK 제약 표현 | text + CHECK enum. Postgres ENUM type 미사용 | Phase 1·2·3 일관. ENUM은 ALTER 비용 큼. CHECK은 string compare로 충분 |
| 3-8 | UNIQUE 제약 | `transcripts (call_id, seq)` 만 | calls / call_action_items에는 자연스러운 unique key 없음 (UUID PK로 충분) |
| 3-9 | seed 트랜잭션 | seeds/0004_phase4_demo.sql 전체를 단일 트랜잭션 | Phase 2·3 seed 패턴. 부분 실패 시 전체 롤백 |

---

## 3. `calls` 테이블 정밀화

### 3.1 컬럼 정의

```sql
CREATE TABLE calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id         uuid,
  agent_user_id       uuid,
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound','meeting')),
  status              text NOT NULL CHECK (status IN ('in_progress','ended','missed','dropped')),
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  duration_seconds    int CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  title               text,
  summary             text,
  needs               text,
  issues              text,
  sentiment           text CHECK (sentiment IS NULL OR sentiment IN ('positive','neutral','cautious','negative')),
  notes               text,
  deleted_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, id),
  FOREIGN KEY (org_id, customer_id)
    REFERENCES customers(org_id, id) ON DELETE SET NULL (customer_id),
  FOREIGN KEY (org_id, agent_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (agent_user_id)
);
```

### 3.2 RLS 정책 (4개)

```sql
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE calls FORCE ROW LEVEL SECURITY;

CREATE POLICY calls_select ON calls
  FOR SELECT
  USING (org_id = current_app_org_id());

CREATE POLICY calls_insert ON calls
  FOR INSERT
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY calls_update ON calls
  FOR UPDATE
  USING (org_id = current_app_org_id())
  WITH CHECK (org_id = current_app_org_id());

CREATE POLICY calls_delete ON calls
  FOR DELETE
  USING (org_id = current_app_org_id());
```

### 3.3 인덱스 (4개 부분 인덱스)

```sql
CREATE INDEX calls_org_started_idx
  ON calls (org_id, started_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX calls_org_customer_started_idx
  ON calls (org_id, customer_id, started_at DESC)
  WHERE deleted_at IS NULL AND customer_id IS NOT NULL;

CREATE INDEX calls_org_agent_started_idx
  ON calls (org_id, agent_user_id, started_at DESC)
  WHERE deleted_at IS NULL AND agent_user_id IS NOT NULL;

CREATE INDEX calls_org_status_idx
  ON calls (org_id, status)
  WHERE deleted_at IS NULL;
```

### 3.4 인덱스 근거

| 인덱스 | 커버하는 query |
|---|---|
| `calls_org_started_idx` | `GET /calls` 기본 목록 (org 기준 시간 정렬) + dashboard "최근 통화 5건" |
| `calls_org_customer_started_idx` | customers.html에서 행 클릭 시 "이 고객 통화 history" (Phase 5+ UI). 본 phase에서도 service.endCall이 `customers.last_contacted_at` 갱신 후 다시 SELECT할 때 사용 |
| `calls_org_agent_started_idx` | 본인 통화 목록 / dashboard 본인 KPI / manager 보고서 (Phase 5+) |
| `calls_org_status_idx` | dashboard `오늘 통화` (started_at 필터와 결합) / "진행 중 통화 LIVE 표시" / "응답률 KPI" 분모·분자 |

---

## 4. `transcripts` 테이블 정밀화

### 4.1 컬럼 정의

```sql
CREATE TABLE transcripts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id       uuid NOT NULL,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  seq           int NOT NULL CHECK (seq >= 0),
  speaker       text NOT NULL CHECK (speaker IN ('agent','customer','system')),
  text          text NOT NULL CHECK (length(text) > 0),
  start_ms      int CHECK (start_ms IS NULL OR start_ms >= 0),
  end_ms        int CHECK (end_ms IS NULL OR (start_ms IS NOT NULL AND end_ms >= start_ms)),
  confidence    numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, seq),
  FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE
);
```

### 4.2 RLS 정책 (4개)

`calls`와 동일한 4 정책 패턴. `org_id`는 비정규화된 컬럼.

```sql
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcripts FORCE ROW LEVEL SECURITY;

CREATE POLICY transcripts_select ON transcripts
  FOR SELECT USING (org_id = current_app_org_id());

CREATE POLICY transcripts_insert ON transcripts
  FOR INSERT WITH CHECK (org_id = current_app_org_id());

CREATE POLICY transcripts_update ON transcripts
  FOR UPDATE USING (org_id = current_app_org_id())
              WITH CHECK (org_id = current_app_org_id());

CREATE POLICY transcripts_delete ON transcripts
  FOR DELETE USING (org_id = current_app_org_id());
```

### 4.3 인덱스 (UNIQUE + 1)

```sql
-- UNIQUE (call_id, seq)가 자동으로 (call_id, seq) 인덱스 생성 — append/read 양쪽 cover
CREATE INDEX transcripts_org_created_idx
  ON transcripts (org_id, created_at DESC);
```

`transcripts_org_created_idx`는 RLS scan helper + 운영 도구 (특정 org의 transcripts 최근 N건 조회). 일상 read는 UNIQUE (call_id, seq) 인덱스로 처리.

### 4.4 비정규화 일관성

`transcripts.org_id = calls.org_id` 일관성은 service 레이어가 먼저 맞추고, `(org_id, call_id) REFERENCES calls(org_id, id)` composite FK가 DB 레벨에서 한 번 더 강제한다. Step 2 plan에서 service INSERT 패턴 정밀화.

---

## 5. `call_action_items` 테이블 정밀화

### 5.1 컬럼 정의

```sql
CREATE TABLE call_action_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           uuid NOT NULL,
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title             text NOT NULL CHECK (length(title) > 0),
  due_date          date,
  assignee_user_id  uuid,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','dropped')),
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'done' AND completed_at IS NOT NULL) OR
    (status <> 'done' AND completed_at IS NULL)
  ),
  FOREIGN KEY (org_id, call_id) REFERENCES calls(org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (org_id, assignee_user_id)
    REFERENCES memberships(org_id, user_id) ON DELETE SET NULL (assignee_user_id)
);
```

`CHECK (status='done' ↔ completed_at NOT NULL)`은 상태와 시각의 일관성을 DB가 강제. service가 잘못된 조합 INSERT 시 23514 (check_violation).

### 5.2 RLS 정책

`calls` / `transcripts`와 동일한 4 정책 패턴 (`org_id = current_app_org_id()`).

### 5.3 인덱스 (2개)

```sql
CREATE INDEX call_action_items_call_idx
  ON call_action_items (call_id);

CREATE INDEX call_action_items_assignee_open_idx
  ON call_action_items (org_id, assignee_user_id, due_date)
  WHERE status = 'open';
```

| 인덱스 | 커버하는 query |
|---|---|
| `call_action_items_call_idx` | `GET /calls/:id` 응답에 결합되는 action items (1:N JOIN) |
| `call_action_items_assignee_open_idx` | 향후 personal todo 화면 (Phase 5+) "나에게 할당된 미완료 액션" + due_date 정렬 |

---

## 6. `customers.last_contacted_at` 연계

Phase 2에서 이미 존재하는 컬럼. 본 Step 1은 schema 자체 변경 없음 — service.endCall 트랜잭션이 같은 BEGIN 안에서 다음을 실행하도록 Step 2 plan에서 명시:

```sql
-- service.endCall pseudo
UPDATE customers
   SET last_contacted_at = GREATEST(COALESCE(last_contacted_at, 'epoch'::timestamptz), $1)
 WHERE id = $2
   AND org_id = current_app_org_id();
```

`GREATEST` + `COALESCE`로 단조 증가 보장. 옛 통화가 늦게 종료 처리되거나 (data fix), 다른 통화가 같은 고객에 대해 더 최근에 끝난 경우라도 last_contacted_at은 뒤로 가지 않음.

---

## 7. `app` role grant migration

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON calls              TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON transcripts        TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON call_action_items  TO app;
```

`kloser_service`에는 grant 추가하지 않음 (anonymous 흐름 없음 — 결정 §2-4).

---

## 8. 시드 정책

`server/seeds/0004_phase4_demo.sql`은 이번 schema-only Step 1에서는 만들지 않는다. 아래는 후속 step에서 seed가 필요할 때의 초안이다.

- Acme + Beta 각 조직에 통화 10~15건씩 (총 20~30건)
- 시드 customers 12명 분포 (모두 등록된 고객) + customer_id NULL 통화 1~2건 (unknown caller 시나리오)
- `direction`은 `inbound:outbound:meeting = 5:3:2` 비율
- `status`는 `ended:in_progress:missed:dropped = 7:1:1:1` 비율 (대부분 완료)
- `started_at`은 최근 7일에 골고루 분포 — dashboard "오늘 통화 N건" KPI가 의미 있는 값으로 보이도록
- `transcripts`: 통화당 5~10개 utterance, agent / customer 번갈아
- `call_action_items`: 통화당 2~3개, open / done 섞임

후속 seed를 만들 때는 `customers.last_contacted_at`도 시드 통화의 ended_at으로 일괄 UPDATE한다. Phase 2 시드 시점엔 NULL이었던 컬럼이 Phase 4 seed 후엔 의미 있는 시각으로 채워져야 한다.

---

## 9. 완료 기준

다음을 모두 만족해야 Step 1 종료 → Step 2 (repository) 진입.

- [x] 4 migration 작성 + `npm --prefix server run db:migrate:up` PASS
- [x] fresh DB에서 `npm --prefix server run db:migrate:up` PASS
- [x] `db:migrate:down` 4회 후 재 `db:migrate:up` PASS
- [x] admin URL로 3 테이블 RLS FORCE 확인 (`pg_class.relforcerowsecurity = true`)
- [x] admin URL로 RLS 정책 4종씩 존재 확인 (`pg_policies` 12행 = 3 테이블 × 4 정책)
- [x] app role + GUC로 cross-org INSERT / composite FK drift 차단 확인 (`42501`, `23503`, `23514`)
- [x] app role grants 12개 확인 (`SELECT/INSERT/UPDATE/DELETE` × 3 tables)
- [x] `call_action_items` CHECK (status / completed_at) 위반 INSERT 시도 → `23514` 거부
- [x] `PHASE_4_STEP_1_FINDINGS.md` 작성 (구현 중 발견 사항·trade-off·diff 인계)
- [x] `PHASE_4_MASTER.md` Implementation Log의 Step 1 체크박스 `[x]` flip + 통과일 기재

Demo seed와 `customers.last_contacted_at` fixture 검증은 이번 schema-only 작업에서 제외했다. Step 2/3 service와 Step 4 UI가 요구하는 fixture shape가 확정된 뒤 별도 seed step에서 처리한다.

---

## 10. 위험 / 미해결 항목 (Step 1 → Step 2 인계 시 점검)

| # | 항목 | 미해결 상태 | Step 2/3에서 결정 |
|---|---|---|---|
| 10-1 | `transcripts.seq` 발급 패턴 | DB 레벨 sequence vs service `MAX(seq)+1` vs advisory lock | Step 2 repo plan에서 결정. WS persistence가 단일 클라이언트라 race 가능성 낮지만 best-effort serialization 필요 |
| 10-2 | dashboard `오늘` 기준 timezone | 본 phase는 UTC. org 단위 timezone은 Phase 6+ | dashboard service에서 `today_start_utc()` helper 정의. UTC 가정 명시적 코멘트 |
| 10-3 | `calls.duration_seconds` 데이터 정합 | service가 매번 계산. data fix 시 (ended_at 변경 등) 별도 갱신 필요 | Step 2 service에 `recomputeDuration(call)` helper. Phase 4 시점은 endCall에만 사용 |
| 10-4 | manager team-scope 권한 | RLS 정책이 향후 manager + team_id 조합으로 확장될 때 본 4 정책 그대로 두고 새 정책 추가 vs 통합 변경 | Phase 5+ |
| 10-5 | retention enforce | 본 phase 0건. Phase 6+에서 archive table + cron 또는 partition pruning | 별 step |
| 10-6 | live.html `dropped` 감지 | 클라이언트 unload / WS disconnect 시 server-side에서 calls.status를 dropped로 자동 UPDATE | Step 3 WS persistence plan에서 결정 (heartbeat / timeout) |

---

## 11. 한 줄 요약

> **Step 1은 `calls` / `transcripts` / `call_action_items` 3개 테이블 + RLS FORCE 12 정책 + 부분 인덱스 + app role grant 4종으로, Phase 4 영속화의 SQL 표면을 깨끗이 깐다. customers.plan은 재도입 0건, soft delete는 calls에만 한정, retention enforce는 Phase 6+. Demo seed는 사용자 지시에 따라 이번 schema-only 작업에서 제외하고 후속 step에서 결정한다.**
