# Kloser Phase 6 사용자 가이드

> Phase 6은 Phase 1~5가 깔아 둔 인증·고객·통화 영속화·체크리스트 기반 위에 **운영 루프 4개**를 닫은 단계입니다. 통화 후 AI 요약이 자동으로 생성되고, 끊긴 통화가 60초 뒤 자동으로 정리되며, 매니저가 자기 팀 통화만 따로 볼 수 있고, 다음 액션을 삭제할 수 있습니다.

---

## 1. Phase 6의 목적

Phase 5까지의 통화 화면은 사용자가 직접 메모를 누르지 않으면 AI 요약이 안 생기고, 비정상 종료된 통화는 `in_progress`로 영구 잔존하며, 매니저는 본인 팀 통화를 분리해 볼 도구가 없었습니다. Phase 6은 그 네 곳의 미완성 자리를 다음 약속으로 닫습니다.

1. **통화가 끝나면 AI 요약이 자동으로 채워진다** — BullMQ 큐가 `endCall`을 받아 LLM 워커를 깨우고, 결과를 `calls.summary` / `needs` / `issues` / `sentiment`에 박습니다. 사용자가 직접 메모를 적은 통화(`summary_source='manual'`)는 절대 덮어쓰지 않습니다.
2. **끊긴 통화가 60초 안에 자동으로 정리된다** — 워커가 주기적으로 `last_seen_at`이 1분 이상 안 들어온 in_progress 통화를 `dropped/server_timeout`으로 마감하고 `duration_seconds`를 채웁니다.
3. **실 외부 provider(Anthropic / OpenAI / Clova)가 mock 자리에 끼워진다** — provider env가 비어 있거나 `mock`이면 mock을 쓰고, `anthropic` / `openai` / `clova`를 명시하면 필요한 키를 검증한 뒤 실 adapter를 씁니다. 실 provider를 선택했는데 키가 없으면 boot 시 fail-fast합니다. 모든 호출은 `llm_usage_log` 표에 적재돼 운영자가 사용량을 추적할 수 있습니다.
4. **다음 액션(Action Item)을 삭제할 수 있다** — 통화 기록 페이지 상세 패널의 각 액션 행에 ✕ 버튼이 생겼고, hard delete 방식으로 즉시 사라집니다. 권한 매트릭스는 메모/노트와 동일(`assertCanMutateCall`).
5. **매니저가 자기 팀 통화만 분리해 보는 보고서 화면이 생겼다** — `platform/reports.html`이 자기 팀의 통화 KPI(총 통화 수·완료·미수신·끊김·응답률·평균 통화 시간·최근 통화 10건)를 보여 줍니다. admin은 `?team_id=...`로 임의 팀 또는 전체 조직 단위로 조회 가능.

Phase 6이 끝나면, 평가자는 **녹음 없이도 통화 후 자동 요약을 확인하고, 매니저로 로그인해 자기 팀 통화만 분리된 보고서를 보고, action item을 작성·완료·삭제까지 한 번에** 끝낼 수 있습니다.

---

## 2. Phase 6에서 가능해진 것

평가/검토 시점에 다음을 직접 확인할 수 있습니다.

- **AI 자동 요약** — `live.html`에서 통화 종료 직후, 통화 기록 페이지의 상세 패널에 들어가면 `요약 / 고객 니즈 / 미해결 이슈 / 감정`이 자동으로 채워져 있습니다. 메모를 한 줄 적어 둔 통화는 그 메모가 그대로 유지됩니다 (manual 보호).
- **자동 dropped 마킹** — `live.html`에서 의도적으로 탭을 강제 종료하거나 네트워크를 끊고 1분이 지나면, 통화 기록에 그 통화가 `끊김 (server_timeout)`으로 마감된 상태로 보입니다.
- **WS suggestion 영속화** — `live.html`에서 발화가 흐르는 동안 추천 카드가 화면에 뜨면, 그 카드는 동시에 `call_suggestions` 표에 1행씩 적재됩니다. 통화 종료 후 통화 기록 패널에서도 같은 추천 카드를 다시 볼 수 있습니다 (Phase 5 영속화 + Phase 6 자동 호출).
- **Action item 삭제** — `calls.html` 상세 패널의 다음 액션 행 오른쪽 끝 ✕ 버튼. 클릭 즉시 DB에서 삭제됩니다.
- **매니저 보고서 페이지** — 사이드바 "조직" 영역에 "보고서" 항목이 새로 생겼습니다. 매니저로 로그인하면 본인 팀 KPI / 최근 통화 10건만 보입니다. admin은 같은 페이지에서 전체 조직 또는 다른 팀을 선택 가능.
- **운영자용 사용량 로그** — 운영 admin이 직접 `psql`로 `llm_usage_log`를 조회하면 호출별 provider / model / tokens_in / tokens_out / latency_ms / cost_usd_micros / created_at이 한 행씩 보입니다 (RLS FORCE — 본인 조직만).

