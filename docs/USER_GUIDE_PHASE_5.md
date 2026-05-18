# Kloser Phase 5 사용자 가이드

> Phase 5는 Phase 4가 만든 통화 영속화 기반 위에 **회사 지식, 통화 체크리스트, AI 추천 이력, 수동 요약, 고객 연결, heartbeat**를 붙인 단계입니다. 실 외부 STT/LLM provider와 자동 워커는 아직 운영 단계까지 닫히지 않았고, Phase 5에서는 mock adapter와 실제 API/DB wiring으로 제품 흐름을 검증 가능한 상태까지 올렸습니다.

---

## 1. Phase 5의 목적

Phase 4가 끝난 시점에는 통화 시작, 발화 저장, 종료, 통화 기록, 대시보드 KPI가 모두 실제 DB/API로 동작했습니다. 하지만 통화 중 영업 운영에 필요한 다음 영역은 아직 비어 있었습니다.

1. 회사별 응대 가이드와 FAQ를 저장하고 검색할 장소.
2. 통화마다 따라야 할 체크리스트.
3. 통화 중 AI 추천을 통화 종료 후 다시 볼 수 있는 이력.
4. 통화 상세에서 사람이 직접 요약을 작성하는 경로.
5. 통화를 고객 레코드와 연결하는 흐름.
6. 브라우저가 끊겼을 때 나중에 통화를 정리할 수 있는 heartbeat 기반.

Phase 5는 이 영역들을 schema부터 frontend까지 연결했습니다. 평가자는 `settings.html`에서 회사 지식과 체크리스트를 관리하고, `live.html`에서 고객을 연결하고 체크리스트를 처리하며, `calls.html`에서 통화 요약과 다음 액션을 직접 작성하고 상태를 바꿀 수 있습니다.

---

## 2. Phase 5에서 가능해진 것

평가/검토 시점에 다음을 직접 확인할 수 있습니다.

- **설정 화면의 가이드 & 체크리스트 관리** — admin은 회사 지식 베이스를 만들고 청크를 넣을 수 있으며, 회사별 통화 체크리스트 템플릿을 생성/수정/비활성화할 수 있습니다. admin 외 역할은 읽기 전용입니다.
- **라이브 통화 고객 연결** — `live.html`에서 고객 picker로 실제 customers API 데이터를 불러오고, 현재 통화에 고객을 연결하거나 해제할 수 있습니다.
- **통화별 체크리스트** — 회사 체크리스트 템플릿이 통화별 항목으로 초기화되고, 통화 중 완료/미완료 상태를 저장할 수 있습니다.
- **WebSocket heartbeat 저장** — 라이브 통화 중 주기적으로 heartbeat가 서버에 저장되어 `calls.last_seen_at`이 갱신됩니다. 자동 dropped sweep은 Phase 6에서 닫혔습니다.
- **통화 상세 수동 요약** — `calls.html` 상세 패널에서 요약, 고객 니즈, 미해결 이슈, 감정을 직접 저장할 수 있고 `summary_source='manual'`로 보호됩니다.
- **다음 액션 작성/완료** — 통화 상세에서 action item을 만들고 `open`/`done` 상태를 바꿀 수 있습니다. 삭제는 Phase 6에서 추가되었습니다.
- **AI 추천 이력 조회** — DB에 저장된 `call_suggestions` 행이 있으면 `calls.html` 상세 패널에서 추천 이력으로 다시 볼 수 있습니다.
- **manager team-scope mutation 권한 기반** — manager는 같은 팀 상담원의 통화 변경을 허용받고, 다른 팀 통화 변경은 거절됩니다. 별도 팀 보고서 화면은 Phase 6에서 추가되었습니다.

---

## 3. 설정 화면 — 회사 지식과 체크리스트

### 3.1 회사 지식 베이스

`settings.html`의 "가이드 & 체크리스트" 영역은 실제 API로 동작합니다.

관리자가 할 수 있는 일:

1. 지식 베이스 생성.
2. 텍스트 청크 등록/교체.
3. 기존 지식 베이스 목록 조회.
4. 지식 베이스 삭제.

서버 표면:

