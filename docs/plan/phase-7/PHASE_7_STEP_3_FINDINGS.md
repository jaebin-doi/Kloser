# Phase 7 Step 3 Findings — activity_log / audit trail

작성일: 2026-05-18

상위 문서: `PHASE_7_MASTER.md` · 상세 계획: `PHASE_7_STEP_3_PLAN.md`.

---

## 1. Step 3 산출물 (현재 commit 묶음 기준)

선행 commit(이 closeout 직전) 시점에 이미 들어와 있던 것:

| 영역 | 위치 |
|---|---|
| 스키마 hardening | `server/migrations/1715000024000_phase7_activity_log_hardening.sql` (action / target_type CHECK, payload object CHECK, 3종 partial composite index) |
| 서비스 풀 INSERT grant | `server/migrations/1715000025000_phase7_activity_log_service_insert_grant.sql` |
| repository | `server/src/repositories/activityLog.ts` (`insertActivity` / `insertActivityVoid` / `listForCurrentOrg` / `countForCurrentOrg`, ms-truncated cursor 페이지네이션) |
| service | `server/src/services/activityLog.ts` (`recordActivity` / `recordActivityVoid` / `tryRecordActivity` + 자체 payload sanitizer + `ActivityPayloadSanitizeError`) |
| audit hook 묶음 | `services/auth.ts` · `services/organizationSecurity.ts` · `services/team.ts` · `services/memberships.ts` · `services/invitations.ts` · `services/customers.ts` · `services/customerLinkage.ts` · `services/calls.ts` · `services/callActionItems.ts` · `services/callSummary.ts` · `services/knowledge.ts` · `routes/checklistTemplates.ts` · `routes/knowledgeBases.ts` · `services/teamReports.ts` (best-effort `report.team_viewed`) |
| hook 테스트 | `server/test/phase7_step3_security_audit_hooks.test.mjs` · `..._service_pool_audit_hooks.test.mjs` · `..._team_invitation_audit_hooks.test.mjs` · `..._customer_call_audit_hooks.test.mjs` · `..._knowledge_checklist_audit_hooks.test.mjs` · `..._report_audit_hooks.test.mjs` · `..._activity_log_repo.test.mjs` · `..._activity_log_service.test.mjs` |

이 closeout commit 묶음에서 새로 추가된 것:

| 영역 | 위치 |
|---|---|
| 공유 타입 source | `server/src/types/activityLog.ts` (`ActivityLog`, `ActivityLogListQuery`, `ActivityLogCursor`, `ActivityLogListResponse`) |
| 공유 타입 browser mirror | `platform/types/activityLog.js` (동명 JSDoc 4종) |
| 공유 타입 registry | `test/sync_shared_types.mjs` — `activityLog` entry 추가 (4 types) |
| route | `server/src/routes/activityLog.ts` — `GET /activity-log` admin-only |
| route 등록 | `server/src/server.ts` — `activityLogRoutes` import + `app.register(activityLogRoutes)` |
| route 테스트 | `server/test/phase7_step3_activity_log_routes.test.mjs` — 14개 시나리오 |
| 프론트엔드 | `platform/settings.html` — `#security` 섹션 내 `#audit-log-block` (관리자 한정) + `wireSecuritySection` 내 audit log 로딩/필터/페이지네이션 JS |

---

## 2. Route 계약

### 2.1 Surface

```
GET /activity-log
  ?limit            (optional, default 20, max 100)
  &beforeCreatedAt  (optional, ISO timestamp — pair with beforeId)
  &beforeId         (optional, uuid — pair with beforeCreatedAt)
  &action           (optional, must be in ACTIVITY_ACTIONS allow-list)
  &targetType       (optional, must be in ACTIVITY_TARGET_TYPES allow-list)
  &targetId         (optional, uuid)
  &userId           (optional, uuid)
  &createdFrom      (optional, ISO timestamp)
  &createdTo        (optional, ISO timestamp)
→ 200 { items: ActivityLog[], nextCursor: { beforeCreatedAt, beforeId } | null }
```

### 2.2 Authorization

preHandler: `requireAuth → orgContext → requireRole("admin") → requireFreshRole`.

| 호출자 | 응답 |
|---|---|
| admin (JWT + DB role 일치) | 200 |
| employee / manager / viewer | 403 forbidden |
| 인증 없음 | 401 |
| admin JWT이지만 DB role이 변경됨 | 401 stale_role |
| admin이지만 다른 조직 user_id / target_id 필터 | 200 + 빈 페이지 (존재 여부 비노출) |

### 2.3 Validation

- `limit > 100` → 400 invalid_input
- `limit=foo` (정수 변환 실패) → 400 invalid_input
- `targetId / beforeId / userId`가 UUID 아님 → 400 invalid_input
- `action / targetType`이 allow-list 밖 → 400 invalid_input
- 날짜 필터가 파싱 불가 → 400 invalid_input

### 2.4 Pagination

