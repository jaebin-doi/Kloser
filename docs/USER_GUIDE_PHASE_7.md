# Kloser Phase 7 사용자 가이드

> Phase 7은 Phase 1~6이 닫아 둔 운영 루프 위에 **운영 출시 직전 게이트 5종**을 추가한 단계입니다. 실 이메일이 도착하고, 2단계 인증으로 admin 계정을 보호하고, 운영 감사 로그가 남고, 보존 정책이 자동으로 강제되고, 보고서가 기간/담당자 단위로 정밀해지고, 플랜·사용량을 admin 화면에서 직접 확인할 수 있습니다.

작성일: 2026-05-18 · 상위 문서: `docs/plan/phase-7/PHASE_7_MASTER.md` · 정본 결과: `docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md`.

---

## 1. Phase 7의 목적

Phase 6까지의 시스템은 통화 루프와 데모 데이터로 동작하는 운영 도구를 갖췄지만, **외부 사용자에게 유료로 팔기 직전의 5가지 빈자리**가 있었습니다.

1. **이메일이 실제로 도착해야 한다** — Phase 3의 회원가입/비밀번호 재설정/초대는 dev outbox에 row만 남기는 형태였습니다. Resend 어댑터와 BullMQ 워커로 실 발송 경로를 닫았습니다.
2. **admin 계정이 비밀번호 하나로만 지켜져선 안 된다** — TOTP 2단계 인증을 도입하고, 조직 단위로 MFA 필수화 토글을 추가했습니다.
3. **운영자가 누가 무엇을 언제 했는지 설명할 수 있어야 한다** — `activity_log`에 보안/멤버십/초대/고객/통화/지식/보고서/billing 행위를 모두 적재하고, admin 전용 조회 UI를 settings에 붙였습니다.
4. **개인정보 보존 정책을 코드로 강제해야 한다** — transcripts 3년 hard delete, stuck-sending 이메일 회복을 cron 워커로 자동 처리합니다.
5. **유료 전환 직전의 plan 한도 / 사용량 / 청구 정보 UX가 필요하다** — 플랜별 한도(seats/customers/지식/통화/AI 비용)를 백엔드에서 강제하고, settings.html에 사용량 progress bar + 청구 정보 입력 form을 붙였습니다.

여기에 운영 UX 잔여 4종(LLM 비용 단가 매핑, 역할별 사이드바, 보고서 기간 윈도우, demo 정직성 정리)을 함께 묶어 9개 step으로 닫았습니다.

Phase 7이 끝나면, 평가자는 **회원가입 → 이메일 인증 → MFA 등록 → 동료 초대 → 통화 → 보고서 조회 → 플랜 한도 확인 → 청구 정보 저장** 까지 전 흐름을 실제 운영처럼 진행할 수 있습니다.

---

## 2. Phase 7에서 가능해진 것

운영 환경 시점 기준 (`EMAIL_PROVIDER=resend`, MFA optional, retention worker `KLOSER_RETENTION_ENABLED=true`):

- 회원가입 / 비밀번호 재설정 / 초대 메일이 실제 받은편지함에 도착합니다.
- 로그인 후 `설정`에서 TOTP 인증기(Google Authenticator 등)로 2단계 인증을 직접 등록·해제할 수 있고, admin은 조직 전체 MFA 필수화를 토글할 수 있습니다.
- admin은 `설정` 하단 감사 로그 패널에서 최근 운영 행위 200건을 볼 수 있습니다 (cursor pagination + cross-org isolation).
- 보고서 페이지에서 7/30/90일 또는 직접 기간 선택, 담당자별 사용량 / 응답률 / 평균 통화시간 확인, 행 클릭으로 해당 담당자의 최근 통화로 drill-down할 수 있습니다.
- dashboard / daily / newsletter 페이지가 "데모"라고 정직하게 표시되고, 사용자가 입력한 키워드/경쟁사/뉴스레터 본문에 XSS 우회가 차단됐습니다.
- 비관리자는 사이드바에서 admin 전용 메뉴(팀 보고서 등)를 볼 수 없습니다. 직접 URL 접근 시 backend가 별도로 403을 반환합니다.
- admin은 `설정 → 플랜 & 사용량`에서 현재 플랜·결제 상태·6개 한도 진행률·청구 정보 입력 form을 직접 볼 수 있습니다. seats / customers / 지식베이스 / 지식 청크 / 이번 달 통화 5개는 한도 초과 시 호출이 403으로 차단됩니다.