---

## 3. AI 자동 요약 — endCall → 워커 → calls 업데이트

### 3.1 흐름

1. 사용자가 `live.html`에서 통화를 진행 (Phase 4·5 흐름 그대로).
2. 종료 버튼 → WS `end_call` → 서버 `service.endCall` 트랜잭션 (Phase 4의 `customers.last_contacted_at` 갱신까지 동일).
3. `endCall`이 트랜잭션 commit **이후** best-effort로 BullMQ `callSummary` 큐에 `{ orgId, callId }` 작업을 1건 enqueue.
4. 별도 워커 프로세스(`npm --prefix server run dev:worker`)가 작업을 꺼내 `app.withOrgContext(orgId, ...)` 안에서 transcript를 모아 LLM(mock 또는 실 provider) 호출.
5. 결과를 `calls` 행에 UPDATE — 단, `summary_source` 컬럼이 SQL `WHERE summary_source IS DISTINCT FROM 'manual'` guard로 manual 메모를 보호.
6. 호출 직후 `llm_usage_log`에 1행 INSERT (provider/model/tokens/latency/operation='call_summary').

### 3.2 manual 보호

Phase 5에서 사용자가 `calls.html` 또는 `live.html`에서 직접 메모를 저장한 통화는 `calls.summary_source='manual'`로 마킹돼 있습니다. AI 워커가 같은 행을 UPDATE하려 해도 SQL guard가 행을 거르므로, 사용자 메모가 그대로 보존됩니다. 그래도 워커는 LLM을 호출하므로 `llm_usage_log`에는 1행이 남습니다 (운영자가 cost 추적할 때 manual/auto를 분리하지 않고 호출 단위로 봅니다).

### 3.3 워커가 안 떠 있어도 통화는 끝납니다

워커가 안 떠 있거나(개발 머신에서 의도적으로 OFF), Redis가 잠시 끊어진 상태에서도 `endCall` 트랜잭션은 그대로 성공합니다. AI 요약만 누락되고 `summary_source`가 NULL인 상태로 남습니다. 다음에 워커가 부팅돼서 큐가 다시 살아나면 그 자리에서 이어 처리합니다 (BullMQ 영속 큐).

---

## 4. Heartbeat sweep — 끊긴 통화 자동 dropped 처리

### 4.1 흐름

1. `live.html`이 통화 중 주기적으로 WS heartbeat을 보내며 `calls.last_seen_at`을 갱신 (Phase 5 도입).
2. 워커가 60초 cutoff로 sweep — `SELECT id FROM calls WHERE status='in_progress' AND last_seen_at < now() - interval '60 seconds'`.
3. 발견된 통화를 `status='dropped'`, `dropped_reason='server_timeout'`, `ended_at=now()`, `duration_seconds=ended_at - started_at`로 마감.
4. 다음 통화 기록 페이지 진입 시 그 통화는 "끊김" 상태로 보임.

### 4.2 race 안전

sweep과 사용자의 정상 `endCall`이 같은 통화에서 동시에 발생하더라도, sweep SQL은 `WHERE status='in_progress'`를 조건으로 걸어 두기 때문에 사용자가 먼저 `ended`로 마감한 통화는 절대 dropped로 덮어쓰지 않습니다. 반대 순서도 마찬가지로 SQL CHECK가 `dropped → ended` 변경을 거부합니다.

### 4.3 cross-org 격리

sweep은 워커가 `app` role + 각 organization id를 순회하며 `withOrgContext`로 처리하므로, 본인 조직 행만 마감합니다. 멀티테넌시 격리는 RLS FORCE로 강제됩니다.

---

## 5. 실 외부 provider 어댑터 — Anthropic / OpenAI / Clova

### 5.1 mock vs 실 provider 전환

- **mock 강제** (기본 / e2e / 데모) — `LLM_PROVIDER` / `EMBEDDING_PROVIDER` / `STT_PROVIDER`가 비어 있거나 `mock`일 때. 모든 호출은 in-process 더미 응답 반환, 외부 네트워크 0건.
- **실 provider 활성** — provider env를 각각 `anthropic` / `openai` / `clova`로 명시하고 다음 필수 키가 있을 때:
  - `ANTHROPIC_API_KEY` — Claude (LLM)
  - `OPENAI_API_KEY` — text-embedding-3-small (Embedding)
  - `CLOVA_STT_URL` + `CLOVA_CLIENT_ID` + `CLOVA_CLIENT_SECRET` — Naver Clova (STT)

