# Kloser Phase 4 사용자 가이드

> Phase 4는 Phase 1·2·3이 만든 인증·조직·고객·셀프서비스 기반 위에 **통화 자체를 영속 저장하고 다시 볼 수 있게 만드는 운영 데이터 흐름**을 올린 단계입니다. Phase 0.5에서 실시간 WebSocket으로 흐르던 통화 데이터가 메모리에서 사라지지 않고 DB에 남아, 통화 기록 / 대시보드 화면에서 다시 불러 볼 수 있습니다.

---

## 1. Phase 4의 목적

Phase 0.5 spike 이후 통화 화면은 진짜 WebSocket으로 동작했지만, 통화가 끝나면 그 데이터는 모두 사라졌습니다. Phase 4는 그 사라짐을 막고, 다음 네 가지 약속을 더합니다.

1. **통화·발화·다음 액션이 한 트랜잭션으로 DB에 영속된다.** Phase 0.5의 `start_call → text_chunk → end_call` 흐름이 그대로 살아 있고, 그 사이에 만들어진 데이터가 그대로 남습니다.
2. **통화 기록 페이지는 실 API로 동작한다.** 기존 8건짜리 정적 데모 배열은 사라지고, 검색 / 필터 / 상세 패널이 모두 서버에서 받은 본인 조직 데이터를 보여줍니다.
3. **대시보드는 본인 조직의 진짜 KPI를 보여준다.** 오늘 통화 수 / 응답률 / 평균 통화 시간 / 진행 중 통화 / 최근 통화 5건이 단일 API 응답에서 채워집니다.
4. **권한과 인증 상태가 통화 변경에 적용된다.** Viewer 역할은 통화 메모를 못 바꾸고, 이메일을 인증하지 않은 사용자는 그 어떤 통화 변경도 못 합니다.

Phase 4가 끝나면, 평가자는 **자기 통화를 직접 만들고, 다시 열어 보고, 대시보드에서 집계까지 확인**할 수 있습니다.

---

## 2. Phase 4에서 가능해진 것

평가 또는 검토 시점에 다음을 직접 확인할 수 있습니다.

- **실시간 통화 화면(`live.html`)의 모든 핵심 흐름이 영속화됨** — 통화 시작 즉시 DB에 행이 생기고, 발화는 서버가 받아 transcripts 테이블에 적층되고, 종료 버튼은 통화 상태를 `ended`로 마감하면서 `customers.last_contacted_at`까지 같은 트랜잭션에서 갱신합니다.
- **빠른 메모 저장(노트 입력 → 저장 버튼)** — 통화 중에 입력한 한 줄 메모가 `/calls/:id/notes`로 즉시 저장되고, 통화 기록 페이지의 상세 패널에 그대로 노출됩니다.
- **통화 기록 페이지(`calls.html`)가 실 API** — 정적 8건 배열은 사라졌습니다. 검색·상태 필터·상세 패널·URL 동기화가 모두 `/calls`, `/calls/:id`, `/calls/:id/transcript`, `/calls/:id/action-items`를 통합해서 동작합니다.
- **대시보드(`dashboard.html`) KPI 4장 + 최근 통화 5건이 실 API** — `/dashboard/summary` 단일 호출이 채웁니다. UTC 자정 기준의 "오늘 통화" 등 5개 지표가 본인 조직 데이터에 그대로 묶입니다.
- **미인증 사용자 가드** — 이메일 인증을 마치지 않은 사용자는 `dashboard.html` / `calls.html`에 들어가면 상단에 노란 띠가 뜨고, 통화 메모·전사·다음 액션의 모든 *변경* API가 `403 email_not_verified`로 거절됩니다. *읽기*는 여전히 허용됩니다.
- **권한 매트릭스** — admin / manager / employee는 통화를 만들고 메모하고 종료할 수 있습니다. employee는 본인이 진행한 통화의 메모/종료만 가능하고 남의 통화는 거절(403)됩니다. viewer는 읽기만 가능하고 변경은 모두 403.
- **조직 격리** — 다른 회사의 통화 ID로 직접 API를 호출해도 존재 자체가 노출되지 않고 `404 not_found`로 응답합니다.

---

## 3. 통화 영속화 — 시작부터 종료까지

