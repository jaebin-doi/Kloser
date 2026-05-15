# Phase 7 UI / Backend Status

작성일: 2026-05-15

이 문서는 Phase 7 진행 상황, 현재 백엔드와 프론트엔드의 차이, 그리고 Phase 7 완료까지 남은 작업을 정리한다.

## 1. 프로젝트 현재 위치

Kloser는 B2B 영업/상담 조직을 위한 AI 콜 어시스턴트 SaaS다.

현재 구조:

- Frontend: `platform/*.html` 정적 HTML + vanilla JS
- Backend: Fastify + PostgreSQL + RLS + Socket.io
- Auth: 자체 JWT + refresh session family rotation
- DB: organization-scoped RLS 중심
- Tests: backend unit/route/e2e 중심

제품 흐름:

1. 고객, 팀, 권한을 관리한다.
2. 상담자가 실시간 통화를 진행한다.
3. STT가 발화를 받고 AI가 실시간 제안, 체크리스트, 요약, 액션 아이템을 만든다.
4. 통화 종료 후 기록, 액션 아이템, 리포트로 이어진다.
5. 운영 출시를 위해 이메일, MFA, 감사 로그, 보존 정책 같은 보안/운영 장치를 붙인다.

## 2. Phase 전체 진행 요약

| Phase | 내용 | 상태 |
|---|---|---|
| Phase 0.5 | 실시간 통화 spike, WebSocket 기반 live flow 검증 | 완료 |
| Phase 1 | DB/RLS/Auth/Core infra, login/refresh/logout | 완료 |
| Phase 2 | Customers API/CRUD/frontend/e2e | 완료 |
| Phase 3 | Signup, email verify, password reset, team/member/invite | 완료 |
| Phase 4 | Calls, transcripts, action items, dashboard/calls frontend | 완료 |
| Phase 5 | Live call persistence, checklist/suggestions/knowledge base/search | 완료 |
| Phase 6 | Worker infra, AI provider abstraction, usage logging, reports/action item delete | 완료 |
| Phase 7 | 운영 출시 게이트: email, MFA, audit, retention, 운영 UX | 진행 중 |

Phase 7은 새 제품 기능을 크게 늘리는 단계라기보다, 운영 가능한 MVP로 닫기 위한 보안/운영 마감 단계다.

현재 계획상 Phase 7이 마지막 명시 Phase다. Phase 8 계획은 아직 없다.

## 3. Phase 7 범위

| Step | 내용 | 상태 |
|---|---|---|
| Step 1 | 실제 이메일 발송, Resend provider, transactional outbox, retry/dead-letter, sensitive payload encryption | 완료 |
| Step 2 | TOTP MFA, 조직 MFA required, MFA login/session/refresh hardening | 백엔드 대부분 완료, 프론트 연결 남음 |
| Step 3 | `activity_log` 기반 감사 로그 | 미시작 |
| Step 4 | transcript/recording retention cron | 미시작 |
| Step 5+ | 비용 계산, role-based sidebar, report drilldown, demo-to-real cleanup, billing/caps | 우선순위 결정 필요 |

## 4. Phase 7 Step 2 MFA 현재 상태

백엔드에서 완료된 항목:

- MFA schema
- MFA repositories/unit tests
- TOTP helper
- MFA secret encryption helper
- login MFA challenge
- `/auth/mfa/totp/verify-login`
- refresh MFA gating
- login-time setup/confirm challenge
- authenticated MFA setup/confirm/disable
- organization security API
- auth MFA shared types

주요 API:

- `POST /auth/login`
- `POST /auth/mfa/totp/verify-login`
- `POST /auth/mfa/totp/setup-challenge`
- `POST /auth/mfa/totp/confirm-challenge`
- `POST /auth/mfa/totp/setup`
- `POST /auth/mfa/totp/confirm`
- `DELETE /auth/mfa/totp`
- `GET /organization/security`
- `PATCH /organization/security`

## 5. UI에서 실제로 되는 것