---

## 3. 실 이메일 발송 (Step 1)

### 3.1 모드 전환

`.env`의 `EMAIL_PROVIDER`로 결정합니다.

- `EMAIL_PROVIDER`를 비워 두거나 `dev_outbox` — Phase 3 호환 모드. 메일은 `email_outbox` 테이블에 body+token이 그대로 남고, 외부로 발송되지 않습니다. e2e 테스트와 로컬 dev 기본값.
- `EMAIL_PROVIDER=resend` — Resend 어댑터 활성. `RESEND_API_KEY`, `EMAIL_FROM` (검증된 도메인), 선택적으로 `EMAIL_REPLY_TO`가 필요합니다. 누락 시 boot에서 fail-fast합니다.

### 3.2 흐름

1. 회원가입/비밀번호 재설정/초대 라우트가 트랜잭션 안에서 `email_outbox` 행을 INSERT합니다. raw token은 `sensitive_payload_*` 컬럼에 AES-256-GCM 암호화로만 저장하고, `body_text` 등 archive 컬럼에는 `?token=[redacted]`로 마스킹됩니다.
2. BullMQ `email-delivery` 싱글톤 워커가 주기적으로 `pending` 행을 lease (`FOR UPDATE SKIP LOCKED`) → decrypt → `EmailProvider.send` 호출 → 성공 시 `markDelivered`로 sensitive payload scrub.
3. 일시 실패 시 지수 백오프로 재시도하고 (최대 1시간 cap), 영구 실패 시 `markDeadLetter` + scrub.

### 3.3 운영 검증

운영 환경에서는 staging에 한 번:
- `EMAIL_PROVIDER=resend` + 실 도메인으로 부팅.
- 신규 가입 → 인증 메일이 받은편지함에 도착하는지 확인.
- Resend 대시보드에서 delivery rate가 정상인지 확인.

---

## 4. 2단계 인증 (Step 2)

### 4.1 사용자 등록

1. 로그인 후 `설정 → 보안` 섹션의 "2단계 인증 등록" 버튼을 클릭합니다.
2. 현재 비밀번호를 한 번 더 확인 (5분 TTL의 challenge token이 생성됩니다).
3. 화면에 표시된 QR 코드를 Google Authenticator / 1Password / Authy 등으로 스캔하거나 base32 secret을 수동 입력합니다.
4. 인증기가 생성한 6자리 코드를 입력하고 "확인"을 누릅니다.
5. 등록 완료 후 다음 로그인부터 비밀번호 입력 직후 TOTP 코드 화면이 추가됩니다.

### 4.2 사용자 해제

`설정 → 보안 → 2단계 인증 해제` 버튼에서 현재 비밀번호 + 마지막 TOTP 코드를 한 번 더 입력하면 해제됩니다. 조직이 MFA 필수화한 상태라면 본인 등록을 해제할 수 없습니다.

### 4.3 조직 단위 강제

admin이 `설정 → 보안 → 조직 전체 2단계 인증 필수화` 토글을 켜면, 같은 조직의 모든 멤버는 다음 로그인 또는 refresh 시점에 MFA 등록이 강제됩니다. 등록이 없으면 access token이 발급되지 않습니다.

### 4.4 락아웃

