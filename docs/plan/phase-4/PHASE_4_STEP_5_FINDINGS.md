# Phase 4 — Step 5 Findings (통합 e2e + 종료 게이트)

> **완료일**: 2026-05-12
> **범위**: `test/phase_4_e2e.mjs` 신규 작성 + 8 시나리오 통과 + 회귀 스위트 전체 PASS + Phase 4 종료 게이트 sync. 서버 코드 / 마이그레이션 / shared types / 백엔드 라우트는 손대지 않았다.

---

## 1. 적용 파일

신규 (2):

- `test/phase_4_e2e.mjs` — Phase 4 통합 e2e 스크립트 (8 시나리오 + cleanup sweep)
- `docs/plan/phase-4/PHASE_4_STEP_5_FINDINGS.md` (본 문서)

수정 (2):

- `docs/plan/phase-4/PHASE_4_MASTER.md` — Step 5 체크 + go/no-go 체크리스트 갱신
- `.gitignore` — `test/phase_4_e2e.png`를 기존 e2e 스크린샷과 동일하게 ignore

수정 안 함: 서버 코드 / 마이그레이션 / shared types / 백엔드 라우트 / 프론트엔드. Step 5는 검증·종료 단계이므로 결함이 발견되지 않는 한 코드를 건드리지 않는 것이 계획서 §0의 명시 원칙.

---

## 2. e2e 스크립트 구조

`test/phase_4_e2e.mjs`는 Phase 2/3 e2e 패턴을 그대로 따른다 — 단일 Playwright `chromium` 세션 + 직접 fetch 보조 helper + `kloser_service` BYPASSRLS 역할로 outbox/주변 row 조회 + 인증 흐름은 UI 폼을 통과시킴.

차이점:

- **cleanup 역할 분리** — Phase 4 신규 테이블(`calls` / `transcripts` / `call_action_items`)에는 `kloser_service`에 grant가 부여돼 있지 않다 (Step 3 findings §residual: "calls는 anonymous 흐름 없음 → service role 안 씀. 영향 0"). e2e cleanup은 dev-only 경로이므로 postgres superuser(=migration role `kloser`)로 직접 DELETE한다. `psql(sql, { role: "migrate" })` 호출이 그 경로. 기존 phase 3 패턴(`kloser_service` 또는 `app` + GUC)은 users / organizations / invitations / sessions 정리에 그대로 사용.
- **테스트 범위 cleanup** — `calls` row는 `phase4test-*` prefix가 붙은 notes/title 또는 `phase4test-%@example.test` 테스트 사용자 `agent_user_id`에 연결된 경우만 child→parent 순서로 hard-delete한다. `started_at` 시간 윈도우 일괄 삭제는 제거해 같은 dev DB에서 동시에 만들어진 수동 통화 row를 건드리지 않는다.
- **note 저장 retry 루프** — start_call ack가 도착하기 전에 저장 버튼을 눌러도 page는 `통화 식별자 대기 중`만 표시하고 호출하지 않는다. `saveLiveNoteWithRetry`가 그 상태와 `저장 중…` transient를 통과시키며 `저장됨` 또는 명시적 오류 라벨이 나올 때까지 재시도.
- **시나리오 4 KPI 비교** — 백엔드 응답 → 클라 라벨링 결과를 `toLocaleString("en-US")` / `(rate * 100).toFixed(1) + "%"`로 재계산해 UI 텍스트와 정확히 매치. 시드/잔재가 누적돼도 한 통화의 *존재* 자체만 핵심 자료로 본다.

---

## 3. 시나리오 결과

8 시나리오 + cleanup sweep, 모두 PASS. 스크립트 종료 시 콘솔 에러 0건.

