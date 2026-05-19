# Phase 8 Step 4 Findings - Frontend Playback UI

작성일: 2026-05-19

상위 문서: `PHASE_8_MASTER.md`
계획 문서: `PHASE_8_STEP_4_PLAN.md`
선행 결과: `PHASE_8_STEP_3_FINDINGS.md`

---

## 1. 결과 요약

Phase 8 Step 4는 frontend-only 변경으로 `platform/calls.html` detail panel에 recording playback surface를 추가했다.

수정된 파일은 2개뿐이다.

- `platform/api.js`
- `platform/calls.html`

backend route/schema/storage/audit 계약은 손대지 않았다. desktop/browser audio capture pipeline, retention worker integration, waveform, transcoding은 미구현 (계획대로).

---

## 2. `platform/api.js`

신규 helper 3종 + `window.kloserApi` 등록:

```js
listCallRecordings(callId)
getCallRecordingPlaybackUrl(callId, recordingId)
deleteCallRecording(callId, recordingId)
```

- 모든 path 파라미터를 `encodeURIComponent`로 escape.
- 기존 `apiGet` / `apiDelete` thin wrapper 패턴 그대로 — raw `Response` 반환, caller가 `res.ok` / `res.status` 검사.
- helper / module 어디에서도 signed URL이나 object key를 `console.log`하지 않는다.

---

## 3. `platform/calls.html` — Recording Surface

### 3.1 마크업

manual summary writer section 바로 위에 단일 section을 끼웠다.

```html
<section>
  <div class="text-[.62rem] font-black uppercase tracking-wider text-slate-400 mb-2">녹음</div>
  <div id="dRecordingSurface" class="rounded-lg border border-slate-200 bg-white p-3 text-[.78rem] text-slate-600"></div>
</section>
```

기존 `_shared.css` 유틸리티만 사용. 외부 라이브러리 / waveform / canvas / 신규 CSS 없음.

### 3.2 상태 모델

module-level state:

```js
let currentCallId = null;
let currentRecording = null;
let recordingAudioEl = null;
let recordingUrlRefreshTimer = null;
let recordingPlaybackEpoch = 0;
let currentUser = null; // /me snapshot, role만 캐시
```

`recordingPlaybackEpoch`는 monotonic 카운터. `clearRecordingPlayback()`에서 +1, 비동기 playback URL 응답은 자신의 epoch token과 현재 값을 비교해 stale일 때 drop. detail switch race condition에 안전.

### 3.3 6-state Renderer

`renderRecordingSurface(state, data)` 단일 함수:

| state | 동작 |
|---|---|
| `loading` | "로딩" 배지 + "녹음 정보를 불러오는 중…" |
| `none` | "녹음 없음" 배지 + 안내 문구. audio element 없음 |
| `processing` | `upload_pending` / `uploaded` / `processing`을 각각 "업로드 대기 / 처리 대기 / 처리 중"으로 매핑 + 새로고침 버튼 |
| `available` | "재생 가능" 배지 + `<audio controls preload="none" class="w-full max-w-full">` + URL 새로고침 + 삭제 버튼 + duration/size/codec 메타 |
| `failed` | "실패" 배지 + `error_message` (escapeHtml/textContent) |
| `deleted` | "삭제됨" 배지 + 안내 문구 |

- duration/size/codec는 helper로 포맷팅한 뒤 escapeHtml. server-supplied 값은 어디에도 raw로 들어가지 않는다.
- audio element 생성 시점에는 `src` 없음. 후속 `requestPlaybackUrl`에서 DOM property로만 세팅.

### 3.4 Detail Open / Switch / Close

`openDetail(callId)`:
1. `clearRecordingPlayback()` — 이전 audio src/timer 즉시 정리, epoch +1.
2. `renderRecordingSurface('loading', {})` — 화면 깜빡임 방지.
3. 기존 4-way parallel fetch에 `listCallRecordings(callId)`를 5번째로 추가 (`Promise.all`).
4. call 본문 렌더 후 마지막에 `currentCallId === callId` 확인 후 `applyRecordingsResponse(callId, recRes)`.

`closeDetail()`:
- `clearRecordingPlayback()` + `dRecordingSurface.innerHTML = ''`.

call 전환:
- 새 `openDetail` 시작 시점에서 자동으로 이전 audio src 해제, refresh timer 취소.

### 3.5 Signed URL Lifecycle

`requestPlaybackUrl(callId, recordingId)`:
- 응답 받기 전에 `recordingPlaybackEpoch` 캡처. 응답 도착 시 epoch 일치 검사.
- 200 → `audio.src = playback.url` (DOM property 할당, page-authored innerHTML template 미경유), `scheduleRecordingUrlRefresh`.
- 409 / 404 → `loadRecordingsForCurrentCall()` 호출해 server truth로 재조정.
- 기타 실패 → 상태 텍스트로만 표시. URL 자체는 console / visible text에 노출하지 않는다.

