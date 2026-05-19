# Phase 8 Step 4 Plan - Frontend Playback UI

작성일: 2026-05-19

상위 문서:

- `docs/plan/phase-8/PHASE_8_MASTER.md`
- `docs/plan/phase-8/PHASE_8_STEP_3_FINDINGS.md`

선행 조건:

- Step 1 `call_recordings` metadata schema 완료.
- Step 2 repository + recording storage adapter boundary 완료.
- Step 3 upload/finalize/list/playback/delete backend routes, shared types, audit hooks 완료.
- `platform/types/callRecording.js` JSDoc mirror 존재.
- `platform/calls.html`은 이미 `/calls`, `/calls/:id`, transcript, action items, suggestions를 API-backed로 렌더한다.

주의:

- Step 4는 **frontend playback UI만** 닫는다.
- 서버 route/schema/storage/audit 계약은 Step 3에서 잠겼다. Step 4 구현 중 backend route shape를 바꾸지 않는다.
- retention worker integration은 Step 5다.
- browser/desktop live audio capture pipeline은 Step 4 범위가 아니다.

---

## 0. 목표

Step 4의 목표는 `platform/calls.html` detail panel에서 API-backed call recording surface를 제공하는 것이다.

완료 후 사용자는 call detail을 열었을 때 다음을 볼 수 있어야 한다.

1. 해당 call의 recording 상태.
2. recording이 available이면 backend authorization을 거친 signed playback URL 기반 audio player.
3. signed URL 만료 전/후 재발급 흐름.
4. failed / processing / deleted / no recording 상태별 명확한 UI.
5. 권한이 없는 mutation action은 backend 결과를 기준으로 실패 표시.

---

## 1. 범위

### 한다

1. `platform/api.js`에 Step 3 recording endpoint helper 추가.
2. `platform/calls.html` detail panel에 recording section 추가.
3. call detail open 시 recordings list를 기존 call/transcript/action/suggestion fetch와 함께 로드.
4. recording status 6-state 렌더:
   - loading
   - none
   - processing
   - available
   - failed
   - deleted
5. available 상태에서 signed playback URL을 요청하고 `<audio controls>`에 연결.
6. signed URL 만료 시 재발급하는 client-side state 추가.
7. delete action이 필요하면 Step 3 DELETE route를 호출하고 detail을 server에서 다시 로드.
8. XSS gate 준수: server-returned recording fields는 `textContent` 또는 `escapeHtml`만 사용.
9. browser smoke / Playwright 검증 계획 수립 및 수행.
10. Step 4 findings 작성 및 `PHASE_8_MASTER.md` 갱신은 구현 검증 후 별도 closeout에서 수행.

### 하지 않는다

- backend route 추가/수정.
- DB migration.
- shared type schema 변경.
- retention worker recording 삭제 통합.
- waveform rendering.
- audio transcoding queue.
- transcript/audio timestamp alignment.
- browser microphone capture 또는 desktop recorder upload flow.
- public object URL 노출.

---

## 2. Existing Frontend Context

### 2.1 `platform/calls.html`

현재 상태:

- `(API)` call list: `window.kloserApi.listCalls(query)`
- `(API)` call detail: `window.kloserApi.getCall(callId)`
- `(API)` transcript: `window.kloserApi.listTranscript(callId)`
- `(API)` action items: `window.kloserApi.listActionItems(callId)`
- `(API)` suggestions: `window.kloserApi.listCallSuggestions(callId)`
- `(API)` manual summary mutation: `window.kloserApi.patchCallManualSummary(...)`
- `(API)` action item create/status/delete mutations
- `(demo)` CSV export button remains placeholder.
- `(demo)` footer memo/email buttons are still placeholder-style controls and are not Step 4 scope.

Detail panel currently fetches call/transcript/action/suggestion in parallel:

```js
[callRes, trRes, aiRes, sgRes] = await Promise.all([
  window.kloserApi.getCall(callId),
  window.kloserApi.listTranscript(callId),
  window.kloserApi.listActionItems(callId),
  window.kloserApi.listCallSuggestions(callId),
]);
```

Step 4 should add `recRes` to this batch rather than creating a second serial waterfall.

### 2.2 `platform/api.js`

Current helper convention:

- Thin wrappers around `apiGet`, `apiPost`, `apiDelete`.
- Return raw `Response`.
- Callers inspect `res.ok`, `res.status`, and decode `res.json()` only when needed.
- Auth refresh and login redirect are handled by `authFetch`.

Recording helpers should follow the same pattern.

### 2.3 XSS Gate

`calls.html` already defines:

```js
function escapeHtml(str) { ... }
```

Rules for Step 4:

- `recording.status`, `codec`, `error_message`, timestamps, and any server-returned text must use `textContent` or `escapeHtml`.
- Do not interpolate signed URL into `innerHTML`.
- Set audio `src` through DOM property assignment: `audio.src = playback.url`.
- Do not log signed URL, object key, bucket, or playback response body.

---

## 3. API Helpers

Add to `platform/api.js`:

```js
function listCallRecordings(callId) {
  return apiGet('/calls/' + encodeURIComponent(callId) + '/recordings');
}

function getCallRecordingPlaybackUrl(callId, recordingId) {
  return apiGet(
    '/calls/' + encodeURIComponent(callId) +
    '/recordings/' + encodeURIComponent(recordingId) +
    '/playback-url',
  );
}

function deleteCallRecording(callId, recordingId) {
  return apiDelete(
    '/calls/' + encodeURIComponent(callId) +
    '/recordings/' + encodeURIComponent(recordingId),
  );
}
```

Optional, only if manual upload smoke is deliberately included:

```js
function initiateCallRecordingUpload(callId, input) { ... }
function finalizeCallRecordingUpload(callId, recordingId, input) { ... }
```

Recommendation:

- Step 4 playback UI should start with list/playback/delete only.
- Upload/finalize UI should stay out unless a concrete browser-side recording/upload flow is specified. Step 3 has the backend endpoints, but Step 4's product value is playback/read surface.

Export the helpers on `window.kloserApi`.

---

## 4. UI Placement

Add a new section in the call detail scroll area near the top, after the call summary cards and before manual summary editing.

Reason:

- Playback is call context, not transcript detail.
- It should be visible before lower-priority editing controls.
- It avoids crowding the footer actions.

Suggested structure:

```html
<section id="dRecordingSection">
  <div class="...">녹음</div>
  <div id="dRecordingSurface"></div>
</section>
```

Keep it visually consistent with existing compact SaaS panel styling:

- 8px radius or existing `.rounded-lg`.
- restrained borders and dense spacing.
- no hero, no marketing copy, no decorative card nesting beyond existing local section pattern.

Do not add visible explanatory help text about implementation details, TTLs, APIs, or keyboard shortcuts.

---

## 5. State Model

Add module-level state in `calls.html`:

```js
let currentCallId = null;
let currentRecording = null;
let recordingPlayback = null;
let recordingUrlRefreshTimer = null;
```

Clear playback state on:

- `openDetail(callId)` before fetch.
- `closeDetail()`.
- opening a different call.
- delete success.

When clearing:

- pause the audio element if it exists.
- remove `audio.src`.
- clear any refresh timer.

### 5.1 Status Mapping

Step 3 backend statuses:

- `upload_pending`
- `uploaded`
- `processing`
- `available`
- `delete_pending`
- `deleted`
- `failed`

Step 4 UI states:

| Backend / event | UI state | Notes |
|---|---|---|
| request in flight | loading | Initial detail open or refresh. |
| list 200 with empty `items` | none | No recording exists for this call. |
| `upload_pending`, `uploaded`, `processing` | processing | Not playable yet. |
| `available` | available | Request signed playback URL and render audio. |
| `failed` | failed | Show sanitized failure state. |
| `delete_pending` | deleted | User-facing "삭제 중/삭제됨" bucket; no playback. |
| local DELETE success | deleted | Transient until reload list hides row. |
| list 404 with call visible race | none or deleted | Prefer none if parent call is still visible. |

Important:

- Step 3 user-facing list hides rows with `deleted_at IS NOT NULL`, so a persisted `deleted` row usually will not appear in `GET /calls/:id/recordings`.
- The `deleted` UI state is still needed for local delete success, `delete_pending`, and future backend behavior.

### 5.2 Recording Selection

If list returns multiple recordings:

- v1 should select the newest `available` recording.
- If none available, select the newest item.
- Do not build a multi-recording picker in Step 4 unless real product need appears.

Selection algorithm:

```js
function choosePrimaryRecording(items) {
  const available = items.find((r) => r.status === 'available');
  return available || items[0] || null;
}
```

The backend already orders newest first.

---

## 6. Rendering Contract

Implement a single renderer:

```js
function renderRecordingSurface(state, data) { ... }
```

Inputs:

- `state`: `"loading" | "none" | "processing" | "available" | "failed" | "deleted"`
- `data.recording`
- `data.playback`
- `data.errorLabel`

### 6.1 Loading

Use skeleton-like compact row:

- status badge: 로딩
- disabled audio/player area

No network details.

