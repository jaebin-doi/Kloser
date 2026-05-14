# Phase 7+ Handoff — Phase 6 종료 후 인계 항목

> 작성일: 2026-05-14
> 작성 시점: Phase 6 Step 5 closeout 직후.
> 정본 plan: `docs/plan/phase-6/PHASE_6_STEP_5_PLAN.md §9`.
> Phase 6 core 4영역(워커 + 실 provider + action item DELETE + manager report)은 모두 닫혔고, 본 문서는 그 외 미수행 항목을 Phase 7+ 우선순위로 정리한다.

---

## Next Session Entry Point

다음 세션은 **Phase 7 Step 1 계획 수립**부터 시작한다.

1. 새 문서 `docs/plan/phase-7/PHASE_7_MASTER.md`를 만든다.
2. 첫 구현 단위는 `SMTP / Resend 실 adapter`로 잡는다.
3. Step 1 계획 문서 `docs/plan/phase-7/PHASE_7_STEP_1_PLAN.md`를 작성한다.
4. 구현 순서는 schema-first를 따른다. 예상 첫 레이어는 `email_outbox`를 유지하면서 provider 설정/전송 이력/실패 retry에 필요한 schema 변경 여부를 확정하는 것이다.
5. Phase 6 residual 중 `llm_usage_log.cost_usd_micros` price map은 Phase 7 P1 follow-up으로 남긴다. SMTP보다 먼저 하지 않는다.

작업 재개 시 기준 파일:

- `docs/plan/phase-6/PHASE_7_HANDOFF.md`
- `docs/plan/phase-6/PHASE_6_MASTER.md`
- `AGENTS.md`

---

## 0. 우선순위 요약

| # | 항목 | 우선 | 노력(추정) | 카테고리 |
|---|---|---|---|---|
| 1 | SMTP / Resend 실 adapter | P0 (운영 출시 직전) | 2~3일 | 운영 출시 게이트 |
| 2 | MFA / 세션 강화 | P0 | 4~5일 | 보안 |
| 3 | activity_log + 감사 로그 | P0 | 3일 | 운영 위생 |
| 4 | retention enforce cron | P0 | 2일 | 운영 위생 |
| 5 | 결제·구독 흐름 (Stripe / Toss + plan cap) | P1 | 1~1.5주 | 상업화 |
| 6 | `llm_usage_log` cost model→price map | P1 | 1일 | 비용 관측 |
| 7 | role-based sidebar nav 가시성 | P1 | 0.5일 | UX |
| 8 | 보고서 날짜 윈도우 / 상담원 drilldown | P1 | 1~1.5일 | UX |
| 9 | demo-to-real frontend 정리 (dashboard / newsletter / daily) | P1 | 1~1.5일 | UX |
| 10 | call_recordings 오디오 파일 + S3/MinIO | P2 | 3~4일 | 기능 확장 |
| 11 | enterprise SSO (Keycloak) | P2 | 4~5일 | enterprise |
| 12 | `npm audit` high 2건 (`node-pg-migrate → glob`) | P2 | 0.5일 (별도 PR) | 의존성 위생 |
| 13 | 다국어 transcript + `organizations.timezone` | P3 | 1~1.5주 | i18n |

P0 = Phase 7 첫 sub-step에 포함되어야 하는 것. P1 = Phase 7 중반. P2 = Phase 7 후반 또는 Phase 8. P3 = Phase 8 이후.

---

## 1. SMTP / Resend 실 adapter (P0)

**현황**: Phase 3에서 dev `email_outbox` 표만 채우고, 실제 메일은 발송되지 않음. e2e는 `outbox.metadata->>'raw_url'`을 직접 읽어 token을 추출.

**필요한 일**:
- `server/src/services/email.ts`에 Resend(또는 SES/SendGrid) adapter 추가.
- env: `EMAIL_PROVIDER=resend` / `RESEND_API_KEY` / `EMAIL_FROM`.
- `email_outbox`는 archive-only로 유지 (감사 추적용).
- 실패 시 BullMQ retry 3회 + dead-letter.
- 도메인 인증(SPF/DKIM/DMARC) 절차 문서화.

**완료 기준**: Phase 3 invite / verify / forgot 흐름이 실 메일로 도착. dev에서는 mock outbox 그대로 사용.

---

## 2. MFA / 세션 강화 (P0)

**현황**: 비밀번호 한 요소만으로 로그인. JWT access 15분 + refresh family rotation 30일.

**필요한 일**:
- TOTP (Google Authenticator 호환) 1차 도입 — `users.mfa_secret_encrypted` 추가.
- (선택) WebAuthn / Passkey 2차 도입.
- `auth_tokens`에 `purpose='mfa_challenge'` 추가.
- 로그인 흐름: 비밀번호 → MFA 요구 → access 발급.
- "관리자가 MFA 의무화" 조직 단위 설정 토글.

**완료 기준**: admin이 MFA 필수로 켜면 그 조직의 모든 사용자가 다음 로그인부터 TOTP 요구. 실패율 / 락아웃 카운트는 activity_log에 기록.

---

## 3. activity_log + 감사 로그 (P0)

