# Phase 4 — Step 4 Findings (Frontend Wiring)

> **완료일**: 2026-05-12
> **범위**: `platform/api.js` Phase 4 helper + `platform/live.html` 영속 hook UI wiring + `platform/calls.html` mock 제거 → 실 API + `platform/dashboard.html` KPI/recent 실 API + 미인증 배너 wire. 서버는 손대지 않았다.

---

## 1. 적용 파일

수정 (5):

- `platform/api.js` — Phase 4 helper 12개 추가 (`listCalls / getCall / createCall / patchCallNotes / endCall / listTranscript / appendTranscript / listActionItems / createActionItem / patchActionItemStatus / patchActionItemAssignee / getDashboardSummary`)
- `platform/live.html` — start_call ack callId 보관, customerId='demo-customer' 제거, 종료 버튼 + 빠른 메모 input wire, beforeunload는 WS endCall만 호출 (REST 중복 방지)
- `platform/calls.html` — 8건 mock array 제거, `/calls` API + URL sync (q/status/customerId/agentUserId/limit/offset) + detail panel 병렬 fetch (call/transcript/action-items) + notes 패널 신설 + 부팅 hook (/me + sidebar + verify banner)
- `platform/dashboard.html` — KPI 4장(`today_calls/response_rate/avg_duration/active_calls`) + 최근 통화 5건을 `/dashboard/summary` 응답으로 교체, 인사말 사용자 이름 /me 기반 + 미인증 배너 wire, 남은 demo 영역(트렌드/To-Do/팀활동)은 (demo) 라벨
- `docs/plan/phase-4/PHASE_4_STEP_4_FINDINGS.md` (본 문서)

신규 (1):

- (이 문서)

수정 안 함: 서버 코드 / 마이그레이션 / shared types / 백엔드 테스트.

---

## 2. mock 제거된 영역 / 남은 demo 영역

### 2.1 제거된 mock

| 위치 | 이전 | 이후 |
|---|---|---|
| `calls.html` `const calls = [...8 row]` | hardcode 8건 | `/calls` 실 API + URL sync |
| `calls.html` "총 1,243건" 헤더 | hardcode | `/calls` 응답 `total` |
| `calls.html` filter chips (오늘/이번주/완료/미완료/후속) | 클라이언트 필터 | `status` enum chip (in_progress/ended/missed/dropped) — 서버 필터로 전환 |
| `calls.html` 검색 (`고객명·회사명 키워드`) | 클라 substring | 서버 `q=` (title/notes/summary) + 250ms debounce + URL sync |
| `calls.html` row 클릭 detail (8 row 정적 객체) | hardcode | `/calls/:id` + `/transcript` + `/action-items` 병렬 |
| `calls.html` `dActions`/`dTranscript`/`dTags` innerHTML 직접 보간 | 정적 데이터 그대로 박힘 | server-supplied 필드는 모두 `escapeHtml`/`textContent` 경유 |
| `dashboard.html` KPI 4장 (23 / 82.6% / 11m24s / 4) | hardcode | `/dashboard/summary` 실 응답 |
| `dashboard.html` 최근 통화 5건 (`recent = [...]`) | hardcode | `recent_calls` 5건 (LEFT JOIN customer/agent name) |
| `dashboard.html` 인사말 "좋은 아침, 김민수님" | hardcode 이름 | `/me` 응답의 `user.name` (없으면 email prefix) |
| `live.html` start_call payload `{ customerId: 'demo-customer' }` | 비-UUID 박혀 있었음 | `{}` (서버는 UUID 외 customerId를 NULL로 흡수) |
| `live.html` 종료 버튼 | 핸들러 없음 | `kloserWS.endCall(socket)` ack 대기 + UI lock |
| `live.html` 빠른 메모 input | 핸들러 없음 | `/calls/:id/notes` + 200/403/404 상태 표시 |

### 2.2 의도적으로 남긴 demo 영역

