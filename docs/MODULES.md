# MODULES.md — public contracts per module

Status: **planned API (design-level)**. Each phase replaces "planned" with the real signatures when implemented.
Only symbols exported from a module's `index.ts` are public. Update this file whenever a public API changes.

## types (L0) — P1-T01
`RunId, AgentId, SessionId, TurnId, ToolCallId, EventId` branded string types; `newRunId(idGen)`, `parseRunId(s)`; zod schemas for each.

## errors (L0) — P1-T02
`class AirError extends Error { code; retryable; exposeToModel; context?; cause? }`, `ErrorCode` union, `isAirError(e)`, `toModelSafe(e)`, `serializeError(e)`.

## util (L0) — P1-T03/T04
`Clock {now(): Date; monotonicMs(): number}`, `SystemClock`, `FakeClock`; `Random`, `SeededRandom`; `IdGenerator`; `sleep(ms, signal)`; `backoff(attempt, opts)`;
`paths`: `canonicalize(p)`, `isInside(root, p)`, `assertInside(root, p)`, `rejectUnsafeName(name)`; `fsSafe`: `readFileIn(root,p)`, `writeFileAtomicIn(root,p,data)`, `listIn`, `globIn`.

## config (L1) — P1-T05
`loadConfig({argv, env, home}): Promise<AirConfig>`, `AirConfigSchema`, `explainConfig(key)`, `resolveAirHome()`, `migrateConfig(raw)`.

## secrets (L1) — P1-T09
`SecretStore {get(name); set(name,value); delete(name)}`, `CredentialManagerStore`, `MemorySecretStore`, `redactor.register(name, value)`, `redactor.redact(value)`.

## observability (L1) — P1-T06..T08
`getLogger(component)`, `withContext(ctx, fn)`, `currentContext()`, `initLogging(config, deps)`, `AuditLog.append(rec)`, `verifyAuditChain(file)`, `metrics.counter/gauge/histogram`, `withSpan(name, fn)`.

## journal (L2) — P2
`EventEnvelope`, `EventRegistry`, `Journal.append(stream, type, payload, ctx)`, `Journal.read(stream, range)`, `Journal.subscribe(filter)`, `replay(stream, reducer)`, `recoverJournal(dir)`, `EventBus`.

## policy (L3) — P5
`Capability`, `PolicyEngine.decide(input): Decision`, `loadPolicy(file)`, `lintPolicy(doc)`, `ApprovalBroker.request/resolve/list`, `Budget`, `BudgetTracker`, `Taint`, `fence(output)`.

## sandbox (L3) — P7
`ProcessRunner.run(spec, {signal}): Promise<ProcessResult>`, `SandboxHelperClient`, `ReapOrphans()`.

## providers (L3) — P3
`Provider`, `NormalizedRequest`, `ProviderEvent`, `createProvider(config)`, `ResilientProvider`, `MockProvider` (scripted), `CostTracker`.

## memory (L3) — P8
`MemoryStore.write/search/forget`, `retrieveForContext(query, tokenBudget)`.

## tools (L4) — P4
`ToolDefinition<I,O>`, `ToolRegistry`, `ToolExecutor.execute(call, ctx)`, built-ins `fs.*`, `exec.run`, `http.fetch`, `user.ask`, `plan.update`, `run.finish`.

## mcp (L4) — P10
`McpClient`, `importMcpTools(server, registry)`.

## agent (L5) — P6
`AgentManifest`, `loadAgent(file)`, `RunStateMachine`, `TurnEngine.run(run, deps)`, `assembleContext()`, `replayRun(runId)`.

## kernel (L6) — P11 (basic wiring in P6/P9)
`Kernel.start/stop`, `Supervisor.spawn(parent, manifest, budget)`, `Scheduler`, `RunRegistry`.

## ipc (L7) — P9-T01
`IpcServer`, `IpcClient`, protocol zod schemas, method registry (see `docs/specs/ipc.md`).

## service (L8) — P9-T02 / P12-T01
`aird` entrypoint: `main()`, boot sequence, health, shutdown, Windows Service integration.

## shell (L8) — P9-T04/T05
`air` entrypoint: commands, REPL, renderers, approval prompts.
