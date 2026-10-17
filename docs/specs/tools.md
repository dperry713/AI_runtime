# Tool Contract & Execution Specification (`docs/specs/tools.md`)

This document defines the formal contract, risk classification, capability derivation, execution context, and JSON Schema mapping for tools in AIR (AI Runtime).

---

## 1. Tool Contract Overview

Every tool available to an agent or LLM in AIR is defined via a `ToolDefinition<TInput, TOutput>`:

```typescript
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly version?: string | undefined;
  readonly risk: ToolRiskLevel;
  readonly idempotent: boolean;
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema?: z.ZodType<TOutput> | undefined;
  readonly capabilities?: ((args: TInput) => readonly ToolCapability[]) | undefined;
  readonly execute: (args: TInput, ctx: ToolExecutionContext) => Promise<TOutput>;
}
```

---

## 2. Risk Classification (`ToolRiskLevel`)

All tools declare an intrinsic risk level used by the policy engine:

| Risk Level | Definition | Examples | Approval Default |
|---|---|---|---|
| `low` | Read-only, deterministic, zero side-effects on host or external systems. | `fs.read`, `fs.list`, `fs.stat`, `fs.glob`, `fs.grep` | `allow` |
| `medium` | Reversible or scoped local side-effects within the workspace boundary. | `fs.write`, `fs.edit`, `fs.mkdir`, `fs.move`, `plan.update` | `allow` (within project) |
| `high` | Out-of-band external network requests, command execution, or irreversible modifications. | `exec.run`, `http.fetch`, `fs.delete` | `ask` (in interactive) |
| `critical` | High-privilege system modifications, process control, or sensitive credential access. | Unrestricted shell, system service control | `deny` / strict confirmation |

---

## 3. Tool Capability Derivation

To allow granular policy governance without parsing raw tool arguments inside the policy engine, tools implement `capabilities(args: TInput)`:

```typescript
export interface ToolCapability {
  readonly type: string;        // e.g. "fs", "net", "exec"
  readonly action?: string;     // e.g. "read", "write", "spawn"
  readonly resource?: string;   // e.g. "c:/dev/project/src/index.ts", "api.github.com"
  readonly meta?: Record<string, unknown>;
}
```

For example, `fs.write` with `{ path: "foo.txt" }` emits:
`[{ type: "fs", action: "write", resource: "foo.txt" }]`

---

## 4. Execution Context (`ToolExecutionContext`)

Injected by `ToolExecutor` into every invocation:

- `callId`: Unique ULID for this tool call.
- `runId`: Active run identifier.
- `sessionId`: Optional session context.
- `agentId`: Invoking agent identifier.
- `signal`: `AbortSignal` for cooperative cancellation and timeout termination.
- `clock`: Injected `Clock` (Rule R6: no raw `Date.now()`).
- `random`: Injected `Random` (Rule R6: no raw `Math.random()`).
- `timeoutMs`: Effective invocation timeout.
- `maxOutputBytes`: Effective byte limit for truncation.
- `workspaceRoot`: Working directory jail path.

---

## 5. JSON Schema Derivation for LLM Tool Calling

Tools use `deriveJsonSchema(tool.inputSchema)` to automatically produce JSON Schema definitions for provider requests:

- Automatically cleans internal `$schema` and `additionalProperties` constraints.
- Maps Zod string, number, boolean, array, enum, object, and optional types.
- Preserves Zod `.describe(...)` comments for LLM argument descriptions.
- Converted via `toProviderToolDefinition(tool)` into `ProviderToolDefinition` ready for Anthropic, OpenAI, and Ollama adapters.

---

## 6. Validation & Error Invariants

1. **Input Validation**: `validateToolInput(tool, rawArgs)` validates raw input against `tool.inputSchema`. If validation fails, throws typed `AirError('INVALID_ARGUMENT')` with context.
2. **Output Validation**: If `tool.outputSchema` is provided, `validateToolOutput(tool, rawOutput)` validates the returned output. If validation fails, throws typed `AirError('INTERNAL')`.
3. **Execution Errors**: Any runtime error during execution is normalized into an `AirError` with appropriate error code.
