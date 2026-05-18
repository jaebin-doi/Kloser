# Phase 7 — Operational launch gates master plan

> 작성일: 2026-05-14
> 선행 단계: Phase 6 closeout — `docs/plan/phase-6/PHASE_6_STEP_5_FINDINGS.md`.
> 인계 문서: `docs/plan/phase-6/PHASE_7_HANDOFF.md`.
> 워크플로: `AGENTS.md` Phase Workflow를 따른다. Schema 변경이 있는 step은 schema -> repo + test -> route/types + test -> frontend -> e2e 순서로 닫는다.

---

## 0. 진행 상태

- [x] **Step 1 — SMTP / Resend 실 email adapter**: 구현 완료. 정본 결과는 `PHASE_7_STEP_1_FINDINGS.md`, 상세 계획은 `PHASE_7_STEP_1_PLAN.md`.
- [x] **Step 2 — MFA / 세션 강화**: TOTP 우선 도입 완료 (login challenge / 인증된 enroll·disable / 조직 MFA 강제). WebAuthn은 후속.
- [x] **Step 3 — activity_log + 감사 로그**: schema hardening · repository · service helper · 보안/멤버십/초대/고객/통화/지식/보고서 audit hook · 관리자용 `GET /activity-log` route + 공유 타입 + `settings.html` 관리자 패널. 정본 결과는 `PHASE_7_STEP_3_FINDINGS.md`, 상세 계획은 `PHASE_7_STEP_3_PLAN.md`.
- [x] **Step 4 — retention enforce cron**: transcript 3년 hard delete + email_outbox stuck-sending recovery + aggregate audit + BullMQ singleton repeatable worker (`KLOSER_RETENTION_ENABLED` gate). call_recordings은 schema 부재로 not applicable (Phase 8 recording surface 도입 시 같은 worker에 추가). 정본 결과는 `PHASE_7_STEP_4_FINDINGS.md`, 상세 계획은 `PHASE_7_STEP_4_PLAN.md`.
- [ ] **Step 5+ — P1 운영 UX / 비용 / 상업화**: cost map, sidebar role visibility, report drilldown, demo-to-real cleanup, billing.

---

## 1. Phase 7 목표

Phase 6은 core runtime loop를 닫았다: BullMQ workers, provider adapters, `llm_usage_log`, action item delete, manager reports.

Phase 7은 외부 사용자에게 운영 출시하기 전 필요한 게이트를 닫는다.

- 메일이 실제 수신자에게 도착해야 한다.
- 로그인/세션 보안이 비밀번호 단일 요소에 머물면 안 된다.
- 운영자가 감사 로그와 보존 정책을 설명할 수 있어야 한다.
- 운영 비용과 관리자 UX의 남은 빈틈을 Phase 7 중반에 정리한다.

이번 Phase에서 "새 제품 영역"을 넓히지 않는다. Daily/newsletter의 큰 API 전환, 녹취 저장, SSO, 다국어는 P1/P2 이후로 분리한다.

---

## 2. 우선순위

| Priority | Work | Why |
|---|---|---|
| P0 | SMTP / Resend 실 adapter | verify/reset/invite가 실제 메일로 도착하지 않으면 운영 가입 흐름이 성립하지 않는다. |
| P0 | MFA / session hardening | admin 계정 탈취가 곧 조직 데이터 노출이다. |
| P0 | activity_log audit | 권한 변경, 삭제, 보고서 조회 같은 운영 행위의 설명 가능성이 필요하다. |
| P0 | retention enforce cron | 문서상 보존 정책만 있고 강제 코드가 없으면 개인정보 정책으로 주장할 수 없다. |
| P1 | `llm_usage_log` price map | Phase 6 residual. provider 사용량을 비용으로 환산해야 운영비를 추정할 수 있다. |
| P1 | role-based sidebar nav | backend 403은 맞지만 employee/viewer에게 admin 메뉴가 보이는 UX는 마무리해야 한다. |
| P1 | report date window / agent drilldown | manager report가 전체 기간만 보는 상태라 운영 분석에 부족하다. |
| P1 | demo-to-real frontend cleanup | dashboard/newsletter/daily의 demo 경계를 더 줄인다. |
| P1 | billing / subscription caps | 실제 유료 전환 직전 게이트. P0 보안/운영 위생 뒤에 둔다. |
| P2 | call recordings + S3/MinIO | 기능 확장. retention과 storage 정책이 먼저 필요하다. |
| P2 | enterprise SSO / audit dependency cleanup | Enterprise 준비와 의존성 위생. |
| P3 | locale/timezone | 해외 시장 진입 시점에 묶는다. |

---

## 3. Step Breakdown

### Step 1 — SMTP / Resend 실 email adapter

**목표**: Phase 3의 dev `email_outbox` 전용 흐름을 운영 발송 가능한 구조로 바꾼다. dev/e2e는 기존 outbox token extraction을 유지한다.

**Schema 변경 예상**: 있음. `email_outbox`에 delivery status, provider, retry/dead-letter, provider message id, encrypted sensitive payload, scrub metadata를 추가한다.

**완료 기준**:
- `EMAIL_PROVIDER=dev_outbox` 기본값은 기존 e2e와 호환.
- `EMAIL_PROVIDER=resend` 선택 시 verify/reset/invite가 Resend adapter를 통해 발송된다.
- 실 provider 선택인데 필수 env가 없으면 fail-fast.
- request transaction 안에서 외부 HTTP를 호출하지 않는다. worker가 pending outbox를 lease해서 보낸다.
- raw token은 운영 archive에 평문으로 남기지 않는다.

### Step 2 — MFA / session hardening