연속 실패가 누적되면 자동 락아웃됩니다. 현재 별도 unlock UI는 없으므로 운영자가 직접 DB 또는 운영 스크립트로 `mfa_failed_attempt_count` / `mfa_locked_until`을 클리어해야 풀립니다.

---

## 5. 감사 로그 (Step 3)

### 5.1 admin 패널 위치

`설정 → 보안` 섹션 하단의 "감사 로그" 카드. admin 역할일 때만 보입니다.

### 5.2 기록되는 이벤트 (요약)

- 로그인 성공/실패, 로그아웃, password reset, MFA 등록/해제, 조직 MFA 토글
- 멤버 초대 생성/재발송/취소/수락, 멤버 권한·상태 변경
- 고객 생성/수정/삭제 (값은 기록 안 함, 필드 이름만)
- 통화 생성/메모/요약 수동 입력/삭제
- 지식베이스·체크리스트 템플릿 생성/수정/삭제
- 보고서 조회 (`from`/`to`/`window_days` 포함, 결과는 기록 안 함)
- 본 Phase 9에서 추가: 청구 정보 변경 (`billing.profile_updated`, 변경된 필드 이름만)

### 5.3 보안 정책

- 모든 audit row는 org-scoped (RLS FORCE). cross-org는 응답 단계에서 비어서 옵니다.
- payload는 **이름만** 적습니다. 고객 이름, 이메일, tax_id, 비밀번호 등 값은 절대 포함되지 않습니다.
- admin 패널은 모든 audit 값을 `textContent`로 렌더링하므로 XSS가 발생하지 않습니다.
- 새 audit action은 DB CHECK + 코드 union + 라우트 allow-list 3곳을 동시에 갱신해야만 통과합니다 (의도적 lockstep).

---

## 6. 보존 정책 cron (Step 4)

### 6.1 활성화

운영 환경에서만 `KLOSER_RETENTION_ENABLED=true`를 설정합니다. dev/test는 기본 OFF.

### 6.2 작업

`retention-sweep` BullMQ 싱글톤 워커가 주기적으로:

- transcripts 3년(`created_at < now() - interval '3 years'`) 행을 batch + maxBatches cap으로 hard delete. org별 `withOrgContext` 안에서 실행합니다.
- `email_outbox.status='sending'` 상태로 cutoff 시각 이전부터 막혀 있는 행을 `failed`로 되돌리고 락 메타데이터를 클리어합니다. `attempt_count`는 변경하지 않습니다 (재시도 카운트 보존).
- 한 사이클당 1행의 aggregate audit (`retention.transcripts_deleted` / `email_outbox.sending_recovered`) 적재.

### 6.3 call_recordings

녹취 audio storage는 본 Phase에서는 없으므로 대상이 아닙니다. Phase 8에서 recording surface가 추가될 때 같은 워커에 90일 cutoff 정책을 더할 예정입니다.

---

## 7. LLM 사용 비용 매핑 (Step 5)

### 7.1 어디서 보는가

운영 admin이 `psql` 또는 DB 클라이언트로 `llm_usage_log`를 직접 조회. `cost_usd_micros` 컬럼에 호출 단위 micro-USD 정수가 들어갑니다.

### 7.2 가격 상수

다음 모델만 known model. 나머지는 `cost_usd_micros=NULL` + `metadata.cost_status='unknown_model'` 같은 마커.

| Provider | 모델 | 입력 | 출력 |
|---|---|---|---|
| Anthropic | claude-sonnet-4-5 / 4-6 | $3 / MTok | $15 / MTok |
| Anthropic | claude-opus-4-5 / 4-6 / 4-7 | $5 / MTok | $25 / MTok |
| Anthropic | claude-haiku-4-5 | $1 / MTok | $5 / MTok |
| OpenAI | text-embedding-3-small | $0.02 / MTok | (입력 only) |
| OpenAI | text-embedding-3-large | $0.13 / MTok | (입력 only) |

Clova STT는 환경상 audio duration이 사용량 envelope에 없어 `unsupported_unit` 마커로 NULL 처리됩니다.

