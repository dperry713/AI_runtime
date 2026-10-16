# DIRECTORY.md — repository layout (current + planned)

Legend: **[exists]** created in Phase 0 · **[planned: Pn-Tnn]** created by that task.

```
AI_runtime\
├─ AGENTS.md                         [exists] entry point for any agent
├─ CLAUDE.md                         [exists] pointer to AGENTS.md
├─ BUILD_STATUS.md                   [exists] live progress tracker (update every session)
├─ package.json / tsconfig*.json     [exists]
├─ vitest.config.ts                  [exists]
├─ eslint.config.js, .prettierrc.json[exists]
├─ .dependency-cruiser.cjs           [exists] layer + builtin-usage rules (violation-fixture test: P0-T07)
├─ .gitignore .gitattributes .editorconfig [exists]
├─ config\
│  └─ air.config.example.json        [exists]
├─ docs\
│  ├─ PROJECT.md ARCHITECTURE.md BUILD_PLAN.md TESTING.md LOGGING.md SECURITY.md MODULES.md DIRECTORY.md [exists]
│  ├─ adr\                           [exists] 0000-template, 0001..0004
│  ├─ specs\                         events.md [P2-T01] · ipc.md [P9-T01] · policy.md [P5-T02] · sandbox-protocol.md [P7-T02] · tools.md [P4-T01]
│  └─ runbooks\                      incident-response.md, troubleshooting.md, upgrade.md [P12-T06]
├─ scripts\
│  ├─ bootstrap.ps1 check.ps1 doctor.ps1 test.ps1   [exists]
│  └─ install-service.ps1 uninstall-service.ps1 build-native.ps1 [P12-T01 / P7-T02]
├─ .github\workflows\ci.yml          [exists]
├─ native\                           [planned: P7-T02]
│  └─ air-sandbox\                   Rust crate: Job Objects, restricted token, jail launcher
├─ src\
│  ├─ index.ts                       [exists] version export (smoke)
│  ├─ types\        ids.ts events.ts index.ts                          [P1-T01]
│  ├─ errors\       air-error.ts codes.ts index.ts                     [P1-T02]
│  ├─ util\         clock.ts random.ts id.ts sleep.ts backoff.ts       [P1-T03]
│  │                paths.ts fs-safe.ts abort.ts index.ts              [P1-T04]
│  ├─ config\       schema.ts loader.ts home.ts explain.ts migrate.ts index.ts   [P1-T05]
│  ├─ secrets\      store.ts credential-manager.ts memory-store.ts redactor.ts index.ts  [P1-T09]
│  ├─ observability\logger.ts context.ts redaction.ts streams.ts rotation.ts   [P1-T06]
│  │                audit.ts metrics.ts tracing.ts index.ts            [P1-T07/T08]
│  ├─ journal\      envelope.ts registry.ts writer.ts segments.ts index-db.ts   [P2]
│  │                bus.ts reader.ts replay.ts recovery.ts upcasters.ts migrations\ index.ts
│  ├─ providers\    types.ts mock.ts anthropic.ts openai-compat.ts ollama.ts    [P3]
│  │                resilience.ts cost.ts recorder.ts index.ts
│  ├─ policy\       capability.ts rules.ts engine.ts approvals.ts budgets.ts taint.ts profiles\ index.ts [P5]
│  ├─ sandbox\      runner.ts helper-client.ts jail.ts reaper.ts index.ts       [P7]
│  ├─ memory\       store.ts sqlite-store.ts embeddings.ts retrieval.ts write-policy.ts migrations\ index.ts [P8]
│  ├─ tools\        contract.ts registry.ts executor.ts index.ts        [P4]
│  │  └─ builtin\   fs.ts exec.ts http.ts interaction.ts index.ts
│  ├─ mcp\          client.ts import.ts index.ts                        [P10]
│  ├─ agent\        manifest.ts run-state.ts turn-engine.ts context.ts compaction.ts stall.ts replay.ts index.ts [P6]
│  ├─ kernel\       kernel.ts supervisor.ts scheduler.ts registry.ts index.ts   [P6/P11]
│  ├─ ipc\          protocol.ts server.ts client.ts pipe-acl.ts index.ts [P9-T01]
│  ├─ service\      main.ts boot.ts health.ts windows-service.ts         [P9-T02/P12]
│  └─ shell\        main.ts repl.ts commands\ render.ts approvals-ui.ts  [P9-T04/T05]
├─ tests\
│  ├─ unit\         smoke.test.ts [exists] + <module>\*.test.ts
│  ├─ integration\  journal\ providers\ tools\ config\ ...
│  ├─ e2e\          daemon-shell\ agent-runs\ ...
│  ├─ chaos\        journal-kill\ provider-faults\ recovery\ ...
│  ├─ security\     paths\ exec\ sandbox\ injection\ secrets\ bypass\ ssrf\ mcp\ audit\ memory\
│  ├─ perf\         bench\ soak\
│  ├─ eval\         agent-tasks\ retrieval\
│  ├─ fixtures\     transcripts\ configs\ policies\ corpora\
│  └─ helpers\      fake-clock.ts temp-home.ts scripted-provider.ts log-capture.ts mock-mcp.ts pipe-name.ts
└─ var\                              dev/test scratch (git-ignored): logs\ test-tmp\ test-logs\ check-logs\
```

Runtime data (NOT in repo): `%LOCALAPPDATA%\AIR\` — see `docs/PROJECT.md` §9.

Empty directories exist on disk but are not tracked by git until their first file is added in the owning phase.