### 3.1 통화 시작 — WebSocket `start_call`

`live.html`에 진입하면 페이지가 다음을 순서대로 실행합니다.

1. 메모리에 access token이 없으면 refresh 쿠키로 `/auth/refresh`를 한 번 호출해 토큰을 복구. 실패하면 로그인 화면으로 돌아갑니다.
2. `/me` 호출로 본인 정보를 받아 미인증 상태면 상단 노란 띠를 표시.
3. 인증된 WebSocket으로 `/calls` 네임스페이스에 접속.
4. 접속 직후 `start_call` 이벤트를 한 번 보냅니다.
5. 서버는 본인 조직 컨텍스트에서 `calls` 테이블에 새 행을 만들고 (`status='in_progress'`, `agent_user_id=본인`), ack로 `{ callId }`를 돌려줍니다.

이 시점부터 통화는 "DB에 존재"합니다. 페이지가 닫혀도 다음에 통화 기록 페이지를 열면 그 행이 그대로 보입니다.

### 3.2 발화 적층 — WebSocket `text_chunk`

데모 fixture가 흐르는 동안 (또는 향후 실 STT가 들어왔을 때), 발화는 `text_chunk`로 서버에 들어옵니다. 서버는 다음을 한 번에 처리합니다.

- `transcripts` 테이블에 (call_id, seq, speaker, text) 적층 — RLS는 본인 조직만 허용.
- 같은 발화를 클라이언트에게 `transcript` 이벤트로 echo (Phase 0.5 호환).
- 클라이언트가 보낸 `clientSentAt`이 그대로 돌아오므로 RTT 측정이 그대로 유지됩니다.

만약 적층 중에 통화가 사라졌다면(이론적 race), 서버는 `error { code: 'call_not_found' }`를 emit하고 클라이언트는 더 이상 echo를 기대하지 않습니다.

### 3.3 빠른 메모 — REST `POST /calls/:id/notes`

화면 하단 "통화 중 빠른 메모" 입력란은 다음을 거칩니다.

1. 사용자가 텍스트 입력 + 저장 버튼 클릭 (또는 Enter).
2. 클라이언트가 `POST /calls/:id/notes`로 보냅니다. 이 endpoint는 mutation이므로 `requireAuth → orgContext → requireVerified → requireRole → requireFreshRole` 5단계를 통과해야 합니다.
3. 저장 성공 → 입력란 옆에 작은 "저장됨" 라벨이 1.8초 뒤 자동으로 사라집니다.
4. 권한 부족(viewer) → "권한 없음", 미인증 → "이메일 인증 필요", 통화 사라짐 → "통화를 찾을 수 없음".

`start_call` ack를 아직 못 받은 상태에서 저장을 누르면 "통화 식별자 대기 중"으로 안내하고 호출하지 않습니다. ack가 도착하면 자연스럽게 다시 시도 가능.

### 3.4 종료 — WebSocket `end_call`

종료 버튼은 다음을 거칩니다.

1. 클라이언트가 `end_call` 이벤트를 emit하고 ack를 기다림.
2. 서버는 `service.endCall`을 한 트랜잭션 안에서 실행:
   - `calls.status = 'ended'`, `ended_at = now()`, `duration_seconds = ended_at - started_at`.
   - 통화에 `customer_id`가 붙어 있으면 `customers.last_contacted_at`을 `GREATEST(기존, ended_at)`으로 갱신.
3. ack `{ ok: true }` 수신 → 버튼 라벨이 "종료됨"으로 바뀌고 disabled.

종료 경로는 WebSocket 하나로 통일했습니다. REST의 `POST /calls/:id/end`도 살아 있지만 — 다른 디바이스에서 강제 종료하거나 e2e / 통합 테스트가 필요한 경우용 — 일상 종료는 WebSocket만 씁니다 (둘 다 호출하면 동일 행을 두 번 종료해서 `ended_at` / `duration_seconds`가 흔들릴 수 있어 단일 경로로 둠).

브라우저가 비정상 종료(탭 강제 닫음 등)된 경우, `beforeunload`에서 best-effort로 `end_call`을 emit하지만 ack를 못 기다리고 페이지가 사라집니다. 이때 통화가 `in_progress` 상태로 남는 케이스는 Phase 5에서 disconnect heartbeat 정책으로 일괄 `dropped` 마킹 도입 예정.

