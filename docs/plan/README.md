# Kloser plan index

`docs/plan`은 실행 계획과 결과 인계 문서만 둔다. 상위 로드맵은 `roadmap/`, 완료된 phase별 문서는 `phase-*` 폴더에 보관한다.

## Structure

| Folder | Contents |
|---|---|
| [`roadmap/`](roadmap/) | 전체 백엔드 로드맵과 별도 데스크톱 앱 트랙 |
| [`phase-0.5/`](phase-0.5/) | live stream spike 계획과 findings |
| [`phase-1/`](phase-1/) | 온프레미스 기반 + 자체 Auth 계획과 Step 1~5 findings |
| [`phase-2/`](phase-2/) | Customers CRUD 계획과 Step 1~6 findings |
| [`phase-3/`](phase-3/) | 회원가입 · 이메일 인증 · 비밀번호 재설정 · 팀/초대 계획/결과 |
| [`phase-4/`](phase-4/) | calls / transcripts 영속화 + dashboard 실 KPI 전환 계획·결과 (Step 1~5 완료, 통합 e2e 8 시나리오 PASS) |
| [`phase-5/`](phase-5/) | knowledge base · checklist · suggestion persistence · call detail 계획/결과 |
| [`phase-6/`](phase-6/) | worker runtime · real provider adapters · action item delete · manager reports 계획/결과 |
| [`phase-7/`](phase-7/) | 운영 출시 게이트: email delivery · MFA · audit · retention 계획 |

## Current Entry Points

| Need | Document |
|---|---|
| Overall backend roadmap | [`roadmap/BACKEND_PLAN.md`](roadmap/BACKEND_PLAN.md) |
| Desktop app track | [`roadmap/DESKTOP_APP_PLAN.md`](roadmap/DESKTOP_APP_PLAN.md) |
| Phase 1 status | [`phase-1/PHASE_1_MASTER.md`](phase-1/PHASE_1_MASTER.md) |
| Phase 2 status | [`phase-2/PHASE_2_MASTER.md`](phase-2/PHASE_2_MASTER.md) |
| Phase 3 status (complete) | [`phase-3/PHASE_3_MASTER.md`](phase-3/PHASE_3_MASTER.md) + [`phase-3/PHASE_3_STEP_7_FINDINGS.md`](phase-3/PHASE_3_STEP_7_FINDINGS.md) |
| Phase 4 status (complete) | [`phase-4/PHASE_4_MASTER.md`](phase-4/PHASE_4_MASTER.md) + [`phase-4/PHASE_4_STEP_5_FINDINGS.md`](phase-4/PHASE_4_STEP_5_FINDINGS.md) |
| Phase 5 status (complete) | [`phase-5/PHASE_5_MASTER.md`](phase-5/PHASE_5_MASTER.md) + [`phase-5/PHASE_5_STEP_5_FINDINGS.md`](phase-5/PHASE_5_STEP_5_FINDINGS.md) |
| Phase 6 status (complete) | [`phase-6/PHASE_6_MASTER.md`](phase-6/PHASE_6_MASTER.md) + [`phase-6/PHASE_6_STEP_5_FINDINGS.md`](phase-6/PHASE_6_STEP_5_FINDINGS.md) |
| Phase 7 current entry point | [`phase-7/PHASE_7_MASTER.md`](phase-7/PHASE_7_MASTER.md) + [`phase-7/PHASE_7_STEP_1_PLAN.md`](phase-7/PHASE_7_STEP_1_PLAN.md) |
| Final `customers.plan` decision | [`phase-2/PHASE_2_STEP_5_FINDINGS.md`](phase-2/PHASE_2_STEP_5_FINDINGS.md) |
| Phase 2 closure findings | [`phase-2/PHASE_2_STEP_6_FINDINGS.md`](phase-2/PHASE_2_STEP_6_FINDINGS.md) |

## Naming Rule

- Master documents: `PHASE_N_MASTER.md`
- Step plans: `PHASE_N_STEP_X_<TOPIC>.md`
- Step handoff/results: `PHASE_N_STEP_X_FINDINGS.md`
- Keep filenames stable when moving documents; update references in the same change.