| # | 시나리오 | 핵심 검증 | 결과 |
|---|---|---|---|
| 1 | live.html 실 영속 통화 | quick note 저장 → 종료 → `/calls?q=<note>` total=1, status=ended, agent_user_id=admin | PASS |
| 2 | calls.html 목록 + URL sync + detail | `?q=` prefill / 총 1건 / 행 클릭 → `완료` 뱃지 + notes 패널 노출 | PASS |
| 3 | transcript + action item | API POST 한 row가 detail 패널에 그대로 렌더 | PASS |
| 4 | dashboard.html KPI/recent | `/dashboard/summary` 응답 ↔ UI 라벨 매치 (today / response_rate / active / recent_calls 행) + (demo) 라벨 3개 이상 잔존 | PASS |
| 5 | Beta org 격리 | UI 총 0건 / API `/calls?q=` total=0 / 직접 `GET /calls/<acmeId>` 404 / dashboard recent에 leak 없음 | PASS |
| 6 | viewer 권한 | 초대 → accept → calls.html 읽기 OK / `POST /calls/:id/notes` 403 / `GET /calls/:id` 200 | PASS |
| 7 | unverified user | 신규 가입 → calls.html / dashboard.html 둘 다 `#unverified-banner` 노출 / `POST /calls` 403 `email_not_verified` / `GET /calls` 200 (read 허용) | PASS |
| 8 | cleanup sweep | finally에서 phase4test prefix + 테스트 사용자 연결 row만 sweep, residue 5개 카테고리 모두 0 | PASS |

스크립트 종료 시 콘솔 에러 0, screenshot `test/phase_4_e2e.png`는 실행 중 갱신되지만 git에는 포함하지 않는다.

---

## 4. cleanup 증거

cleanup 함수가 다음 순서로 실행된다 (`finally` 블록).

```sql
-- Phase 4 tables — superuser(kloser) 역할로 RLS+grant 양쪽을 bypass.
-- (1) phase4test prefix 또는 테스트 사용자에 연결된 call graph만 삭제
DELETE FROM call_action_items
  WHERE title LIKE 'phase4test-%'
     OR call_id IN (
          SELECT id FROM calls
           WHERE notes LIKE 'phase4test-%'
              OR title LIKE 'phase4test-%'
              OR agent_user_id IN (
                   SELECT id FROM users WHERE email LIKE 'phase4test-%@example.test'
                 )
        );
DELETE FROM transcripts
  WHERE text LIKE 'phase4test-%'
     OR call_id IN (...동일 call scope...);
DELETE FROM calls
  WHERE notes LIKE 'phase4test-%'
     OR title LIKE 'phase4test-%'
     OR agent_user_id IN (...phase4test users...);

-- (2) auth_tokens / users / orgs / invitations / sessions — phase 3 패턴을 테스트 사용자 범위로 제한
UPDATE auth_tokens SET invalidated_at = now() WHERE ... ;
SELECT m.org_id FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE u.email LIKE 'phase4test-%@example.test' AND m.role = 'admin';
   -- 그 org 단위로 DELETE FROM organizations (app role).
DELETE FROM users  WHERE email LIKE 'phase4test-%@example.test';
UPDATE invitations SET canceled_at = now() WHERE email LIKE 'phase4test-%' AND accepted_at IS NULL;
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'phase4test-%@example.test');
```

residue 카운트:

| 항목 | run 후 잔재 |
|---|---|
| `calls` (notes/title `phase4test-%`) | 0 |
| `transcripts` (text `phase4test-%`) | 0 |
| `call_action_items` (title `phase4test-%`) | 0 |
| `users` (email `phase4test-%@example.test`) | 0 |
| `invitations` (email `phase4test-%`, pending) | 0 |

총합 0 — `s8: residue 0` PASS line.

---

## 5. 회귀 스위트 결과

```
npm --prefix server run typecheck   → PASS (no output, exit 0)
node test/sync_shared_types.mjs     → PASS (9 entity)
npm --prefix server test            → PASS  212/212  (22.6s)
node test/phase_0_5_e2e.mjs         → PASS  16 assertion + RTT 13ms + 콘솔 에러 0
node test/phase_2_customers_e2e.mjs → PASS  7 시나리오 + leftover sweep 0
node test/phase_3_e2e.mjs           → PASS  33 assertion + cleanup
node test/phase_4_e2e.mjs           → PASS  40+ assertion + cleanup sweep
```

Phase 4 e2e는 안정성 확인 차원에서 2회 연속 PASS (cleanup 호환성 + idempotence).

실행 환경:

| 컴포넌트 | 커맨드 | 포트 |
|---|---|---|
| Postgres + Redis | `docker compose -f ops/docker-compose.yml up -d` | 5432 / 6379 |
| API + WS | `PORT=32173 npm --prefix server run dev` | **32173** |
| Static HTML | `python -m http.server 8765` (project root) | 8765 |

`server/.env`는 `PORT=3001`로 박혀 있어 base 32173 환경을 강제하려면 env override 필요. 본 step에서는 `.env`를 건드리지 않고 launch 시점 override만 사용 (e2e는 split-origin 32173 + 8765를 기대).

---