| 위치 | 사유 | 라벨 표시 |
|---|---|---|
| `live.html` 고객 카드 (김민수 / Kloser Inc. / CTO) | call이 customer_id NULL 통화 모델이라 customers join 없이 표시할 데이터 없음 | (별도 라벨 미부착 — 다음 phase 작업에서 customer panel 자체를 customer_id 기반으로 교체) |
| `live.html` 통화 meta (유형/번호/상담원/캡처 품질) | 좌측 카드 전체가 demo. WS persistence 흐름과 별개 | (별도 라벨 미부착) |
| `live.html` 상담 체크리스트 / 빠른 응대 멘트 / AI suggestions / sentiment | Phase 5 (실 AI / STT) 영역 | `live.html` 음소거/대기 버튼 `title="(demo)"` |
| `dashboard.html` 시장 트렌드 알림 5건 | Phase 6+ (네이버 검색 API + daily 통합) | 헤더에 `(demo)` |
| `dashboard.html` 오늘의 추천 To-Do 6건 | Phase 5+ (AI 추천) | 헤더에 `(demo)` |
| `dashboard.html` 팀 활동 5건 | Phase 5+ (activity_log) | 헤더에 `(demo)` |
| `dashboard.html` 인사말 우측 본문 ("17개 To-Do / 3건 미팅") | demo 데이터 의존 | 문구에 `(추천 To-Do / 미팅 안내는 demo)` |
| `calls.html` "CSV 내보내기" 버튼 | Phase 6+ (settings 안내 부합) | `title="CSV 내보내기 (Phase 6 예정)"` |

### 2.3 (API) ↔ (demo) 경계 변화

Phase 4 진입 전과 비교한 demo→real 이동:

- `live.html`: WS start/transcript/end_call 흐름 (이미 (API)) + 종료 버튼/메모 input (Phase 4에서 (API)로 이동)
- `calls.html`: 목록/필터/검색/detail 전체 영역이 (demo) → (API). 좌측 사이드바·인증 게이트는 이미 (API). 남은 (demo)는 CSV 버튼.
- `dashboard.html`: KPI 4장 + 최근 통화 5건이 (demo) → (API). 트렌드/To-Do/팀 활동/일부 헤더 문구는 (demo) 유지하되 라벨 표시.

---

## 3. XSS 처리 방식

AGENTS.md "innerHTML XSS gate" 준수 — server-supplied 필드를 직접 innerHTML 보간하는 자리를 모두 audit.

### 3.1 calls.html

- `escapeHtml()` 로컬 헬퍼 정의 (customers.html / team.html과 동일 형태 — 1줄 단위 동일 복제).
- `renderTable()` row 보간: status 라벨, 타이틀, customer_id slice, direction 라벨, duration, started_at, summary/notes — **모두 escape**. status 메타 객체와 direction 라벨 맵은 상수라 escape 불필요.
- `openDetail()` 보간 자리:
  - `dActions` 항목 (title + due_date) — escape.
  - `dTranscript` 항목 (speaker 라벨은 상수, text는 server-supplied → escape).
  - `dTags` (sentiment / direction 라벨 → escape; 둘 다 enum이라 사실상 안전하지만 명시).
- 직접 textContent 사용: `dCallId`, `dStatus`, `dDate`, `dDuration`, `dAvatar`, `dCustomer`, `dCompany`, `dNeeds`, `dIssues`, `dNotes`.

### 3.2 dashboard.html

- `escapeHtml()` 동일 헬퍼 복제.
- `renderRecentCalls()` 보간: 고객 이름 / 상담원 이름 / 타이틀 / direction 라벨 / 시간 / status 라벨 — **모두 escape**. status 메타 / pulse-dot HTML 은 상수.
- 직접 textContent 사용: 모든 KPI 카드 (`kpiTodayCalls/kpiResponseRate/kpiActiveCalls`). `kpiAvgDuration`만 `innerHTML`로 `m`/`s` 단위를 작은 폰트로 분리 — content는 정수 + `<span>` 정적 → 안전.
- 남은 demo 영역(To-Do 목록 / 팀 활동 / 트렌드)은 정적 상수 데이터라 escape 안 함. server-supplied로 전환 시 escape 추가 필요 — 코드 주석으로 명시.

### 3.3 live.html

이미 Phase 0.5/1에서 transcript bubble과 AI suggestion 모두 textContent / DOMPurify 경로 사용 (Day 3 audit 완료). 본 step에서는 메모 input 저장 결과 텍스트 (`#noteStatus`)에 textContent 사용 + 종료 라벨도 textContent → 추가 노출 없음.

---

## 4. live end_call 중복 호출 방지

WS persistence가 켜진 이상 `start_call`/`text_chunk`/`end_call` 모든 흐름이 서버 측 service를 통과한다. 클라이언트가 REST `POST /calls/:id/end`를 추가로 호출하면 같은 row를 두 번 종료 처리해서 `ended_at`이 흔들리거나 `duration_seconds` 재계산이 어긋날 수 있다 (service.endCall은 idempotent하지 않다 — `endByIdInCurrentOrg`가 항상 `now()`로 ended_at을 덮는다).