### 7.3 backfill 없음

Phase 7 Step 5 시점 이후 호출만 가격이 들어갑니다. 과거 행은 NULL 그대로.

---

## 8. 역할별 사이드바 (Step 6)

### 8.1 표시 규칙

| 역할 | 표시 nav |
|---|---|
| admin | 전체 (대시보드, 고객, 실시간, 통화, 지식, 보고서, 뉴스레터, daily, 설정) |
| manager | admin과 동일하되 backend가 본인 팀 범위만 반환 |
| employee | 팀 보고서 숨김. 다른 항목 동일 |
| viewer | 팀 보고서 + 실시간 통화 + 뉴스레터 숨김. 읽기 전용 |
| (pre-/me / 미인증) | 공통 nav만 — 민감 항목 flicker 차단 |

### 8.2 backend 정책

sidebar는 UX 정리일 뿐, 권한 강제는 backend가 합니다. employee가 `/platform/reports.html` URL을 직접 입력해도 backend가 별도 403/안내 banner를 반환합니다.

---

## 9. 보고서 기간 + 담당자 drilldown (Step 7)

### 9.1 위치

`platform/reports.html`. admin/manager만 접근 가능.

### 9.2 기간 preset

- 7일 / 30일 / 90일 또는 직접 (custom from/to).
- 두 값 모두 omit하면 자동 최근 30일 default.
- 한 값만 보내면 400 (`one_sided_window`).
- 366일 초과는 400 (`window_too_large`).

### 9.3 담당자 carousel

응답에 `agent_summaries` 배열이 추가됐습니다. 조직 범위(admin)에서는 unassigned 버킷이 포함됩니다. team 범위(manager)에서는 본인 팀의 active member만.

행을 클릭하면 client-side에서 `recent_calls`를 해당 담당자 호출로 필터링해 drill-down합니다.

### 9.4 backward incompat

`GET /reports/team-summary`를 from/to 없이 호출하던 기존 통합은 동작이 "전체 기간 → 최근 30일"로 좁혀집니다. 의도된 변경.

---

## 10. demo 정직성 정리 (Step 8)

dashboard / daily / newsletter 세 페이지의 demo 데이터를 정직하게 표시했습니다.

- dashboard의 `오늘 통화 평균` 위젯이 innerHTML 대신 textContent 2-span으로 렌더되어 XSS 위험이 없습니다. API 실패 시 demo fallback 대신 banner를 띄웁니다.
- daily 페이지의 "매일 06:00 자동 갱신" / "네이버 검색 API" 카피가 "데모 데이터 (자동 갱신 backend 미연결)" / "데모 새로고침"으로 바뀌었습니다. 키워드/경쟁사 입력에 `escapeHtml` 처리.
- newsletter 페이지의 "발송" 카피가 모두 "시뮬레이션"으로 일관 교체됐고, chat 메시지 본문이 textContent로 처리되어 XSS hole이 닫혔습니다. 사용자 생성 템플릿 카드 필드에도 `escapeHtml`.
- transactional `email_outbox`(Step 1)는 newsletter campaign에 연결되지 않습니다. `activity_log`(Step 3)도 dashboard 팀 활동 feed로 노출되지 않습니다 (admin 전용).

---

## 11. 플랜 한도 + 사용량 (Step 9)

### 11.1 위치

`설정 → 플랜 & 사용량` 카드. admin 전용입니다. 비관리자에게는 "플랜 정보는 관리자만 확인할 수 있습니다." 라는 정적 안내만 보입니다.

### 11.2 플랜별 한도

| 항목 | starter | pro | enterprise | 강제 |
|---|---|---|---|---|
| 구성원 좌석 (활성+pending invite) | 2 | 10 | 무제한 | hard |
| 고객사 | 100 | 1,000 | 무제한 | hard |
| 지식베이스 | 3 | 50 | 무제한 | hard |
| 지식 청크 | 500 | 10,000 | 무제한 | hard |
| 이번 달 통화 | 100 | 5,000 | 무제한 | hard |
| 이번 달 AI 비용 ($) | $5 | $100 | 무제한 | soft (참고용) |