**현황**: schema에 `activity_log` 자리만 마련. 실제로 채우는 코드 없음.

**필요한 일**:
- 감사 대상 정의 — 로그인 / 로그아웃 / 권한 변경 / 통화 삭제 / action item 삭제 / 보고서 조회 / MFA 변경 / 결제 변경.
- Fastify hook에서 mutation endpoint 종료 시 INSERT.
- admin 전용 `GET /audit/log` endpoint + 페이지(보안 검토).
- RLS FORCE — 본인 조직만.
- 보존 기간 결정 (제안: 1년).

**완료 기준**: 위 감사 대상 작업이 실행되면 1행씩 추가. admin이 검색 가능. e2e 정리 흐름은 prefix-scoped sweep 그대로.

---

## 4. retention enforce cron (P0)

**현황**: `transcripts` / `call_recordings` 보존 정책 문서만 존재 (3년 / 90일). enforce 코드 없음.

**필요한 일**:
- 워커에 새 cron job — 일 1회 (예: 03:00 KST):
  - `transcripts.created_at < now() - interval '3 years'` 행 삭제.
  - `call_recordings.uploaded_at < now() - interval '90 days'` 객체 + 메타 삭제.
- 삭제 전 통화 단위 감사 row 생성(`activity_log` 의존 → §3 선행).
- 조직 단위 토글 (`organizations.retention_overrides` JSON) — Phase 8+.

**완료 기준**: cron이 매일 자동 실행, 보존 기간 초과 row가 0건임을 매일 검증. dev에서는 cron disabled.

---

## 5. 결제·구독 흐름 (P1)

**현황**: `organizations.plan` 컬럼만 존재 (`starter`/`pro`/`enterprise`). 실 cap / 결제 없음.

**필요한 일**:
- Stripe (글로벌) + Toss (KR) dual adapter — 결제 수단 / 환불 / 구독 변경.
- 통화 수 / 직원 시트 / 일일 To-Do 등 cap 정의.
- `services/usage.ts` — cap 도달 시 mutation 거부 (`402 plan_limit_exceeded`).
- admin 결제 화면 `platform/settings.html` 플랜 카테고리.
- webhook → 구독 상태 자동 동기화.

**완료 기준**: Starter / Pro / Enterprise 플랜에 따라 cap이 실제 작동. 결제 실패 시 grace period (예: 7일) 동안 read-only 모드 fallback.

---

## 6. `llm_usage_log` cost model→price map (P1)

**현황**: `llm_usage_log.cost_usd_micros` 컬럼 존재, 모든 행이 NULL. Phase 6 Step 2 plan §2가 "Phase 7+로 분리"로 결정.

**필요한 일**:
- `server/src/config/llmPricing.ts` — provider × model × (tokens_in / tokens_out) → micros price map. 정기 점검 cadence 정의 (예: 분기 1회).
- Provider adapter 응답에서 model 이름 추출 → map lookup → `cost_usd_micros` 계산.
- `llm_usage_log` INSERT 시점 또는 즉시 UPDATE.
- 일일 cap (`organizations.daily_llm_cost_cap_usd_micros`) 도입 + 초과 시 LLM 호출 거부 (graceful — 통화 자체는 종결 가능).

**완료 기준**: model 별 가격이 코드로 추적되어 admin이 일/월별 cost를 합산해 운영비를 추정할 수 있음.

---

## 7. role-based sidebar nav 가시성 (P1)

**현황**: Phase 6 Step 4에서 "조직 > 보고서" 항목이 사이드바에 추가됐으나, employee/viewer에게도 노출. 클릭 시 백엔드가 403으로 차단하지만, UX상 항목이 보이는 것은 부적절.

**필요한 일**:
- `platform/_shared.js`의 `SIDEBAR_HTML` 상수를 함수로 전환 — `/me` 응답의 role에 따라 항목 필터링.
- 항목별 가시성 매트릭스:
  - "보고서" — admin / manager만
  - "팀 & 계정" — admin / manager만 (현재는 모두 보임)
  - "설정" — admin / manager 또는 본인 프로필 한정
- e2e 영향: phase_3 / phase_5 / phase_6 e2e에서 항목 위치 의존하는 selector 점검.

**완료 기준**: employee로 로그인 시 "보고서" / "팀 & 계정" 항목이 사이드바에서 숨겨짐. admin/manager는 그대로.

---

## 8. 보고서 날짜 윈도우 / 상담원 drilldown (P1)

**현황**: `GET /reports/team-summary`는 팀 단위 + 전체 기간 KPI만 제공. 일/주/월 필터 없음. 상담원 단위 KPI 없음.

**필요한 일**:
- query param `from` / `to` (ISO date) 추가, default 전체 기간.
- `agent_user_id` 단위 drilldown — manager가 자기 팀의 상담원별 통화 수 / 완료율 비교.
- `platform/reports.html`에 date range picker + 상담원 표.
- `recent_calls` limit 키울 수 있게 query param (10 → 50, max 100).

**완료 기준**: 매니저가 자기 팀의 이번 주 통화만 분리해서 보고, 상담원별 응답률을 비교할 수 있음.

---

## 9. demo-to-real frontend 정리 (P1)