**결정**: 종료 경로는 WS end_call 단일 경로. REST `POST /calls/:id/end`는 클라이언트가 직접 호출하지 않는다.

- **종료 버튼**: `kloserWS.endCall(socket)` ack만 받음 (REST 안 부름).
- **beforeunload**: `callState.status === 'live'`일 때만 `kloserWS.endCall(socket)` 한 번 더 시도 — best-effort. ack 대기 안 함 (페이지 unload 중이라 의미 없음).
- **REST endpoint는 살아 있다**: 운영자/admin이 다른 디바이스에서 강제 종료해야 할 때, 또는 e2e/통합 테스트에서 사용. live.html은 호출하지 않는다.

또 한 가지: 종료 버튼은 `callState.status`를 'idle' → 'live' → 'ending' → 'ended'/'failed'로 진행시키고 'live'가 아니면 동작 안 함. 사용자가 종료 후 다시 클릭해도 추가 종료 시도 안 일어남.

---

## 5. 검증

### 5.1 자동 테스트

- `npm --prefix server run typecheck` PASS
- `node test/sync_shared_types.mjs` PASS (9 entity)
- `npm --prefix server test` PASS — **212/212**
- `node test/phase_0_5_e2e.mjs` PASS (16 assertion + no console errors)
- `node test/phase_2_customers_e2e.mjs` PASS (전 시나리오 + cleanup)
- `node test/phase_3_e2e.mjs` PASS (33 assertion + cleanup)

### 5.2 Playwright manual (MCP) 8 시나리오

| # | 시나리오 | 결과 |
|---|---|---|
| 1 | admin@acme 로그인 → live.html → start_call ack callId 확인 | ✓ `callId=990be34a-…` 콘솔 로그 |
| 2 | 빠른 메모 input 저장 → calls.html detail에서 notes 확인 | ✓ list summary 컬럼 + detail "메모" 패널에 `phase4test 빠른 메모 — 저장 검증` 표시 |
| 3 | 종료 버튼 → status='ended' UI lock | ✓ 버튼 라벨 "종료됨", disabled |
| 4 | calls.html 목록/검색/detail/transcript/action items 렌더 | ✓ 목록 4건, 검색 `phase4test` → 1건 + URL `?q=phase4test`, detail 정상 |
| 5 | dashboard.html KPI/recent가 새 통화 반영 | ✓ today=4 / response_rate=100% / avg=42s / active=3 / recent 4건, 첫 행 방금 종료 |
| 6 | beta admin 로그인 시 Acme 통화 안 보임 | ✓ calls.html 총 2건, `phase4test` / `990be34a` 누출 0 |
| 7 | calls / dashboard에서 미인증 배너 wire 확인 | ✓ 두 페이지 모두 `window.renderUnverifiedBanner`로 직접 호출 시 배너 inject |
| 8 | console error 0 | ✓ 페이지 전환 전부 `Console: 0 errors, 1 warnings` (warning은 tailwind CDN 메시지 — 기존부터 동일) |

페이지 cleanup: 검증 종료 후 Acme 통화 4건 + Beta 통화 2건 hard-delete (다음 e2e가 영향 안 받게).

---

## 6. 미해결 / 위험

