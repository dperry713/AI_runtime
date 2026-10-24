# STATUS.md — AIR build status

## Current Phase
**P12 — Hardening, packaging, release** (MEC: LOCKED 2026-10-19)

## Phase Health
| Phase | Status | Tasks Done/Total | Notes |
|---|---|---|---|
| P0–P8 | DONE | 71/71 | All exit gates passed |
| P9 | DONE | 6/7 | P9-T01–T05, P9-T07 DONE; P9-T06 (Optional TUI) DEFERRED |
| P10 | DONE | 4/4 | P10-T01–P10-T04 DONE. Exit Gate P10 passed. |
| P11 | DEFERRED | 0/5 | Deferred post-v1 per user directive |
| P12 | DONE | 7/7 | P12-T01–P12-T07 DONE. Exit Gate P12 passed; v1.0 release candidate verified. |

## Overall Progress
88 / 94 tasks done (93.6% — Phases 0–10 and Phase 12 complete; Phase 11 deferred post-v1)

## Windows Security Hardening (MEC-WINDOWS-SECURITY.md, LOCKED 2026-10-24)
| Phase | Name | Status | Requirements |
|---|---|---|---|
| W1 | WFP egress enforcement | DONE | R-001, R-002 |
| W2 | AppContainer default sandbox | DONE | R-003, R-004, R-005 |
| W3 | Windows-native secrets | DONE | R-006, R-007 |
| W4 | ETW telemetry | DONE | R-008, R-009 |
| W5 | Packaging + Windows Service | DONE | R-010, R-011, R-012 |
| W6 | Group Policy / ADMX | TODO | R-013, R-014 |
| W7 | AMSI / Defender | TODO | R-015, R-016 |

## Blockers
None.

## Last Verification
`npm run check` — typecheck PASS (0 errors), lint PASS (0 errors), deps:check PASS (0 violations across 162 modules), npm test PASS (99 test files passed, 1,699 passed, 3 skipped).
`npm run test:e2e` — PASS (4 passed).
`npm run test:security` — PASS (77 passed).
`npm run test:chaos` — PASS (7 passed).
`npm run test:benchmark` — PASS (48 passed).
`scripts/benchmark.ps1 -Iterations 3` — PASS (100% pass rate, p50: ~2.3s).
`npm run test:coverage` — PASS (Statements 88.54% ≥ 85%, Branches 80.21% ≥ 80%, Functions 90.38% ≥ 85%, Lines 89.51% ≥ 85%).
Total Automated Tests: **1,787 passed, 3 skipped across 106 test files**.
Release Tag: **v1.0.0** (released 2026-10-24 with release notes and gate log attached).