- Cursor는 `(beforeCreatedAt, beforeId)` 쌍.
- 한 번에 `limit + 1` 행을 요청해 다음 페이지 유무를 판별. 단 route max인 `limit=100`은 repository cap 때문에 마지막 visible row 이후 1-row probe로 `nextCursor` 유무를 확인한다.
- 마지막 페이지에서는 `nextCursor: null`.
- 두 cursor 필드 중 하나만 보내면 repo가 cursor 없음으로 간주 (`repositories/activityLog.ts` 참고).

---

## 3. 공유 타입

`server/src/types/activityLog.ts`:

| 타입 | 용도 |
|---|---|
| `ActivityLog` | 한 row의 wire 형식. `created_at`은 ISO 문자열, `payload`는 `z.record(z.string(), z.unknown())`. |
| `ActivityLogListQuery` | 쿼리 파라미터 mirror. cursor·필터·날짜 필드 모두 optional. |
| `ActivityLogCursor` | `nextCursor` 객체 — 다음 페이지를 호출할 때 그대로 다시 보낸다. |
| `ActivityLogListResponse` | `{ items, nextCursor }`. `nextCursor`는 `ActivityLogCursor.nullable()`로 참조. |

`platform/types/activityLog.js`는 같은 4개 typedef를 JSDoc으로 미러링. `test/sync_shared_types.mjs`의 `activityLog` entry가 field-name 동등성을 검증한다.

---

## 4. 프론트엔드 패널

`platform/settings.html`의 `#security` 섹션 안에 `#audit-log-block`을 신설했다. 처음에는 `hidden` 상태로 시작하고, `loadMe()` 결과 role이 `admin`일 때만 노출된다.

기능:

- **액션 필터** — `ACTIVITY_ACTIONS` 전체 + "전체 액션" 옵션. 변경 시 즉시 reload.
- **새로고침** — 현재 필터 그대로 첫 페이지부터 다시 로드.
- **더 보기** — `nextCursor`가 있을 때만 보임. 누르면 다음 페이지를 같은 리스트에 append.
- **에러/빈 상태** — 5xx/4xx는 상단 에러 메시지, 0건은 "표시할 감사 로그가 없습니다." 안내.
- **403 응답** — 권한 race (예: 이 패널을 띄운 사이에 admin → employee 강등됨)에서는 패널 전체를 다시 숨김.

### XSS gate

이 패널이 그리는 모든 감사 값(action / target_type / target_id / user_id / created_at / payload)은 서버에서 흘러온 데이터다.

- 모든 텍스트는 `textContent`로만 할당.
- `user_id`와 `target_id`는 앞 8자만 잘라 노출 (uuid 전체를 URL처럼 보이지 않게).
- `payload`는 `JSON.stringify(payload)` 결과를 400자에서 잘라 `<pre>.textContent`에 박는다. HTML이 섞여 있어도 그대로 글자처럼만 표시된다.
- `innerHTML` / `insertAdjacentHTML` / template literal → `.innerHTML` 경로는 이 패널 안에서 한 번도 쓰이지 않는다.

---

## 5. 검증 결과

```powershell
npm --prefix server run typecheck      # PASS
node test/sync_shared_types.mjs        # PASS (19 entity, activityLog 4 types 포함)
npx tsx --test --test-concurrency=1 test/phase7_step3_activity_log_routes.test.mjs
                                       # 14/14 PASS
npm --prefix server test               # PASS (683 total / 680 pass / 3 skipped / 0 fail)
```

Codex review 중 `limit=100` max-page에서 101번째 row가 있어도 `nextCursor`가 null이 될 수 있는 edge를 발견해 route probe + 테스트를 추가했다.

### 알려진 flaky

Codex가 전체 `npm --prefix server test`를 돌렸을 때 `phase7_email_outbox_repo.test.mjs`의 due-lease 관련 2개 테스트가 실패한 적이 있다. 동일 파일을 단독 실행하면 PASS. 이번 작업 범위와 직접적인 충돌 없음 — Step 3 audit hook도 이 outbox 테스트 흐름과 겹치지 않는다. **관찰만 남기고 수정하지 않음.** Step 4 (retention) 작업 시 outbox/큐 워커 인접 영역 재현 여부를 다시 확인할 것.

---

## 6. 다음 작업 (Step 4 인계)

- transcript 3년 / call_recording 90일 retention enforce cron.
- 삭제 이벤트를 `activity_log`에 함께 남긴다 — Step 3에서 마련된 `recordActivity` helper를 그대로 쓰면 된다. Action allow-list에는 retention용 항목이 아직 없으므로, Step 4 schema migration에서 CHECK + repository union + route enum을 모두 추가해야 한다.
- worker가 `app.withOrgContext`로 조직별 순회 + best-effort `tryRecordActivity`로 audit row를 남기는 것이 안전한 패턴이다.

---

## 7. Phase 7 Go / No-Go 갱신

`PHASE_7_MASTER.md §6` 기준으로 Step 3 완료에 따라 다음 항목이 `[x]`로 갱신됐다:

- audit target events가 org-scoped row로 기록됨 — 보안/멤버십/초대/고객/통화/지식/보고서 hook + 관리자용 `GET /activity-log`로 닫힘.

남은 게이트: retention worker, Phase 7 closeout e2e, Step 2 closeout findings 작성.