1. **live.html 좌측 고객 카드 / 통화 meta 정적**: 현재 customer_id NULL 통화 모델에 맞춰 카드 자체가 demo 상태. Phase 5에서 customer_id 매칭 흐름(start_call에 valid customer_id 전송)이 정해지면 `/customers/:id` 응답으로 채워야 함.
2. **WS text_chunk seq vs DB seq**: live.html은 client `seq`만 다루고 DB seq는 detail 페이지에서 노출. UI는 두 값을 동일 가정하지 않는다 (echo는 client.seq, list는 DB seq). 두 의미 차이가 향후 transcript export / replay 기능에 영향 가능성 — Phase 5 STT 도입 시 재검토.
3. **disconnect → dropped 자동 마킹 부재**: 사용자가 brower 탭을 그대로 닫으면 beforeunload가 `endCall`을 emit하지만 ack 못 기다림. 서버 측에서도 socket disconnect → 자동 status='dropped' 처리는 아직 안 함 (Step 3 인계 사항). 결과적으로 한동안 in_progress 상태로 남는 row가 생길 수 있다.
4. **calls.html 정렬 미지원**: 백엔드 `CallListQuery`에 sort/dir 필드가 없어서 UI 정렬 컨트롤을 만들지 않았다. 시간 역순 고정. customer.html 같은 사용자 정렬은 후속 phase에서 백엔드 schema 변경과 함께 도입.
5. **`active_calls` KPI는 org 전체 (today 윈도우 아님)**: 백엔드 의도와 일치(`status='in_progress'` 카운트). 시드/테스트 잔재 in_progress가 누적되면 카드 값이 부풀려질 수 있다. 운영 시 disconnect 자동 dropped 정책이 도입되면 자연 정상화.
6. **action item / transcript 작성 UI 미구현**: detail 패널은 read-only. action item 생성/완료, transcript 수동 추가 UI는 Phase 5+. backend는 mutation endpoint 노출 (calls_routes test에서 검증) — 추후 frontend wiring만 추가하면 동작.
7. **calls.html "새 통화" 버튼**: live.html로 이동하는 anchor로 교체. 실제 통화 생성은 live.html의 WS 흐름이 담당. button → a 변경으로 동작 변경 없음.

---

## 7. Codex 집중 리뷰 포인트

1. **WS persistence + REST end 중복 차단 정책 (live.html 종료 경로 단일화)** — beforeunload best-effort에서도 ack 안 기다림. 사용자가 새로고침으로 끝나는 일반적 경우에 in_progress가 남는 비율이 의도된 trade-off인지 검토. 자동 dropped는 Phase 5 disconnect heartbeat 정책에 묶음.
2. **calls.html `q`/검색 debounce 250ms** — 빠른 입력 시 race로 직전 응답이 늦게 덮을 수 있음. 현재 구현은 `searchTimer` 단일 슬롯만 관리 — 마지막 fetch가 도착 순서대로 덮는 단순 모델. 정밀성 필요하면 request id로 무시 처리 필요.
3. **calls.html `customerId=null` 필터 인코딩** — URL에 `customerId=null` 문자열을 그대로 박는다. api.js helper가 `null` literal을 그대로 `URLSearchParams.set(k, 'null')`로 보내고, 백엔드 `CallListQuery.customerId` preprocessor가 `"null"` → `null`로 해석. 두 표현이 다 통하는 건 의도된 contract(평면 GET 쿼리에서 null을 표현하기 위함). frontend가 이 의미를 깨면 cross-org 누출 위험은 없지만 필터 동작이 어긋남.
4. **escapeHtml 헬퍼 복제 3곳** (customers/team/calls/dashboard) — 동일 함수가 4번 정의됨. `_shared.js`로 옮기는 게 더 깔끔하지만 본 step에서는 별도 변경 없이 패턴 따름. 후속 cleanup phase 검토.
5. **`dashboard.html` `kpiAvgDuration`만 `.innerHTML`** — `<span>m</span>`/`<span>s</span>` 단위 분리 때문. 보간 본문은 모두 정수 (`formatAvgDurationLabel`에서 `Math.floor` 후 String) — 안전하지만 server-supplied로 바뀌면 escape 필요. 주석 추가 안 함 — 코드 자체로 명확한지 검토.
6. **`live.html` callState가 window 노출 안 됨** — IIFE 내부 const. 검증 시 콘솔 로그로 callId 확인했음. e2e가 callState 직접 검증해야 한다면 `window.__liveCallState = callState`를 dev-only 노출하는 게 좋을지 검토 (Phase 5 e2e 작성 시 동시에).
7. **dashboard.html greeting fallback 순서**: `user.name` → email prefix → '사용자'. team-invite 흐름에서 name 비어 있고 email은 있는 user 케이스 정상 동작. 시드 user 모두 name 있어서 검증 케이스는 한국어 이름 위주.

---

## 8. git 작업

git add / commit / push / merge 0건. Codex가 본 보고와 diff를 검토 후 commit 결정.

변경 파일 git 표면:

```
M docs/plan/phase-4/PHASE_4_MASTER.md      (Step 4 완료 표기)
M platform/api.js                          (Phase 4 helper 12개)
M platform/calls.html                      (mock 제거 + 실 API)
M platform/dashboard.html                  (KPI/recent 실 API)
M platform/live.html                       (callId 보관 + 종료/메모 wire)
?? docs/plan/phase-4/PHASE_4_STEP_4_FINDINGS.md
```