**목표**: TOTP MFA를 먼저 도입하고, admin 조직 설정으로 MFA required를 강제할 수 있게 한다.

**Schema 변경 예상**: `users.mfa_secret_encrypted`, MFA challenge token purpose, org setting.

**완료 기준**:
- MFA 등록/확인/해제 flow가 route test로 검증된다.
- MFA required org에서 password-only login은 access token을 발급하지 않는다.
- 실패/락아웃 이벤트는 Step 3 audit에 기록한다. Step 3이 늦으면 findings에 temporary gap을 명시한다.

### Step 3 — activity_log + audit

**목표**: 이미 존재하는 `activity_log`를 실제 운영 이벤트로 채운다.

**Schema 변경 예상**: 기존 schema로 충분한지 먼저 확인. 필요 시 action enum/check, indexes, retention columns를 forward migration으로 추가한다.

**완료 기준**:
- 로그인, 로그아웃, password reset, invite, membership role/status change, action item delete, report view, MFA change가 audit row를 남긴다.
- cross-org 조회는 RLS상 404/empty로 유지한다.
- admin 전용 조회 endpoint는 pagination과 date filter를 가진다.

### Step 4 — retention enforce cron

**목표**: 보존 정책을 워커 cron으로 강제한다.

**전제**: Step 3 audit이 먼저 있어야 삭제 이벤트를 남길 수 있다.

**완료 기준**:
- transcripts 3년 초과 row 삭제.
- call_recordings metadata/object 90일 초과 삭제. 실제 object storage가 없으면 metadata 대상만 명시하고 S3/MinIO는 Phase 8로 이관한다.
- dev/test에서는 cron disabled 또는 짧은 cutoff env로만 실행한다.

### Step 5+ — P1 follow-up bundle

P0가 닫힌 뒤 순서를 다시 확정한다. 기본 순서:

1. `llm_usage_log.cost_usd_micros` price map.
2. role-based sidebar nav visibility.
3. reports date window + agent drilldown.
4. demo-to-real frontend cleanup.
5. billing / subscription caps.

---

## 4. Cross-Cutting Rules

- **Raw token policy**: `auth_tokens.token_hash`는 계속 sha256-only다. 운영 outbox/archive에 verify/reset/invite raw token이 평문으로 남으면 안 된다.
- **RLS**: 새 org-scoped table/column behavior는 `app.withOrgContext`와 FORCE RLS 패턴을 유지한다.
- **Workers**: request path에서 외부 provider 호출을 직접 하지 않는다. Redis/BullMQ worker 또는 deterministic outbox lease helper로 분리한다.
- **Provider env**: dev default는 mock/dev provider. 실 provider를 명시했는데 키가 없으면 silently fallback하지 않는다.
- **XSS gate**: frontend에서 server-returned email/audit/report fields를 렌더링하면 `textContent` 또는 `escapeHtml`을 사용한다.
- **Docs**: 구현이 contract를 바꾸면 master/step findings/README를 같은 변경 묶음에서 갱신한다.

---

## 5. Not In Phase 7 Unless Reprioritized

- call recording audio storage + playback.
- Enterprise SSO.
- multilingual transcript and `organizations.timezone`.
- bulk knowledge import.
- large newsletter campaign product surface.
- dependency-only `npm audit` fix unless split into a standalone PR.

---

## 6. Phase 7 Go / No-Go

Phase 7을 닫으려면 최소 다음이 필요하다.

- [x] verify/reset/invite email이 dev outbox와 실 provider mode 양쪽에서 검증됨. Dev path는 Phase 3 e2e로 확인했고, real-provider path는 fake adapter worker tests로 검증됨. Real Resend credentials/domain smoke test는 staging 운영 검증으로 남김.
- [x] MFA required org에서 password-only access issuance가 차단됨 (Step 2 — login challenge gate + refresh MFA required + 인증된 TOTP enroll/disable).
- [x] audit target events가 org-scoped row로 기록됨 (Step 3 — 보안/멤버십/초대/고객/통화/지식/보고서 audit hook + 관리자용 `GET /activity-log`).
- [x] retention worker가 deterministic test cutoff로 검증됨 (Step 4 — `phase7_step4_retention_worker.test.mjs` boundary 테스트가 `now`를 +2일 이동시켜 cutoff 통과/미통과 양쪽을 직접 검증).
- [ ] `npm --prefix server run typecheck` PASS.
- [ ] `npm --prefix server test` PASS.
- [ ] `node test/sync_shared_types.mjs` PASS.
- [ ] 관련 phase e2e PASS.
- [ ] Phase 7 findings와 다음 phase handoff 작성.

---

## 7. 바로 다음 작업

P0 4개(Step 1~4)가 모두 닫혔다. 다음 작업은 **Step 5+ P1 follow-up bundle** — 운영 출시 직전 게이트는 통과한 상태에서 비용 추적, 메뉴 가시성, 보고서 정밀화, demo-to-real 정리, billing을 순차적으로 처리한다.

추천 순서:

1. `llm_usage_log.cost_usd_micros` price map (Phase 6 잔재).
2. role-based sidebar nav visibility (employee/viewer에게 admin 전용 메뉴 숨김).
3. reports date window + agent drilldown.
4. demo-to-real frontend cleanup (dashboard / daily / newsletter).
5. billing / subscription caps.

선행 단계 구현 결과는 각 step의 findings 문서를 기준으로 본다 — `PHASE_7_STEP_1_FINDINGS.md`, Step 2 결과는 `PHASE_7_UI_BACKEND_STATUS.md` (closeout findings 별도 작성 예정), `PHASE_7_STEP_3_FINDINGS.md`, `PHASE_7_STEP_4_FINDINGS.md`.