### 3.5 통화에 묶이는 데이터 모델

Phase 4에서 정착된 3개 테이블:

| 테이블 | 역할 | RLS |
|---|---|---|
| `calls` | 통화 1건 = 1 row. status / direction / sentiment / 요약 / 메모 / soft delete까지 한 행에 보관 | FORCE — 본인 조직만 |
| `transcripts` | 발화 단위. `(call_id, seq) UNIQUE`로 순서 보장. 부모 통화 cascade | FORCE — 본인 조직만 |
| `call_action_items` | 통화 후 다음 액션. 담당자·상태·완료일 | FORCE — 본인 조직만 |

세 테이블 모두 행 단위 보안이 **강제**(force) 상태로 켜져 있어, 직접 SQL을 우회해도 본인 조직 외 행에는 절대 접근할 수 없습니다.

---

## 4. 통화 기록 페이지 (`calls.html`) — mock 0건

### 4.1 목록과 검색

페이지 상단의 검색창 / 상태 필터(전체/진행 중/완료/미수신/끊김)가 모두 서버 쿼리로 동작합니다. 입력 디바운스 250ms 후 `/calls?q=...&status=...&limit=20&offset=0`이 발송되고 결과가 그대로 표에 그려집니다.

URL이 함께 동기화됩니다 — 예를 들어 `?q=phase4test`로 진입하면 검색창이 자동으로 채워지고 그 결과만 표시됩니다. 새로고침해도 같은 상태가 유지됩니다.

상단 "총 N 건"은 서버가 돌려준 `total` 값이 그대로 들어가므로, 페이지 단위 페이지네이션과 무관하게 본인 조직의 진짜 통화 수입니다.

### 4.2 상세 패널

목록의 행을 클릭하면 우측 패널이 슬라이드 인 하고, 다음 3개 요청이 동시에 갑니다.

- `GET /calls/:id` — 통화 본 행
- `GET /calls/:id/transcript` — 전체 발화
- `GET /calls/:id/action-items` — 다음 액션 목록

응답이 다 모이면 상태 뱃지(`완료`/`진행 중`/`미수신`/`끊김`), 통화 시간, 메모, 전사, 다음 액션, 자동 태그(감정 / 통화 유형)가 채워집니다. 만약 그 통화가 다른 조직 것이라면 본인 시야에서는 존재 자체가 보이지 않고 `404 not_found`로 응답이 통일됩니다.

### 4.3 XSS 안전 — 서버 응답은 모두 escape

상세 패널의 거의 모든 자리가 textContent로 직접 들어가지만, 다음 자리는 innerHTML로 보간되기 때문에 화면 로직이 명시적으로 `escapeHtml`을 거칩니다.

- 다음 액션(`#dActions`) — 각 항목의 제목 + 마감일
- 전사(`#dTranscript`) — speaker 라벨 + 본문 텍스트
- 자동 태그(`#dTags`) — 감정 / 통화 유형 라벨

서버에서 오는 값(`customer.name`, `transcript.text`, `notes` 등)은 외부 CRM에서 흘러들어왔을 수 있어 잠재적 HTML을 포함할 수 있다고 가정합니다. 본 페이지의 모든 server-supplied 보간은 escape 또는 textContent를 거칩니다.

### 4.4 (API) / (demo) 경계

| 영역 | 상태 |
|---|---|
| 사이드바, `/me`, 미인증 배너 | (API) |
| `/calls` 목록 + URL sync + 페이지 단위 페이지네이션 | (API) |
| 행 클릭 후 상세 패널 (call / transcript / action-items 병렬 fetch) | (API) |
| CSV 내보내기 버튼 | **(demo)** — Phase 6+ |

CSV 내보내기 버튼은 클릭해도 동작하지 않습니다. 단순 placeholder로, `title="CSV 내보내기 (Phase 6 예정)"` 표시.

---

## 5. 대시보드 (`dashboard.html`) — KPI 4장 + 최근 5건은 실 데이터

### 5.1 단일 호출 `/dashboard/summary`