| 화면 | 실제 동작 여부 | 설명 |
|---|---:|---|
| `login.html` | 부분 동작 | 일반 email/password 로그인은 동작. MFA `202` 응답 처리는 아직 연결되지 않음. |
| `signup.html` | 동작 | 회원가입 API 연결됨. |
| `verify.html` | 동작 | 이메일 인증 API 연결됨. |
| `forgot-password.html` | 동작 | 비밀번호 재설정 요청 API 연결됨. |
| `reset-password.html` | 동작 | 비밀번호 재설정 API 연결됨. |
| `accept-invitation.html` | 동작 | 초대 수락 API 연결됨. |
| `customers.html` | 동작 | 고객 목록/검색/통계/생성/수정/삭제 API 연결됨. |
| `team.html` | 동작 | 팀, 멤버, 초대, 역할 변경, 비활성화 API 연결됨. |
| `dashboard.html` | 부분 동작 | KPI와 최근 통화는 `/dashboard/summary` API. 일부 시장 인텔/추천 To-Do는 demo. |
| `calls.html` | 대부분 동작 | 통화 목록/상세/메모/요약/의사/action item/suggestion 등 API 연결됨. CSV export 등 일부는 미구현/demo. |
| `live.html` | 부분 동작 | WebSocket 통화 시작/종료, transcript, suggestion, checklist, 고객 연결 등 실제 경로. 실제 오디오 캡처/녹음 UX는 demo 또는 미구현. |
| `reports.html` | 부분 동작 | 팀 리포트 summary API 연결됨. 날짜 범위/agent drilldown 같은 고급 분석은 부족. |
| `settings.html` | 부분 동작 | 로그아웃, knowledge base, checklist template 일부 API. 보안/MFA/세션/API 키/SSO/알림/결제/보존 정책은 대부분 미연결. |
| `daily.html` | 대부분 demo | 시장 동향, 추천 To-Do, 경쟁사 동향 등은 prototype/demo 성격. |
| `newsletter.html` | 대부분 demo | 실제 newsletter backend와 연결된 상태가 아님. |

## 6. 백엔드에는 있지만 UI에 아직 없는 기능

| 백엔드 기능 | 백엔드 상태 | UI 상태 |
|---|---:|---:|
| TOTP MFA login challenge | 구현/커밋됨 | `login.html` 미연결 |
| `/auth/mfa/totp/verify-login` | 구현/커밋됨 | UI 없음 |
| 로그인 중 MFA 등록 `setup-challenge/confirm-challenge` | 구현/커밋됨 | UI 없음 |
| 로그인 후 MFA setup/confirm/disable | 구현/커밋됨 | `settings.html` 미연결 |
| refresh MFA gate | 구현/커밋됨 | 별도 UI 없음. refresh 실패 시 로그인으로 이동하는 처리 필요 |
| org MFA required 설정 API | 구현/커밋됨 | `settings.html` 미연결 |
| email delivery worker / Resend | 구현/커밋됨 | 관리 UI 없음. verify/reset/invite 흐름에서 내부 사용 |
| activity_log | 미구현 | dashboard/settings의 감사 로그는 아직 실제 API 없음 |
| retention cron | 미구현 | settings의 보존 정책 UI는 아직 실제 API 없음 |

가장 큰 불일치는 MFA다. 백엔드는 MFA 요구 응답을 반환할 수 있지만, 현재 `login.html`은 그 응답을 사용자가 입력 가능한 TOTP 화면으로 이어주지 못한다.

## 7. 남은 우선순위

현재 기준 다음 작업 순서:

1. `platform/api.js`에 MFA/organization security helper 추가
2. `platform/login.html`에 MFA required / setup required flow 연결
3. `platform/settings.html`에 사용자 MFA setup/confirm/disable 연결
4. `platform/settings.html`에 admin org MFA required toggle 연결
5. Phase 7 Step 2 findings 작성
6. Phase 7 Step 3 `activity_log` 시작
7. Phase 7 Step 4 retention cron 시작
8. 남은 demo 영역 중 운영 출시 전에 반드시 닫을 범위 결정

## 8. Phase 7이 끝나면 해야 할 일

Phase 7이 끝나면 바로 Phase 8로 넘어간다고 보면 안 된다. 현재는 Phase 8 계획이 없으므로, Phase 7 종료 후에는 다음을 먼저 해야 한다.

1. 전체 backend/frontend 회귀 검증
2. demo 데이터와 실제 API 경계 재점검
3. 운영 환경 설정값 점검
4. 보안 체크리스트 점검
5. MVP launch checklist 작성
6. 필요한 경우 그 결과로 Phase 8 또는 Launch Hardening 계획 작성

## 9. 결론

현재 백엔드는 운영 가능한 보안/업무 API가 많이 완성된 상태다. 반면 프론트엔드는 주요 업무 화면 일부는 실제 API에 연결되어 있지만, MFA와 조직 보안 설정은 아직 UI에 연결되지 않았다.

가장 먼저 닫아야 할 작업은 MFA와 organization security의 프론트 연결이다. 이 작업이 끝나야 Phase 7 Step 2를 사용자 관점에서 완료라고 볼 수 있다.