실 provider가 선택됐는데 필수 키가 비어 있으면 silent mock fallback 없이 fail-fast합니다. `.env`에 키가 있어도 env에서 `LLM_PROVIDER=mock`처럼 명시하면 mock 우선. e2e 스크립트와 e2e용 dev 서버는 mock provider로 실행해야 합니다.

### 5.2 사용량 로그

모든 LLM/STT/Embedding 호출은 호출 단위로 `llm_usage_log`에 1행 적재:

| 컬럼 | 의미 |
|---|---|
| `org_id` | 본인 조직 (RLS FORCE) |
| `call_id` | 통화에 묶인 호출이면 통화 id (워커 sweep은 NULL일 수 있음) |
| `provider` | `anthropic` / `openai` / `clova` / `mock` |
| `model` | 실 provider 응답에 포함된 모델 이름 |
| `operation` | `call_summary` / `call_suggestion` / `embedding` / `stt` |
| `tokens_in` / `tokens_out` | provider 응답 사용량 (mock은 0) |
| `latency_ms` | 호출 왕복 시간 |
| `cost_usd_micros` | model→price map 기반 비용 (현재 NULL — Phase 7+로 분리) |
| `metadata` | 자유 JSON (현재 `source` 필드 등) |
| `created_at` | timestamptz |

표는 append-only (UPDATE/DELETE 정책 없음). 운영 admin은 `MIGRATE_DATABASE_URL` admin connection으로만 cleanup 가능.

### 5.3 cost cap

본 Phase는 cost 기록만 합니다. 일일 cap / 폭주 차단 / model price map은 Phase 7+로 분리 (`PHASE_7_HANDOFF.md` §6).

---

## 6. Action item 삭제

### 6.1 UI

`calls.html` 상세 패널 → "다음 액션" 섹션 → 각 행의 ✕ 버튼. 클릭 즉시 `DELETE /call-action-items/:id` 호출 후, 성공하면 그 행만 DOM에서 제거 (전체 reload 없음).

### 6.2 권한

`assertCanMutateCall` 그대로:

- admin / manager-team — 모두 가능
- employee — 본인 통화의 액션만 가능
- viewer — 모두 403
- cross-org — 404 (존재 노출 없음)

이미 삭제된 액션을 다시 호출하면 `404 not_found`. 빠른 더블 클릭 등의 race에도 안전합니다.

### 6.3 soft vs hard

본 Phase는 **hard delete**로 결정. 운영상 "잘못 삭제 시 복구"가 필요하면 Phase 7+에서 audit log 도입 시 함께 다룹니다 (`PHASE_7_HANDOFF.md` §3).

---

## 7. 매니저 팀 보고서 (`platform/reports.html`)

### 7.1 권한 매트릭스

| 역할 | `GET /reports/team-summary` 응답 |
|---|---|
| admin | `?team_id=<uuid>` 또는 미지정. 미지정이면 조직 전체. 본 조직 어느 팀이든 200. 다른 조직의 team_id는 404 |
| manager | `?team_id` 미지정 또는 본인 팀 id만 200. 다른 same-org 팀 id → 403 (존재만 노출). 다른 조직 팀 id → 404 |
| employee | 미정의(현재 403 — sidebar에서도 항목 숨김은 Phase 7+ 메뉴 정리 작업) |
| viewer | 동일 403 |

매니저가 본인 팀을 가진 멤버십이 없으면 (`memberships.team_id IS NULL`), `?team_id` 미지정 호출은 404로 응답합니다.

### 7.2 응답 필드

```json
{
  "scope": "team",
  "team_id": "...",
  "team_name": "Acme Sales",
  "generated_at": "2026-05-14T...",
  "total_calls": 42,
  "ended_calls": 30,
  "missed_calls": 4,
  "dropped_calls": 3,
  "active_calls": 5,
  "response_rate": 0.882,
  "avg_duration_seconds": 245,
  "recent_calls": [ { "id", "customer_name", "agent_name", "team_name", "status", "duration", "started_at", "title" }, ... ]
}
```

`scope`는 admin이 미지정으로 호출하면 `"org"`, 그 외에는 `"team"`. `response_rate`는 `ended / (ended + missed)`, 분모가 0이면 NULL. `avg_duration_seconds`는 `ended` 통화의 평균(없으면 NULL).

### 7.3 UI

- 상단: 좌측 scope 뱃지 (`팀` 또는 `조직`) + 팀/조직 이름 + 생성 시각.
- KPI 카드 6장: 총 통화 / 완료 / 미수신 / 끊김 / 진행 중 / 응답률.
- 평균 통화 시간 1장.
- 최근 통화 10건 표 — 고객 / 상담원 / 팀 / 상태 / 통화 시간 / 시작 시각.

모든 server-supplied 필드는 escapeHtml 또는 textContent 처리. innerHTML 보간은 최근 통화 표에 한정.

### 7.4 사이드바