`scheduleRecordingUrlRefresh(callId, recordingId, expiresAtIso)`:
- 만료 30초 전 갱신. 너무 가까우면 15초 floor.
- 이전 timer 클리어 후 새 timer 설치. epoch + currentCallId + currentRecording.id 모두 일치할 때만 갱신.

`handleRecordingAudioError`:
- one-shot retry: src 제거 → 한번 더 `requestPlaybackUrl`. 재시도도 실패하면 "재생 링크를 새로 받을 수 없습니다" 표시 후 무한 루프 없이 stop.
- 5초 cooldown 후 retry 가드 reset (이어지는 무관한 에러 대비).

### 3.6 Delete

`available` state의 삭제 버튼:

- 표시 조건: `currentUser.role !== 'viewer'`. backend는 여전히 권한 authority — 403 surface "권한 없음".
- 204 / 404: idempotent reload (`renderRecordingSurface('deleted', {})` → `loadRecordingsForCurrentCall`).
- 403: "권한 없음", 버튼 다시 활성화.
- 502: "저장소 삭제 실패. 잠시 후 다시 시도해주세요.", 다시 활성화.
- 기타 코드: "삭제 실패 (status)".

### 3.7 `/me` 캐시

boot 시 `/me` 응답을 `currentUser = { role }`로만 저장. 다른 UI 결정에는 사용하지 않는다 (기존 manual-summary / action item 코드는 변경 없음).

---

## 4. XSS / 정보 노출 가드

| 항목 | 보장 방법 |
|---|---|
| signed URL → visible DOM text | 발생 안 함. `audio.src` DOM property로만 할당하고 화면 텍스트로 렌더하지 않는다. |
| signed URL → page-authored innerHTML template | 발생 안 함. URL은 template string에 보간하지 않는다. 단, 브라우저는 media `src` property를 element attribute로 반영할 수 있으므로 DOM inspector/outerHTML에서 media `src`가 보일 수 있다. |
| signed URL → console | `console.log(playback.url)` 같은 호출 없음. error 메시지에도 status만 표시. |
| `object_key` / `storage_bucket` / `storage_provider` / `object_version` / `checksum_sha256` / `metadata` | Step 3 response가 애초에 노출 안 함. UI도 어떤 필드 이름도 참조하지 않음. |
| `error_message` | `escapeHtml`을 거쳐 innerHTML, 또는 처음부터 textContent. |
| 사용자 입력 | recording surface에는 사용자 입력 없음. |

---

## 5. Browser Smoke Results

`http://localhost:8765/platform/calls.html` 데스크탑 1440×900 + 모바일 390×844로 검증.

### 5.1 데스크탑 (1440×900) - admin@acme.test

3개 fixture call 생성 후 detail 열기:

| Fixture | 결과 |
|---|---|
| `phase8-step4-smoke/none` (no recording) | "녹음 없음 / 이 통화에는 녹음 파일이 없습니다." — audio 없음 |
| `phase8-step4-smoke/processing` (upload_pending recording) | "업로드 대기 / 곧 재생할 수 있습니다." + 새로고침 버튼 — audio 없음 |
| `phase8-step4-smoke/available` (finalized recording) | "재생 가능" + audio element + "URL 새로고침" + "삭제" + "12초 · 4 KB" 메타 |

XSS 점검:

```js
htmlContainsObjectKey: false
htmlContainsBucket: false
visibleTextContainsSignature: false
```

audio src 확인:

```js
audioSrc: "http://localhost.invalid/recordings/orgs/11111111-1111-1111-1111-111111111111/ca..."
audioSrcType: "string"  // DOM property로 set, page-authored innerHTML template 미경유
```

### 5.2 Detail Switch / Close Cleanup

- available → none 전환: `audioStillExistsAfterSwitch=false` (audio element 즉시 제거됨)
- `closeDetail()`: `surfaceClearedAfterClose=true` (innerHTML 비워짐)

### 5.3 Delete 액션

admin 계정 (role='admin')에서:
- 삭제 버튼 `delVisible=true`
- 클릭 → 204 → renderRecordingSurface('deleted') → loadRecordingsForCurrentCall → "녹음 없음"으로 reconcile
- `recAfterDelete: "녹음 없음이 통화에는 녹음 파일이 없습니다."`

### 5.4 Mobile (390×844)

새 available 녹취 생성 후 detail 열기:

```
viewport: 390
panelWidth: 390
surfaceWidth: 344       (좌우 23px 패딩)
audioRectWidth: 318     (audio 컨트롤이 surface 안에 들어감)
audioOverflowsPanel: false
horizontalScrollDoc: false
```

audio 네이티브 컨트롤이 viewport / panel / surface 모두 안에 들어감. 가로 스크롤 발생 없음.

### 5.5 Console Errors

`browser_console_messages level=error` → 0건. warning 1건은 `cdn.tailwindcss.com` 사용 경고 (Step 4 scope 외).

### 5.6 Fixture 정리