| 기능 | API |
|---|---|
| 지식 베이스 목록 | `GET /knowledge-bases` |
| 지식 베이스 생성 | `POST /knowledge-bases` |
| 청크 교체 | `POST /knowledge-bases/:id/chunks/replace` |
| 지식 베이스 삭제 | `DELETE /knowledge-bases/:id` |
| 검색 | `GET /knowledge-bases/search` |

`knowledge_bases`와 `knowledge_chunks`는 모두 조직별 RLS FORCE가 적용됩니다. 다른 조직의 지식 베이스 ID를 직접 호출해도 본인 조직에서는 보이지 않습니다.

### 3.2 임베딩과 검색

Phase 5는 `pgvector` 기반 검색 구조를 도입했습니다. `knowledge_chunks.embedding vector(1536)`에 청크 임베딩을 저장하고, 검색 API는 유사도 순서로 결과를 반환합니다.

기본 개발/e2e 경로에서는 mock embedding adapter를 사용합니다. 실 OpenAI embedding provider는 Phase 6에서 provider adapter와 사용량 로그까지 함께 닫혔습니다.

### 3.3 체크리스트 템플릿

관리자는 회사 단위 체크리스트 템플릿을 관리할 수 있습니다.

| 기능 | API |
|---|---|
| 템플릿 목록 | `GET /call-checklist-templates` |
| 템플릿 생성 | `POST /call-checklist-templates` |
| 템플릿 수정 | `PATCH /call-checklist-templates/:id` |
| 템플릿 삭제 | `DELETE /call-checklist-templates/:id` |

템플릿은 회사 전체 기준입니다. 실제 통화에 들어가면 템플릿이 `call_checklist_items`로 복사되어 통화별 상태를 따로 갖습니다.

---

## 4. 라이브 통화 화면 (`live.html`)

### 4.1 고객 선택과 연결

Phase 5부터 라이브 통화 화면은 실제 customer API와 연결됩니다.

흐름:

1. `live.html`이 `/me`와 access token 상태를 확인합니다.
2. 통화가 시작되면 WebSocket `start_call` ack로 `callId`를 받습니다.
3. 고객 picker를 열면 `GET /customers`로 본인 조직 고객 목록을 가져옵니다.
4. 고객을 선택하면 `POST /calls/:id/link-customer`가 호출됩니다.
5. 해제하면 `POST /calls/:id/unlink-customer`가 호출됩니다.

통화에 고객이 연결되면 `calls.customer_id`, `customer_linked_at`, `customer_linked_by_user_id`가 저장됩니다. 다른 조직 고객 ID를 넣으면 `400 invalid_reference` 또는 `404 not_found` 계열로 거절됩니다.

### 4.2 통화별 체크리스트

통화가 시작되면 회사 체크리스트 템플릿을 기반으로 통화별 체크리스트 항목이 초기화됩니다.

사용자가 체크리스트를 누르면:

1. 클라이언트가 해당 항목의 status를 `done` 또는 `open`으로 변경 요청.
2. 서버는 통화 변경 권한을 확인합니다.
3. `call_checklist_items.status`, `checked_at`, `checked_by_user_id`가 갱신됩니다.

권한은 통화 mutation 권한과 같은 방향입니다.

| 역할 | 허용 범위 |
|---|---|
| admin | 본인 조직 모든 통화 |
| manager | 같은 팀 상담원의 통화 |
| employee | 본인 통화 |
| viewer | 읽기만 가능 |

### 4.3 Heartbeat

라이브 통화 중 클라이언트는 주기적으로 heartbeat를 보냅니다. 서버는 이를 받아 `calls.last_seen_at`을 갱신합니다.

Phase 5에서 완료된 것:

- heartbeat WebSocket event 수신.
- `last_seen_at` 저장.
- heartbeat service helper와 테스트.

Phase 5에서 아직 완료되지 않은 것:

- 주기적 cron/worker가 오래된 `in_progress` 통화를 자동으로 `dropped` 처리하는 운영 sweep.

이 gap은 Phase 6에서 heartbeat sweep worker로 닫혔습니다.

### 4.4 라이브 추천 카드

Phase 5의 라이브 화면에는 여전히 일부 demo replay가 남아 있습니다.

