# Kloser plan index

`docs/plan`은 실행 계획과 결과 인계 문서만 둔다. 상위 로드맵은 `roadmap/`, 완료된 phase별 문서는 `phase-*` 폴더에 보관한다.

## Structure

| Folder | Contents |
|---|---|
| [`roadmap/`](roadmap/) | 전체 백엔드 로드맵과 별도 데스크톱 앱 트랙 |
| [`phase-0.5/`](phase-0.5/) | live stream spike 계획과 findings |
| [`phase-1/`](phase-1/) | 온프레미스 기반 + 자체 Auth 계획과 Step 1~5 findings |
| [`phase-2/`](phase-2/) | Customers CRUD 계획과 Step 1~6 findings |

## Current Entry Points

| Need | Document |
|---|---|
| Overall backend roadmap | [`roadmap/BACKEND_PLAN.md`](roadmap/BACKEND_PLAN.md) |
| Desktop app track | [`roadmap/DESKTOP_APP_PLAN.md`](roadmap/DESKTOP_APP_PLAN.md) |
| Phase 1 status | [`phase-1/PHASE_1_MASTER.md`](phase-1/PHASE_1_MASTER.md) |
| Phase 2 status | [`phase-2/PHASE_2_MASTER.md`](phase-2/PHASE_2_MASTER.md) |
| Final `customers.plan` decision | [`phase-2/PHASE_2_STEP_5_FINDINGS.md`](phase-2/PHASE_2_STEP_5_FINDINGS.md) |
| Phase 2 closure findings | [`phase-2/PHASE_2_STEP_6_FINDINGS.md`](phase-2/PHASE_2_STEP_6_FINDINGS.md) |

## Naming Rule

- Master documents: `PHASE_N_MASTER.md`
- Step plans: `PHASE_N_STEP_X_<TOPIC>.md`
- Step handoff/results: `PHASE_N_STEP_X_FINDINGS.md`
- Keep filenames stable when moving documents; update references in the same change.