페이지 진입 시 `/me`로 인사말과 미인증 배너를 그린 다음, `/dashboard/summary`를 한 번 호출합니다. 응답은 다음을 한 번에 담습니다.

| 필드 | 의미 |
|---|---|
| `today_calls` | 오늘(UTC 자정 기준) 시작된 통화 수 — soft-delete 제외 |
| `response_rate` | `ended / (ended + missed)` 오늘 비율. dropped는 분모에서 제외 (네트워크 실패는 응대 의지와 무관) |
| `avg_duration_seconds` | 오늘 완료 통화의 평균 길이 (없으면 NULL) |
| `active_calls` | 본인 조직 전체에서 현재 `in_progress` 상태인 통화 수 |
| `recent_calls` | 본인 조직 최근 통화 5건 (시작 시간 역순) — `customers` / `users` LEFT JOIN으로 고객·상담원 이름 함께 |

response_rate / avg_duration은 NULL일 때 "—"로 표시됩니다.

### 5.2 (API) / (demo) 경계

| 영역 | 상태 |
|---|---|
| 인사말 + 인증 배너 (`/me`) | (API) |
| KPI 4장 (오늘 통화 / 응답률 / 평균 통화 / 진행 중) | (API) |
| 최근 통화 5건 | (API) |
| 시장 트렌드 알림 5건 | **(demo)** — Phase 6+ daily.html과 통합 예정 |
| 오늘의 추천 To-Do 6건 | **(demo)** — Phase 5+ AI 추천 도입 |
| 팀 활동 5건 | **(demo)** — Phase 5+ `activity_log` 도입 |

demo 섹션 헤더에는 노란 `(demo)` 라벨이 명시돼 있어 평가 시점에 즉시 구분 가능합니다.

### 5.3 "오늘" 기준 시간대

KPI의 "오늘"은 서버 UTC 자정 기준입니다. 한국 시간 09:00에 자정 경계를 넘으므로, 한국 자정 직후 ~09:00 사이에 진행 중인 통화는 *어제*의 today_calls 카운트에 잡힙니다. 조직 단위 timezone은 Phase 6+로 미뤘습니다.

---

## 6. 권한·인증 정책

### 6.1 통화 mutation 권한 매트릭스

| 역할 | 통화 읽기 (자기 조직) | 본인 통화 변경 (메모 / 종료) | 다른 사람 통화 변경 | 통화 삭제(soft) | dashboard 읽기 |
|---|---|---|---|---|---|
| admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| manager | ✓ | ✓ | ✓ | ✓ | ✓ |
| employee | ✓ | ✓ | ✗ (403) | ✗ | ✓ |
| viewer | ✓ | ✗ (403) | ✗ | ✗ | ✓ |

추가 규칙:

- **본인 통화 판정** — `calls.agent_user_id = 본인 사용자 id`. employee가 자기 통화 외 변경을 시도하면 403.
- **cross-org 격리** — RLS 4 정책이 본인 조직만 허용. 다른 조직 통화 ID로 mutation/read 모두 404로 통일 (존재 노출 없음).
- **WebSocket persistence** — `start_call` / `text_chunk` / `end_call` 모두 서버가 socket.user를 그대로 `agent_user_id`로 박습니다. 클라이언트가 임의의 `agent_user_id`로 위조하는 경로 없음.

매니저 team-scope("자기 팀 통화만") 정책은 Phase 5에서 manager 보고서와 같이 도입됩니다.

### 6.2 미인증 사용자 가드 — `requireVerified` 미들웨어

Phase 4가 도입한 미들웨어 `requireVerified`는 모든 통화 / 다음 액션의 *변경* 엔드포인트 전에 실행되어, `users.email_verified_at`이 NULL이면 `403 email_not_verified`를 반환합니다.

| 엔드포인트 | requireVerified 적용 |
|---|---|
| `GET /calls`, `GET /calls/:id`, `GET /calls/:id/transcript`, `GET /calls/:id/action-items` | ✗ (읽기는 허용) |
| `POST /calls`, `POST /calls/:id/notes`, `POST /calls/:id/end`, `POST /calls/:id/transcript`, `POST /calls/:id/action-items` | ✓ |
| `POST /call-action-items/:id/status`, `POST /call-action-items/:id/assignee` | ✓ |
| `GET /dashboard/summary` | ✗ (읽기는 허용) |