| 영역 | 상태 |
|---|---|
| 고객 카드 | API |
| 체크리스트 | API |
| heartbeat | WebSocket/API |
| 전사 발화 | demo replay + DB 적층 기반 |
| 라이브 추천 카드 | demo replay |
| 빠른 응대 멘트 | demo |
| 음소거/대기 버튼 | demo |

DB에 저장되는 추천 이력 구조와 조회 UI는 Phase 5에서 준비됐지만, 실시간으로 LLM을 호출해 추천을 생성하고 저장하는 worker/hook은 Phase 6 작업 범위로 넘어갔습니다.

---

## 5. 통화 기록 화면 (`calls.html`)

### 5.1 통화 상세의 수동 요약

Phase 5부터 `calls.html` 상세 패널에서 사람이 직접 통화 요약을 저장할 수 있습니다.

저장되는 필드:

| 필드 | 의미 |
|---|---|
| `summary` | 통화 요약 |
| `needs` | 고객 니즈 |
| `issues` | 미해결 이슈 |
| `sentiment` | 감정/상태 |
| `summary_source` | `manual` |
| `summary_generated_at` | 저장 시각 |

API:

```text
POST /calls/:id/summary/manual
```

수동 요약은 이후 AI 자동 요약이 들어오더라도 덮어쓰지 않는 방향으로 설계되었습니다. 실제 자동 요약 worker는 Phase 6에서 닫혔고, manual 보호 규칙은 그대로 유지됩니다.

### 5.2 다음 액션 작성과 완료

상세 패널의 "다음 액션" 영역에서 새 action item을 만들 수 있습니다.

| 기능 | API |
|---|---|
| 생성 | `POST /calls/:id/action-items` |
| 상태 변경 | `POST /call-action-items/:id/status` |
| 담당자 변경 | `POST /call-action-items/:id/assignee` |

Phase 5 종료 시점에는 삭제 endpoint/UI가 없었습니다. 삭제는 Phase 6에서 `DELETE /call-action-items/:id`와 UI 버튼으로 추가되었습니다.

### 5.3 추천 이력

통화에 연결된 `call_suggestions` row가 있으면 상세 패널에서 추천 이력을 보여 줍니다.

API:

```text
GET /calls/:id/suggestions
POST /call-suggestions/:id/use
POST /call-suggestions/:id/dismiss
```

추천 내용은 서버/LLM에서 올 수 있는 값이므로 프론트엔드는 raw HTML로 신뢰하지 않고 escape/sanitize 경로를 사용합니다.

---

## 6. 데이터 모델

Phase 5에서 추가되거나 확장된 핵심 표면입니다.

| 테이블/컬럼 | 역할 |
|---|---|
| `knowledge_bases` | 회사별 가이드/FAQ 문서 메타 |
| `knowledge_chunks` | 검색 가능한 청크와 1536차원 embedding |
| `org_call_checklist_templates` | 회사별 체크리스트 마스터 |
| `call_checklist_items` | 통화별 체크리스트 진행 상태 |
| `call_suggestions` | 통화 중/후 AI 추천 이력 |
| `calls.summary_generated_at` | 요약 생성/저장 시각 |
| `calls.summary_source` | `manual`/AI 등 요약 출처 |
| `calls.last_seen_at` | heartbeat 마지막 수신 시각 |
| `calls.dropped_reason` | 끊긴 통화 정리 사유 |
| `calls.customer_linked_at` | 고객 연결 시각 |
| `calls.customer_linked_by_user_id` | 고객 연결 사용자 |
| `transcripts.stt_provider` | STT provider 식별자 |
| `transcripts.stt_session_id` | STT 세션 추적 값 |

모든 org-scoped 테이블은 본인 조직 컨텍스트에서만 읽고 쓸 수 있도록 RLS FORCE 정책을 유지합니다.

---

## 7. API와 Demo 경계

Phase 5 종료 시점의 사용자 화면 기준입니다.

### 7.1 `settings.html`

| 영역 | 상태 |
|---|---|
| 가이드 & 체크리스트 | API |
| 프로필/회사 정보/통화 환경/AI/통합/알림/보안/결제 등 기존 설정 섹션 | demo |

### 7.2 `live.html`

