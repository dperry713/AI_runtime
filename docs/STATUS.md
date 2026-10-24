# STATUS.md — AIR build status

## Current Phase
**P9 — Daemon, IPC, shell** (MEC: LOCKED 2026-10-19)

## Phase Health
| Phase | Status | Tasks Done/Total | Notes |
|---|---|---|---|
| P0–P8 | DONE | 71/71 | All exit gates passed |
| P9 | DONE | 6/7 | P9-T01–T05, P9-T07 DONE; P9-T06 (Optional TUI) DEFERRED |
| P10 | TODO | 0/4 | Not started |
| P11 | TODO | 0/5 | Not started |
| P12 | TODO | 0/7 | Not started |

## Overall Progress
77 / 94 tasks done (81.9%)

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
`npm run check` — typecheck PASS, lint PASS, deps:check 1 pre-existing violation (credential-manager.ts → sandbox/index.ts layer violation), npm test: all tests pass (1549 passed, 3 skipped), including 14/14 ETW tests, 7/7 secrets tests, 7/7 WFP tests, 6/6 AppContainer tests.