화면 차원에서는 `dashboard.html` / `calls.html` / `live.html` 진입 시 `/me` 응답에 `email_verified_at`이 비어 있으면 상단 노란 띠가 표시되고, "재발송" 버튼으로 재인증 요청 가능합니다.

### 6.3 `requireFreshRole`

Phase 3에서 도입된 미들웨어가 Phase 4 mutation에도 동일하게 적용됩니다. JWT의 역할과 DB의 현재 역할이 다르면 `401 stale_role`로 재로그인을 요구합니다. "관리자에서 일반 직원으로 강등된 사용자가 옛 토큰으로 변경을 시도하는" 경로를 차단합니다.

---

## 7. 알아야 할 제한사항

Phase 4는 통화 영속화를 연 단계입니다. 다음은 다음 Phase로 미뤄져 있습니다.

- **실제 STT (Naver Clova)** — 현재 transcript 적층은 Phase 0.5 fixture 또는 수동 API 호출. 실 음성 인식 어댑터는 Phase 5.
- **AI 통화 요약 / 응대 추천 자동 생성** — `calls.summary` / `needs` / `issues` / `sentiment` 컬럼은 이미 있지만, 채우는 주체는 사용자 수동(메모 / 노트) 또는 향후 Phase 5의 AI 파이프라인.
- **상담 체크리스트 / AI suggestion 영속화** — `live.html`의 정적 5항목 체크리스트와 추천 카드는 본 phase 영속화 대상 아님. Phase 5에서 같이.
- **CSV 내보내기 (`calls.html`)** — Phase 6+.
- **disconnect 자동 `dropped` 처리** — 브라우저가 비정상 종료된 경우 in_progress 상태가 잠시 남을 수 있음. Phase 5 heartbeat 정책.
- **`live.html` 좌측 고객 카드 / 통화 meta** — 현재 정적 데모. `customer_id`를 받아 채우는 흐름은 Phase 5에서 customer selection 도입 시 같이.
- **action item / transcript 작성 UI** — 상세 패널은 읽기 전용. 백엔드 mutation 엔드포인트는 노출돼 있어 추후 UI만 추가하면 동작.
- **calls.html 정렬 컨트롤** — 시간 역순 고정. 다양한 정렬은 백엔드 schema 변경과 함께 후속 phase에서.
- **manager team-scope 권한** — 자기 팀 통화만 보이는 정책. Phase 5에서 manager 보고서와 같이.
- **조직 단위 timezone** — 현재는 서버 UTC 기준. Phase 6+.

---

## 8. 다음 Phase에서 추가될 것

| 다음 단계 | 추가될 기능 (요약) |
|---|---|
| **Phase 5** | 실제 STT(네이버 Clova), AI 응대 추천 + 통화 후 자동 요약, action item / transcript 작성 UI, disconnect heartbeat, manager team-scope 권한, customer selection 흐름 |
| **Phase 6+** | 실 SMTP / Resend, 운영 도메인, 조직 timezone, CSV 내보내기, activity_log, retention 정책 enforce, MFA, 결제·구독 |

Phase 4가 만든 약속(통화 영속화·실 API calls/dashboard·권한 매트릭스·미인증 가드·조직 격리)은 다음 Phase의 새 기능에서도 동일 패턴으로 적용됩니다.

---

## 9. 자동 회귀 — 이 약속이 다음 변경에 깨지지 않도록

Phase 4의 모든 약속은 자동 검사로 매번 검증됩니다.