### 6.2 None

Display:

- "녹음 없음" style status.
- no player.
- no upload button unless upload flow is explicitly scoped later.

### 6.3 Processing

Display:

- backend status mapped to user-facing label:
  - `upload_pending`: 업로드 대기
  - `uploaded`: 처리 대기
  - `processing`: 처리 중
- no player.
- optional refresh button calling `loadRecordingsForCurrentCall()`.

### 6.4 Available

Display:

- `<audio id="dRecordingAudio" controls preload="none">`
- duration/size/codec metadata if present.
- refresh URL button if playback-url request fails or expires.
- optional delete button for writer roles, but rely on backend response for actual permission.

Do not expose:

- signed URL text.
- object key.
- bucket/provider.

### 6.5 Failed

Display:

- failure label.
- `error_message` only through `textContent` or `escapeHtml`.
- no player.

If `error_message` is empty, use a generic message.

### 6.6 Deleted

Display:

- deleted/deleting label.
- no player.
- after delete success, call `loadRecordingsForCurrentCall()` or `openDetail(currentCallId)` to reconcile with server.

---

## 7. Playback URL Lifecycle

### 7.1 Initial URL Fetch

When selected recording is `available`:

1. Render available shell with loading player state.
2. Call `getCallRecordingPlaybackUrl(callId, recording.id)`.
3. If 200:
   - parse `{ playback }`
   - set `audio.src = playback.url`
   - store `recordingPlayback = playback`
   - schedule refresh before `expires_at`
4. If 409:
   - recording changed state; reload list.
5. If 404:
   - recording disappeared; reload list.
6. If 403:
   - show permission error.
7. Other errors:
   - show playback unavailable with retry button.

### 7.2 Refresh Scheduling

Schedule refresh at:

```js
Math.max(15_000, Date.parse(expires_at) - Date.now() - 30_000)
```

Policy:

- Refresh 30 seconds before expiry.
- If expiry is too close, refresh after 15 seconds to avoid immediate loops.
- Clear old timer before setting a new one.
- If the current call/recording changed before timer fires, do nothing.

### 7.3 Audio Error Handling

Attach `audio.onerror`:

- clear current URL.
- request a fresh playback URL once.
- if retry fails, show "재생 링크를 새로 받을 수 없습니다" state.

Do not console-log `audio.src`.

---

## 8. Permissions / Actions

Backend is the authority.

Frontend may hide mutation controls as a convenience only if current user role is known, but must not depend on that hiding for security.

Current `calls.html` boot fetches `/me` for unverified banner but does not store role for page logic. Step 4 options:

1. Keep delete action visible for authenticated users and render backend 403 as "권한 없음".
2. Store `/me` result in `currentUser` and hide delete for `viewer`.

Recommendation:

- Use option 2 for cleaner UX, while still handling backend 403.
- Do not add complex manager/employee ownership prediction in frontend. The backend already enforces `assertCanMutateCall`.

```js
let currentUser = null; // from /me
```

Delete button:

- show for roles `admin`, `manager`, `employee`.
- hide for `viewer`.
- on 204: render deleted state, then reload detail/list.
- on 403: show permission error.
- on 404: treat as gone and reload.
- on 502: show storage failure and keep UI reloadable.

---

## 9. Data Labels

Status reports and code comments should keep demo/API boundary explicit.

Step 4 touched user-facing recording fields:

- recording status: `(API)`
- recording duration/size/codec/error: `(API)`
- playback URL: `(API, signed, not displayed)`
- delete result: `(API)`
- call title/customer/duration already shown in page: `(API)`
- CSV export button remains `(demo)`
- footer memo/email buttons remain `(demo)`

The demo -> real boundary should shrink only for the recording surface in this step. Do not opportunistically wire CSV, memo, or email.

---

## 10. Implementation Order

### 10.1 API Helpers

Files:

- `platform/api.js`

Changes:

- add list/playback/delete recording helpers.
- export on `window.kloserApi`.

Validation:

- no syntax errors.
- helpers use `encodeURIComponent`.
- helpers return raw `Response`.

### 10.2 Detail Panel Markup

Files:

- `platform/calls.html`

Changes:

- add `dRecordingSurface` section.
- add any minimal CSS only if Tailwind utility classes are insufficient.
- no external libraries.
- no waveform/canvas.

### 10.3 Detail Fetch Integration

Changes:

- add recordings request to `openDetail`.
- reset recording UI before fetch.
- handle 200/404/non-OK without breaking call detail rendering.
- choose primary recording.
- render state.

### 10.4 Playback URL Integration

Changes:

- request playback URL only for `available`.
- assign audio src through DOM property.
- schedule refresh.
- clear timers on detail close/change.

### 10.5 Delete Action

Changes:

- add optional delete button.
- call `deleteCallRecording`.
- reconcile with server after success.

### 10.6 Findings / Master

After implementation and verification:

- create `docs/plan/phase-8/PHASE_8_STEP_4_FINDINGS.md`
- update `docs/plan/phase-8/PHASE_8_MASTER.md`

Do not check Step 4 in master before browser verification passes.

---

## 11. Browser Verification Plan

Required manual/browser checks:

1. Login/refresh gate still works on `platform/calls.html`.
2. Calls list loads.
3. Opening a call still loads summary, manual summary form, action items, suggestions, transcript.
4. Recording section shows loading then none when no recording exists.
5. Recording section shows available + audio player for a seeded/test-created available recording.
6. Playback URL is requested only after detail open and only for available recording.
7. Signed URL string is not rendered as visible text.
8. Closing detail clears audio src and timers.
9. Opening another call does not keep previous playback URL/audio source.
10. Delete success transitions to deleted/none after reload.
11. 403 from delete shows permission error without removing the row optimistically.
12. Mobile detail panel width still fits; audio controls do not overflow.

Recommended Playwright checks:

- desktop viewport: `1440x900`
- mobile viewport: `390x844`
- screenshot or DOM assertions for:
  - no recording state
  - available state
  - failed/processing state if fixtures are practical
- console has no runtime errors.

If no seeded recording exists:

- Create test recording via backend API or DB setup for browser smoke.
- Do not add permanent seed/demo recordings unless the implementation plan explicitly chooses that.

---

## 12. Validation Commands

Frontend is static, so no bundler/build command exists.

Run before closeout:

```powershell
npm --prefix server run typecheck
node test/sync_shared_types.mjs
npm --prefix server test
git diff --check
```

Browser smoke:

```powershell
docker compose -f ops/docker-compose.yml up -d
cd server
npm run dev
```

In another terminal from repo root:

```powershell
python -m http.server 8765
```

Open:

```text
http://localhost:8765/platform/calls.html
```

Use Playwright for final screenshot/console verification if the local backend and static server are running.

---

## 13. Security Checklist

- [ ] no backend route/schema changes.
- [ ] recording API helpers encode every path parameter.
- [ ] signed playback URL is assigned via `audio.src`, never inserted via `innerHTML`.
- [ ] signed playback URL is not displayed.
- [ ] signed playback URL is not logged.
- [ ] object key, bucket, storage provider, object version, checksum are not expected or rendered.
- [ ] `error_message` uses `textContent` or `escapeHtml`.
- [ ] every new `innerHTML` interpolation is classified and escaped.
- [ ] delete action treats backend 403 as authority.
- [ ] cross-org/missing 404 collapses to not found/gone UI without probing.
- [ ] audio src and refresh timers are cleared on close/detail switch.

---

## 14. Completion Checklist

- [ ] `platform/api.js` exposes recording list/playback/delete helpers.
- [ ] `platform/calls.html` renders recording section.
- [ ] loading / none / processing / available / failed / deleted states render.
- [ ] available state fetches signed playback URL.
- [ ] signed URL auto-refresh is implemented.
- [ ] audio error path attempts one refresh.
- [ ] delete action reconciles with server.
- [ ] viewer/writer UX handles backend permission results.
- [ ] no unsafe server-value `innerHTML`.
- [ ] desktop and mobile browser smoke pass.
- [ ] console has no new runtime errors.
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] `npm --prefix server test` PASS before closeout.
- [ ] `git diff --check` PASS.
- [ ] `PHASE_8_STEP_4_FINDINGS.md` written.
- [ ] `PHASE_8_MASTER.md` Step 4 checked only after verification.

---

## 15. Codex Review Focus

1. Step 4 must stay frontend-only except documentation.
2. Existing `calls.html` API-backed detail behavior must not regress.
3. Recording section must not expose signed URL, object key, bucket, provider, checksum, or metadata.
4. New `innerHTML` must not include unescaped server fields.
5. Audio URL lifecycle must clear timers and stale `src` on detail switch.
6. Delete must not optimistically remove UI without handling backend failure.
7. Mobile panel must not overflow horizontally with native audio controls.
8. `/me` role use is UX only; backend remains authority.

---

## 16. One-Line Handoff

Implement Step 4 by adding recording API helpers and a compact recording playback section to `platform/calls.html`, using Step 3 list/playback/delete routes, safe DOM rendering, signed URL refresh, and browser smoke verification, without changing backend contracts.