## 6. (API) vs (demo) 경계 (Phase 4 종료 기준)

| 페이지 | (API) 영역 | (demo) 영역 |
|---|---|---|
| `live.html` | 인증·`/me`·미인증 배너·WS 연결·실시간 transcript/sentiment/suggestion 푸시·quick note 저장·종료 (모두 영속) | 좌측 고객 카드 / 통화 meta / 체크리스트 / 빠른 응대 멘트 / 음소거·대기 버튼 |
| `calls.html` | 사이드바·인증·`/me` 배너·`/calls` 목록·`/calls/:id` 상세·`/calls/:id/transcript`·`/calls/:id/action-items`·URL sync | CSV 내보내기 버튼 |
| `dashboard.html` | 사이드바·인증·`/me` greeting + 배너·`/dashboard/summary` KPI 4장 + recent_calls 5건 | 시장 트렌드 / 추천 To-Do / 팀 활동 5건 (Phase 5~6에서 교체) |

라벨 표시 — `dashboard.html`은 3개 demo 헤더에 (demo) 명시, `live.html`은 demo 버튼에 `title="(demo)"`, `calls.html`은 CSV 버튼에 `title="...Phase 6 예정"`. (demo) 라벨 카운트 3 이상 유지를 e2e가 assert.

---

## 7. 미해결 / 잔여 위험

1. **WS disconnect → `dropped` 자동 마킹 부재** — 브라우저 탭이 비정상 종료되면 beforeunload만 best-effort emit, ack 못 받음. 서버 측 socket disconnect 핸들러도 자동 `dropped` 처리 없음. `in_progress` 잔류 row가 누적되면 `/dashboard/summary.active_calls`가 부풀려진다. Phase 5 disconnect heartbeat 정책에서 일괄 처리.
2. **`live.html` 좌측 고객 카드 / 통화 meta 정적** — `customer_id` NULL 통화 모델이라 표시할 동적 데이터가 없음. Phase 5에서 customer selection 흐름이 정해지면 `/customers/:id`로 채워짐.
3. **action item / transcript 작성 UI 미구현** — detail 패널은 read-only. 백엔드 mutation endpoint는 노출 (route test로 검증) → frontend wiring만 추가하면 동작. Phase 5+.
4. **`calls.html` 정렬 미지원** — 백엔드 `CallListQuery`에 sort/dir 없음. 시간 역순 고정. 후속 phase에서 백엔드 schema 변경과 함께 도입.
5. **dashboard `오늘 통화` KPI는 UTC 기준** — `organizations.timezone` 미도입 (Phase 6+). 한국 사용자 입장에서 자정 직후 일시적인 mismatch 가능성.
6. **`live.html` callState 비노출** — 모듈 IIFE 안에 있어 자동화 테스트에서 직접 검증 불가. e2e는 console 로그 / `noteStatus` 텍스트로 우회. dev-only `window.__liveCallState` 노출은 Phase 5 e2e 작성 시 같이 검토.
7. **cleanup이 superuser 역할 의존** — `kloser_service` grant 부재가 의도된 설계이므로 e2e dev-only로 `kloser` superuser 사용. 운영에서는 발생할 일 없음 (운영 자동화 없음).

---

## 8. Phase 5 인계 항목

Phase 5 진입 시 다음을 먼저 정리하기로 한 항목 모음.

1. **실 STT (Naver Clova) 어댑터** — Phase 0.5 fixture 흐름을 STT 스트림으로 교체. transcript persist 경로는 이미 갖춰져 있음.
2. **AI 통화 요약 / 응대 추천 자동 생성** — `calls.summary` / `needs` / `issues` / `sentiment` 컬럼은 이미 존재, AI 생성 결과를 service에서 UPDATE.
3. **call_checklist / ai_suggestions 영속화** — `live.html`의 정적 5항목·suggestion 카드 → DB 모델 도입.
4. **knowledge_bases / knowledge_chunks** — RAG용 회사 가이드 영속 저장 + pgvector.
5. **disconnect heartbeat 정책** — WS disconnect에서 자동 `status='dropped'` 마킹. `active_calls` KPI 자연 정상화.
6. **call customer selection 흐름** — live.html start_call payload에 유효한 `customer_id` 전달. 매칭 안 되면 통화 종료 후 `service.linkCustomer(callId, customerId)`로 사후 매칭.
7. **action item 작성/완료 UI** — calls.html detail 패널에 신규/상태 변경 UI 추가. mutation 백엔드는 준비됨.
8. **manager team-scope 권한** — `memberships.team_id`와 결합한 RLS 정책 4개. Phase 4는 자기 조직 전체 read 허용 모델, Phase 5+에서 좁혀짐.
9. **CSV 내보내기 (calls.html)** — Phase 6+ 운영 단계.
10. **org-level timezone** — `organizations.timezone` 컬럼 + dashboard 응답 timezone-aware. Phase 6+.