- **서버 단위 테스트 누적 212개** — auth · rls · orgContext · ws_auth · customers · invitations · team / member · password reset · signup verify · calls repository · transcripts repository · action items repository · calls service / endCall 트랜잭션 · routes (calls 18 + dashboard 8) · ws persistence 6.
- **공유 타입 동기화 (9 entity)** — `customers` / `signup` / `password-reset` / `team` / `invitation` / `call` / `transcript` / `actionItem` / `dashboard`. 서버 zod 정의와 화면 JSDoc 정의의 필드 집합이 일치하는지 검증.
- **Phase 0.5 e2e 16/16** — 실시간 통화 흐름 회귀 (Phase 1 약속).
- **Phase 2 customers e2e 7/7** — 고객 CRUD 회귀 + leftover sweep 0.
- **Phase 3 e2e 33 assertion** — 회원가입 / 인증 / 비밀번호 재설정 / 초대 / 역할 변경 / 마지막 admin 보호 / cleanup.
- **Phase 4 e2e 8 시나리오 + cleanup sweep** — 통화 시작 / 빠른 메모 / 종료 → API 등장 / 상세 패널 / transcript+action item 렌더 / dashboard KPI 매치 / 다른 조직 격리 / viewer mutation 403 / unverified 배너+mutation 403 / phase4test 잔재 0.

이 여섯 가지가 모두 통과해야만 Phase 4가 합격으로 인정됩니다.

---

## 10. 기술 요약 (참고)

이 섹션은 보안·아키텍처에 관심 있는 평가자가 핵심 결정 사항을 한눈에 보기 위한 짧은 요약입니다.

- **신규 스키마 4 migration** — `calls` / `transcripts` / `call_action_items` 테이블 + RLS FORCE + 부분 인덱스 (list / per-customer / per-agent / open-action-items) + 부속 app role grants. 모두 forward-only.
- **composite FK guard** — `calls(org_id, customer_id) → customers(org_id, id)`, `calls(org_id, agent_user_id) → memberships(org_id, user_id)`. 두 FK는 조합 키를 받으므로 cross-org 참조 자체가 PostgreSQL 레벨에서 차단됩니다.
- **soft delete + 부분 인덱스** — `calls.deleted_at`. 모든 read 인덱스가 `WHERE deleted_at IS NULL` 부분 인덱스라 write 비용·인덱스 크기 모두 절감. transcripts / call_action_items는 부모 cascade로 독립 soft delete 없음.
- **endCall 트랜잭션** — `calls` 상태/종료시각/지속시간 UPDATE + 통화에 customer_id가 있으면 `customers.last_contacted_at = GREATEST(기존, ended_at)`을 같은 트랜잭션. trigger 사용 안 함 (디버깅 명확성 우선).
- **`requireVerified` 위치** — `requireAuth → orgContext → requireVerified → requireRole → requireFreshRole` 체인. 비활성 멤버는 같은 미들웨어에서 `401 stale_session`으로 통합 분기. 의도된 모든 4xx 경로를 routes test 32 case로 검증.
- **WS persistence hook** — `start_call` 시 calls insert, `text_chunk` 시 transcripts append + echo, `end_call` 시 service.endCall. 클라이언트가 임의의 `agent_user_id`를 박는 경로 없음 (서버가 socket.user.id로 고정).
- **shared types 9 entity** — `server/src/types/*` zod 원본 + `platform/types/*.js` JSDoc 사본 + `test/sync_shared_types.mjs` registry. 새 entity 추가 시 registry에 한 줄 추가하는 단일 진입점.
- **dashboard "오늘" 정의** — `date_trunc('day', now() AT TIME ZONE 'UTC')` 기준. 조직 timezone 도입은 Phase 6+ 결정.
- **innerHTML XSS gate** — `customers.html` / `team.html` / `calls.html` / `dashboard.html` 모두 동일 형태의 `escapeHtml` 헬퍼를 가지고, server-supplied 보간 자리를 명시적으로 escape. `live.html`의 transcript bubble은 textContent, AI suggestion은 DOMPurify 경유.
- **e2e cleanup** — `phase4test-` prefix와 테스트 사용자(`phase4test-%@example.test`) `agent_user_id`에 연결된 통화 그래프만 hard-delete. 같은 dev DB의 무관한 수동 통화는 건드리지 않음. Phase 4 테이블에는 `kloser_service` grant가 없는 의도된 설계라 dev-only로 superuser를 사용.
- **자동 회귀** — `npm --prefix server test` 212/212 + `node test/sync_shared_types.mjs` 9 entity + `phase_0_5_e2e` 16/16 + `phase_2_customers_e2e` 7/7 + `phase_3_e2e` 33 + `phase_4_e2e` 8 시나리오 + cleanup sweep. 모두 그린일 때만 Phase 4 합격.