`server/test/_cleanup.mjs` 임시 스크립트로 `title LIKE 'phase8-step4-smoke/%'` 4개 call hard delete. 스크립트도 삭제. seed/demo row 미영향.

---

## 6. Validation Commands

```powershell
npm --prefix server run typecheck     # PASS (Step 4는 frontend-only지만 변경 영향 확인)
node test/sync_shared_types.mjs       # PASS (변경 없음)
git diff --check                      # PASS
```

`npm --prefix server test`는 Step 3 closeout 시점 (804+27 = 831, 828 pass) 그대로. Step 4는 server 코드를 건드리지 않았으므로 재실행해도 동일 결과 예상 (별도 실행 불필요).

---

## 7. Not Implemented (계획대로)

- backend route/schema 변경
- DB migration
- shared type schema 변경
- retention worker recording 통합 (Phase 8 Step 5)
- waveform rendering
- audio transcoding queue
- transcript/audio timestamp alignment
- browser microphone capture / desktop recorder upload flow
- public object URL
- CSV export wiring (페이지 footer demo 버튼들)
- manual upload UI (browser-side recorder 필요)

---

## 8. Decisions

### 8.1 단일 primary recording 표시

`choosePrimaryRecording(items)`: `status='available'` 우선, 없으면 첫 row (server가 created_at DESC 정렬). 다중 recording picker는 product 수요가 명확해질 때 도입.

### 8.2 audio.preload="none"

페이지 로드 시 자동 byte 다운로드를 막아 signed URL 발급 직후 implicit 트래픽이 발생하지 않게 한다. 사용자가 재생 버튼을 누른 시점에만 fetch.

### 8.3 epoch-based race guard

비동기 playback URL 요청 중 detail switch 발생 가능. `recordingPlaybackEpoch`로 응답 도착 시 일치 검사 → stale 응답을 drop. timer callback도 같은 검사.

### 8.4 delete 후 reconcile 패턴

Step 3 backend가 두 단계 delete (delete_pending → 객체 삭제 → deleted)를 하지만, frontend는 backend 204를 받으면 `renderRecordingSurface('deleted')`로 즉시 표시한 뒤 `loadRecordingsForCurrentCall()`로 서버 truth로 reconcile. 사용자 체감 latency 최소화 + 최종 정합성 보장.

### 8.5 viewer hide via `/me` 캐시

backend가 backend authority이므로 hide는 UX 편의용. 403 surface도 항상 처리해 stale `/me`가 보안 문제로 이어지지 않게 함.

### 8.6 `audio.src` DOM property assignment

signed URL이 visible text나 page-authored `innerHTML` template에 들어가지 않도록 강제. `innerHTML` template에는 src 자리가 비어 있고, 후속 코드가 property로만 binding한다. 단, 브라우저는 media `src` property를 element attribute로 반영할 수 있으므로 DOM inspector/outerHTML에서 media `src`가 보일 수 있다. 이 동작은 native audio playback의 브라우저 반영이며, Step 4의 보안 경계는 URL을 사용자-visible text, console, template string에 노출하지 않는 것이다.

---

## 9. Risks / Follow-ups

- **현재 viewer 사용자 시드 없음**: 시드에 viewer 역할이 없어 viewer hide 동작은 browser-level에서 검증 못함 (delete 버튼 표시/숨김 단위 테스트는 admin/employee만). Codex가 viewer fixture를 추가하면 retrofit 가능.
- **manual upload UI 부재**: 현재 사용자가 새 녹취를 만들 방법이 frontend에 없다. desktop/browser recorder pipeline이 들어와야 의미 있는 흐름이 닫힌다. Step 4 plan에서 명시적으로 미포함.
- **multi-recording picker 부재**: 한 call이 여러 recording을 가질 때 (failed retry 등) 사용자는 primary만 본다. 운영 중 multi-recording 사례가 잦아지면 picker 추가 필요.
- **audio error retry는 one-shot**: 한 번 재시도 후 실패 시 사용자가 새로고침 버튼을 직접 누르거나 detail close→open 해야 함. 자동 무한 retry는 의도적으로 안 함.
- **playback URL audit noise**: 재생 시점이 아니라 URL 발급 시점에 audit가 남는다. 사용자가 새로고침을 자주 누르면 audit가 많아질 수 있음. Step 3 §12에서 sampling 정책 고려 항목으로 기록됨.

---

## 10. Next Step

Phase 8 Step 5 — retention worker integration.

- Phase 7 Step 4 retention worker에 `call_recordings` 90일 정책 추가
- `listRetentionCandidatesInCurrentOrg(cutoff, limit)` 사용해 후보 선택
- adapter.deleteObject 성공 후 markDeleted 또는 hardDelete 결정 (plan에서 확정)
- aggregate audit event 추가 (count / cutoff / provider / batch_size 정도. object key / recording id list는 audit payload에 넣지 않는다)
- `KLOSER_RETENTION_ENABLED` gate 재사용
- `delete_pending` 상태로 막힌 row 재시도 (Step 4 frontend의 502 시나리오를 backend가 일괄 처리)