**현황**: dashboard / newsletter / daily에 demo 위젯이 남아 있음. Phase 4 README의 (API) / (demo) 라벨이 그대로 유지.

**대상**:
- `dashboard.html` — 시장 트렌드 알림 5건, 오늘의 추천 To-Do 6건, 팀 활동 5건 (모두 demo).
- `newsletter.html` — 캠페인 / 통계 / AI 챗봇 (모두 demo).
- `daily.html` — 트렌드 / To-Do / 키워드 / 다운로드 (모두 demo).

**필요한 일**:
- 각 위젯을 실 API endpoint와 연결 또는 의도적으로 demo 라벨 유지 결정.
- Phase 6 Step 4 reports.html과 비슷한 형태로 점진 전환.

**완료 기준**: (API) / (demo) 라벨이 모든 페이지에서 정확.

---

## 10. call_recordings 오디오 파일 + S3/MinIO (P2)

**현황**: `call_recordings` 테이블 컬럼만 마련. 오디오 파일 저장 / 다운로드 / 재생 없음.

**필요한 일**:
- S3 호환 객체 스토리지 (운영: S3, dev: MinIO) adapter.
- 통화 중 WS에서 받은 raw audio chunk를 워커가 합쳐 mp3/opus로 인코딩 후 업로드.
- `call_recordings.s3_key` / `duration_seconds` / `size_bytes` / `uploaded_at` 채움.
- 통화 기록 페이지 상세 패널에 재생 컨트롤 (signed URL TTL 1시간).
- §4 retention cron으로 90일 후 자동 삭제.

**완료 기준**: admin이 통화 기록 페이지에서 녹음을 다시 들을 수 있음. 90일 후 자동 정리.

---

## 11. enterprise SSO (Keycloak) (P2)

**현황**: 자체 Argon2id + JWT만 지원.

**필요한 일**:
- Keycloak adapter (OIDC) — Enterprise 플랜 토글로 활성.
- 기존 비밀번호 흐름과 공존.
- 그룹 / 역할 매핑 정책.
- SAML 2.0 후속.

**완료 기준**: Enterprise 고객이 Keycloak SSO로 본인 회사 IdP로 로그인 가능.

---

## 12. `npm audit` high 2건 (P2)

**현황**: `node-pg-migrate → glob` 의존성 경로에서 high 2건. Phase 6 Step 2 findings §6.4 기록 그대로.

**필요한 일**:
- `node-pg-migrate` 최신 버전으로 업그레이드 또는 `npm audit fix`.
- migration 호환성 점검 후 별도 PR.
- 본 fix는 코드 흐름 무관, dependency 단독 PR.

**완료 기준**: `npm --prefix server audit --omit=dev`가 high/critical 0건.

---

## 13. 다국어 transcript + `organizations.timezone` (P3)

**현황**: transcript / UI 모두 한국어 가정. 서버 dashboard는 UTC 자정 기준.

**필요한 일**:
- `users.locale` (`ko` / `en` / `ja`) — UI 텍스트 + transcript STT 언어.
- `organizations.timezone` (`Asia/Seoul` 등) — dashboard / 보고서 "오늘" 기준 시간대.
- STT adapter가 locale을 받아 적절 모델 선택.
- Phase 8+로 이관 가능 (운영 출시 직전 cn/jp 시장 진입 시점).

**완료 기준**: 일본/미국 고객이 자기 시간대로 dashboard "오늘"을 봄.

---

## 14. 검증 누락 + 한 번에 보고

본 Phase 6 closeout에서 확인됐으나 별 PR이 필요한 작은 항목 :

- **phase_4_e2e 1st-run race ("Failed to fetch")** — 두 번째 실행에서 PASS. Playwright teardown 경합으로 추정. 본질적 결함이 아닐 가능성이 높지만, 재현 절차를 정리해서 Phase 7 첫 sub-step에서 점검 권고.
- **워커 inline drain helper(`server/scripts/phase6E2eDrain.ts`) 공식화** — 현재는 e2e 헬퍼로 사용. Phase 7에서 worker 디버깅 도구 표준 진입점으로 승격할지 결정.

---

## 15. Phase 7 진입 권고 순서

1. **§1 + §2 + §3 + §4 (P0 묶음)** — 운영 출시 직전 게이트. 4개 모두 끝나야 외부 사용자에게 메일 보낼 수 있고, 감사 / 보존 정책이 정상 작동.
2. **§6 + §7 + §8 + §9 (P1 묶음)** — 운영자/매니저 UX 마무리. P0 묶음과 병렬 진행 가능.
3. **§5 (결제)** — P1 끝부분. 실제 매출 시작 직전.
4. **§10 + §11 + §12** — Phase 8 또는 별도 운영 위생 PR.
5. **§13** — Phase 9+ (해외 시장 진입 시점).

---

## 16. 한 줄 요약

> **Phase 6은 운영 루프 4개(워커·실 provider·action item delete·매니저 보고서)를 닫았다. Phase 7+는 운영 출시 직전의 보안·감사·메일·결제 게이트(§1~§5)와 운영 UX 정리(§6~§9)로 진입한다.**