hard 한도가 차면 mutation 호출이 403 `plan_limit_exceeded`를 반환합니다. WS `start_call`도 같은 구조의 ack로 거부됩니다.

soft cap은 한도가 차도 mutation을 막지 않습니다. admin이 사용량을 보기 위한 신호입니다.

### 11.3 화면 구성

- 헤더 카드: 플랜 badge · 결제 상태 (체험/활성/미결제/해지) · 조직명 · usage_month (YYYY-MM, UTC) · 결제 연동 상태.
- 사용량 6 cards: 각 항목의 현재/한도 + progress bar. 80% 이상 amber, 초과는 rose. enterprise는 한도 없음 표시. soft cap에는 "(참고용)" 라벨.
- 청구 정보 form: 사업자등록번호(64자 이내) + 세금계산서 이메일. 빈 문자열 저장 시 null로 정리됩니다.
- 결제 연동 안내: "결제 연동은 아직 준비 중입니다. 운영팀(support@kloser.com)으로 문의해 주세요."

### 11.4 보안 정책

- 응답에는 외부 provider id(`external_customer_id` / `external_subscription_id` / `external_provider`)와 `metadata`가 **노출되지 않습니다**. 대신 `external_provider_configured` boolean 하나만 제공.
- 청구 정보 PATCH의 audit row는 변경된 필드 **이름만** 적습니다. 사업자등록번호, 이메일 값은 audit에 남지 않습니다.
- 모든 서버 값은 frontend에서 `textContent` 또는 input.value setter로만 주입합니다. 사업자등록번호에 `<script>` 같은 페이로드를 저장해도 화면에는 텍스트로만 보입니다.

### 11.5 cap 초과 응답 (REST + WS 공통)

```json
{
  "error": "plan_limit_exceeded",
  "code": "plan_limit_exceeded",
  "limit_key": "seats",
  "plan": "starter",
  "current": 2,
  "limit": 2,
  "attempted": 3
}
```

---

## 12. Phase 7 검증 명령

다음 명령이 모두 PASS인 상태를 closeout 시점에 확인했습니다 (2026-05-18).

```bash
npm --prefix server run typecheck            # PASS
npm --prefix server run db:migrate:up        # No migrations to run!
node test/sync_shared_types.mjs              # PASS

npm --prefix server test                      # 769/772 PASS (3 skipped, 0 fail)

# Step 단위 회귀가 필요하면 phase7_step*_*.test.mjs / phase7_email_*.test.mjs 개별 실행
```

Playwright manual smoke (Step 9 시점 마지막):

- admin desktop / mobile: 플랜 사용량 카드 6장, plan/status 정상.
- employee desktop / mobile: 정적 "권한 없음" 패널, JS uncaught error 없음.
- 사업자등록번호 `<script>window.__XSS=true</script>` 페이로드: input.value로만 저장, 페이지 body HTML에 raw script 미노출, `window.__XSS===false`.

---

## 13. 다음 Phase 인계

운영 출시 직전 게이트가 모두 닫혔습니다. 다음 작업 후보는:

- **결제 provider 연동** (별도 Phase) — Stripe Checkout 또는 Toss 결제 위젯. Step 9의 `external_*` 컬럼 자리에 webhook으로 customer/subscription을 연결. 외부 돈 이동과 회계 계약을 수반하므로 본 repo의 Phase 7과 분리.
- **Phase 8 — call recording** — 녹취 audio storage (S3/MinIO) + 통화 페이지 playback. Step 4 retention 워커에 90일 cutoff 추가.

자세한 인계 노트는 `docs/plan/phase-7/PHASE_7_CLOSEOUT_FINDINGS.md §7`을 참고하세요.