| 영역 | 상태 |
|---|---|
| 통화 시작/종료 | WebSocket/API |
| 고객 선택/연결 | API |
| 체크리스트 | API |
| 빠른 메모 | API |
| heartbeat | WebSocket/API |
| 전사 replay | demo 기반, 서버 적층 경로 존재 |
| 라이브 추천 카드 | demo replay |
| 통화 메타/품질/음소거/대기 | demo |

### 7.3 `calls.html`

| 영역 | 상태 |
|---|---|
| 통화 목록/상세/전사 | API |
| 수동 요약 저장 | API |
| 다음 액션 생성/상태 변경 | API |
| 다음 액션 삭제 | Phase 5 미구현, Phase 6 추가 |
| 추천 이력 조회 | API |
| 메일 발송 등 일부 푸터 액션 | demo |

### 7.4 `dashboard.html`

| 영역 | 상태 |
|---|---|
| KPI 4개와 최근 통화 5건 | API, Phase 4 유지 |
| To-Do/시장 트렌드/팀 활동 | demo |

---

## 8. 권한과 격리

Phase 5는 조직 격리와 role 기반 mutation 권한을 계속 유지합니다.

| 동작 | admin | manager | employee | viewer |
|---|---:|---:|---:|---:|
| knowledge base 생성/수정/삭제 | 허용 | 거절 | 거절 | 거절 |
| checklist template 생성/수정/삭제 | 허용 | 거절 | 거절 | 거절 |
| checklist item 상태 변경 | 허용 | 같은 팀 | 본인 통화 | 거절 |
| 통화 고객 연결/해제 | 허용 | 같은 팀 | 본인 통화 | 거절 |
| 수동 요약 저장 | 허용 | 같은 팀 | 본인 통화 | 거절 |
| action item 생성/상태 변경 | 허용 | 같은 팀 | 본인 통화 | 거절 |
| suggestion use/dismiss | 허용 | 같은 팀 | 본인 통화 | 거절 |

cross-org 접근은 기존 원칙과 동일합니다. 다른 조직 리소스는 존재 여부를 드러내지 않도록 `404 not_found` 또는 빈 결과로 처리됩니다.

---

## 9. 검증된 흐름

Phase 5 closeout e2e는 Playwright 기반 6개 시나리오로 닫혔습니다.

1. admin settings에서 knowledge base와 checklist template 생성.
2. live 통화에서 start_call, 메모, 고객 연결, 체크리스트 토글, heartbeat, endCall 확인.
3. calls 상세에서 manual summary 저장, action item 생성과 완료 확인.
4. DB에 seed된 suggestion 이력 렌더 확인.
5. employee read-only와 Beta admin RLS smoke 확인.
6. cleanup sweep과 residue 0 확인.

closeout 당시 검증:

```powershell
node test/phase_5_e2e.mjs
node test/sync_shared_types.mjs
npm --prefix server run typecheck
npm --prefix server test
node test/phase_4_e2e.mjs
```

Phase 5 종료 시점 기록은 `docs/plan/phase-5/PHASE_5_STEP_5_FINDINGS.md`에 정리되어 있습니다.

---

## 10. Phase 5에서 남긴 Gap

Phase 5는 사용자가 실제로 만질 수 있는 API/UI 흐름을 크게 늘렸지만, 운영 자동화와 실 provider는 다음 단계로 넘겼습니다.

남은 항목:

- AI 자동 요약 worker.
- live suggestion persistence hook.
- heartbeat 기반 60초 dropped sweep.
- Clova/Anthropic/OpenAI 실 provider adapter.
- provider 사용량 로그.
- action item 삭제.
- manager 팀 보고서 화면.
- SMTP/Resend, MFA, activity log, retention cron.

이 중 worker, 실 provider, action item 삭제, manager report는 Phase 6에서 닫혔고, 이메일/MFA/audit/retention은 Phase 7로 이어졌습니다.

---

## 11. 한 줄 요약

Phase 5는 Kloser를 단순 통화 저장 앱에서 **회사별 지식과 체크리스트를 가진 실제 영업 운영 도구**로 확장한 단계입니다. 실 provider와 자동 워커는 아직 후속 단계였지만, 사용자는 설정에서 가이드/체크리스트를 만들고, 라이브 통화에서 고객과 체크리스트를 처리하고, 통화 기록에서 요약과 다음 액션을 관리할 수 있게 됐습니다.