---

## 9. git 작업

git add / commit / push / merge 0건. Codex가 본 보고와 diff를 검토 후 commit 결정.

변경 파일 git 표면:

```
M  docs/plan/phase-4/PHASE_4_MASTER.md            (Step 5 체크 + go/no-go 갱신)
?? docs/plan/phase-4/PHASE_4_STEP_5_FINDINGS.md   (본 문서)
?? test/phase_4_e2e.mjs                           (신규 e2e 스크립트)
M  .gitignore                                     (phase_4 e2e screenshot ignore)
```

`test/phase_4_e2e.png`는 실행 산출물이므로 `.gitignore` 대상이며 commit 범위에서 제외.

---

## 10. Codex 집중 리뷰 포인트

1. **cleanup의 superuser 사용** — 운영에서는 발생할 일 없는 dev-only 경로지만, e2e 스크립트가 docker exec로 `kloser` superuser psql을 친다는 점이 보안/감사 관점에서 surprise가 없는지 검토. 대안은 Phase 4 service grant 마이그레이션을 추가하는 것 (계획 §residual에서는 미도입 결정).
2. **noteStatus retry 루프** — Playwright headless에서 WS 핸드셰이크가 700~1500ms 정도 걸린다. 본 루프는 최대 20초까지 시도하며, 평균 1~2 cycle (~3초) 내 성공. 실패 케이스 (서버 다운 등)는 명시적 throw로 finally cleanup에 도달.
3. **시나리오 4 (demo) 라벨 카운트** — `>= 3`로 느슨하게 잡았다. 정확히 3개여야 한다면 `=== 3`으로 조이거나, 라벨 문구 자체를 assert. 현재 dashboard에는 정확히 3개(트렌드 / To-Do / 팀 활동) 라벨이 있다.
4. **시나리오 7 — unverified가 read 200을 받는다** — 의도된 정책 (requireVerified는 mutation에만 적용). e2e는 이 분리를 직접 assert. unverified user는 자기 신생 org에 row가 없어서 list가 빈 결과지만 응답은 200.

---

## 11. 종료 게이트 sync

`PHASE_4_MASTER.md` §8 go/no-go 체크리스트의 항목들을 Step 5 종료 시점 상태로 갱신:

- typecheck PASS ✓
- 누적 서버 test 212/212 ✓
- Phase 0.5 16/16 회귀 ✓
- Phase 2 customers 7/7 회귀 ✓
- Phase 3 33 assertion 회귀 ✓
- Phase 4 8 시나리오 + cleanup sweep ✓
- sync_shared_types 9 entity ✓
- 마이그레이션 4개 적용 + RLS FORCE 검증 ✓ (Step 1 시점 검증, 본 step에서 회귀로 PASS)
- 모든 신규 endpoint 200/4xx 정확 ✓
- viewer mutation 403 / 다른 agent 통화 mutation 403 ✓
- cross-org calls ID mutation 404 ✓
- `customers.last_contacted_at` 동시 갱신 ✓ (Step 2 단위 + Step 5 e2e 둘 다 PASS)
- 미인증 mutation 403 `email_not_verified` ✓
- calls.html mock 제거 (in-page array 0건) ✓ (Step 4 산출물)
- dashboard.html KPI 4장 + 최근 5건 실 데이터 ✓
- live.html 영속 hook ✓
- innerHTML XSS gate 0건 ✓ (Step 4 audit)
- Step 1~5 findings 모두 작성 ✓ (본 문서로 완료)
- USER_GUIDE_PHASE_4.md + PHASE_4_FOUNDATIONS.html → **미작성, 사용자 결정 대기**. Phase 1~3은 사용자 가이드까지 동반 작성됐으므로 정합성을 위해서는 Phase 4도 필요하지만, 본 step 범위 외로 보고 별 step으로 분리하는 것도 가능.

Phase 4 전체 go/no-go에 한 가지(USER_GUIDE / FOUNDATIONS 문서)만 미해결. 그 외 모든 항목 PASS — Phase 5 진입 가능.