매니저로 로그인하면 "조직" 영역에 "보고서" 항목이 보입니다. employee/viewer에게도 항목은 보이지만 클릭 시 403 — 메뉴 가시성 정리는 Phase 7+ (`PHASE_7_HANDOFF.md` §7).

---

## 8. 운영자 / 평가자 체크리스트

### 8.1 자동 요약 흐름 확인 (5분)

1. Acme admin (`admin@acme.test` / `acme-admin-1234`)으로 로그인.
2. `live.html` 진입 → 약 40초 데모 fixture 흐름 진행.
3. 종료 버튼 → "종료됨" 라벨 확인.
4. (워커가 떠 있는 경우) `calls.html`로 이동 → 방금 만든 통화 클릭 → 우측 패널의 요약/니즈/이슈 텍스트가 채워진 상태인지 확인.

### 8.2 매니저 보고서 흐름 확인 (3분)

1. 워커가 떠 있을 필요 없음.
2. admin으로 임의 employee의 `memberships.role`을 manager로 잠시 변경하거나, e2e가 만든 `phase6-e2e-*` 매니저 시드(이미 정리됨) 또는 자체 시드 매니저 사용. 본 가이드는 admin이 다른 팀을 보는 흐름만 확인.
3. 사이드바 "조직" → "보고서" 클릭 → KPI 카드와 최근 통화 표가 채워지는지 확인.
4. URL에 `?team_id=<유효한 같은 조직 team id>` 추가 → 해당 팀만 보이는지 확인.

### 8.3 Action item 삭제 (1분)

1. 어떤 통화든 열고 다음 액션이 1건 이상 있어야 함 (없으면 `POST /calls/:id/action-items`로 임의 1건 추가).
2. 우측 패널의 다음 액션 행 오른쪽 ✕ 클릭.
3. 행이 사라지면 OK.

### 8.4 사용량 로그 확인 (admin 전용, 1분)

```bash
docker exec kloser-dev-postgres-1 psql -U kloser -d kloser_dev -c \
  "SELECT operation, provider, model, tokens_in, tokens_out, latency_ms, created_at \
   FROM llm_usage_log ORDER BY created_at DESC LIMIT 10;"
```

`provider='mock'`이면 mock 흐름이 정상 작동 중. `provider='anthropic'`이면 `.env` 키가 활성 상태이고 실 호출이 발생한 것입니다.

---

## 9. 알아야 할 제한사항

Phase 6은 운영 루프 4개를 닫은 단계입니다. 다음은 Phase 7+로 미뤄져 있습니다 (`docs/plan/phase-6/PHASE_7_HANDOFF.md` 정본).

- **`llm_usage_log.cost_usd_micros`는 현재 NULL** — model→price map 별도 commit으로 분리.
- **role-based sidebar 가시성** — employee/viewer에게도 "보고서" 메뉴가 보임 (클릭 시 403).
- **보고서 날짜 윈도우 / 상담원 drilldown** — 현재는 전체 기간 + 팀 단위. 일/주/월 + 상담원 단위는 Phase 7+.
- **SMTP / Resend 실 adapter** — Phase 3 dev outbox 그대로.
- **MFA / WebAuthn / 세션 강화**.
- **activity_log + 감사 로그**.
- **retention enforce cron** (Transcript 3년 / call_recordings 90일).
- **결제·구독 흐름** (Stripe / Toss + `organizations.plan` cap).
- **call_recordings 오디오 파일 + S3/MinIO**.
- **dashboard / daily / newsletter 위젯의 demo → real 정리**.
- **`organizations.timezone` + i18n**.

---

## 10. 다음 Phase에서 추가될 것

| 다음 단계 | 추가될 기능 (요약) |
|---|---|
| **Phase 7** | SMTP / Resend, MFA, activity_log, retention enforce, cost model price map, role-based 메뉴 가시성, 보고서 필터 정밀화 |
| **Phase 8+** | 결제·구독, bulk knowledge import, call_recordings, enterprise SSO (Keycloak), 다국어, organizations.timezone |

Phase 6이 만든 약속(워커·실 provider·usage log·action item delete·매니저 보고서)은 다음 Phase의 운영 도메인 도입에도 동일 패턴으로 적용됩니다.

---

## 11. 참조 문서

- 마스터 계획: `docs/plan/phase-6/PHASE_6_MASTER.md`
- Step findings: `PHASE_6_STEP_{1,2,3,4,5}_FINDINGS.md` (Step 2는 `_SCHEMA` / `_WIRING` / `_PROVIDER` 3분할)
- Phase 7+ 인계: `docs/plan/phase-6/PHASE_7_HANDOFF.md`
- 통합 e2e 산출물: `test/phase_6_e2e.mjs`; `test/phase_6_e2e.png`는 실행 때 생성되는 ignored screenshot artifact.
