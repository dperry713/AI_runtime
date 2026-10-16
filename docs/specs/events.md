# Event Specification & Schema Registry (`docs/specs/events.md`)

This document defines the formal schema, envelope format, and additive versioning rules for the AIR Event-Sourced Journal (Rule R8: *Every state change that matters is a journal event*).

---

## 1. Event Envelope Specification

Every journal event is encapsulated in an immutable, canonical envelope:

```typescript
export interface EventEnvelope<T = unknown> {
  /** Unique event identifier (ULID, monotonic per generator). */
  readonly id: EventId;
  /** Logical stream identifier (e.g. "run:<runId>", "session:<sessionId>", "system"). */
  readonly stream: string;
  /** Monotonic gapless sequence number strictly incrementing per stream (starts at 1). */
  readonly seq: number;
  /** UTC ISO-8601 creation timestamp from injected Clock. */
  readonly ts: string;
  /** Namespaced event type descriptor (e.g. "run.created", "tool.started"). */
  readonly type: string;
  /** Strongly-typed domain payload matching the event type schema. */
  readonly payload: T;
  /** Correlation and tracing metadata context. */
  readonly meta?: EventMeta | undefined;
}
```

### Metadata Context (`EventMeta`)
```typescript
export interface EventMeta {
  readonly sessionId?: SessionId | undefined;
  readonly runId?: RunId | undefined;
  readonly agentId?: AgentId | undefined;
  readonly turnId?: TurnId | undefined;
  readonly toolCallId?: ToolCallId | undefined;
  readonly traceId?: string | undefined;
  readonly spanId?: string | undefined;
  readonly causationId?: EventId | undefined;
  readonly correlationId?: string | undefined;
}
```

---

## 2. Event Taxonomy & Core Catalogs

All event types are strictly namespaced `<category>.<action>`:

### 2.1 Run Lifecycle (`run.*`)
- `run.created`: Initial run creation with goal, configuration, and parent link.
- `run.starting`: Run initialization sequence underway.
- `run.running`: Run active and executing turns.
- `run.paused`: Run paused by operator or policy.
- `run.resumed`: Run unpaused.
- `run.waiting_approval`: Run blocked awaiting operator approval for a high-risk tool call.
- `run.waiting_user`: Run blocked awaiting human input/clarification.
- `run.completed`: Run finished successfully with final result.
- `run.failed`: Run terminated due to an unrecoverable failure.
- `run.cancelled`: Run terminated by explicit cancellation signal.
- `run.budget_exceeded`: Run terminated due to budget depletion (tokens, wall clock, tool cost, steps).

### 2.2 Turn Lifecycle (`turn.*`)
- `turn.started`: Agent loop turn iteration begins.
- `turn.completed`: Turn finished successfully.
- `turn.failed`: Turn encountered error.

### 2.3 Model / Provider Lifecycle (`model.*`)
- `model.requested`: LLM inference request sent (prompt tokens, parameters).
- `model.responded`: LLM response received (completion tokens, stop reason, duration).
- `model.failed`: LLM call failed or timed out.

### 2.4 Tool Execution Lifecycle (`tool.*`)
- `tool.requested`: Model requests tool call with arguments.
- `tool.policy_decided`: Policy engine evaluated request (`allow`, `deny`, `ask`).
- `tool.approval_requested`: Escalated to operator approval.
- `tool.approved`: Operator approved execution.
- `tool.denied`: Operator or policy denied execution.
- `tool.started`: Execution initiated in sandbox (write-ahead rule).
- `tool.output`: Incremental streamed output chunks.
- `tool.completed`: Tool finished with exit code and return value.
- `tool.failed`: Tool execution failed.
- `tool.cancelled`: Tool execution cancelled before/during run.
- `tool.timed_out`: Tool exceeded configured execution timeout.

### 2.5 Memory Lifecycle (`memory.*`)
- `memory.written`: Entry saved to contextual memory store.
- `memory.searched`: Semantic/FTS search performed.
- `memory.forgotten`: Entry deleted / forgotten.

### 2.6 System Lifecycle (`system.*`)
- `system.started`: Daemon host started.
- `system.shutdown`: Graceful daemon shutdown.
- `system.recovered`: Journal crash recovery performed (tail truncated / index rebuilt).
- `system.quarantine`: Corrupted journal segment quarantined.

---

## 3. Additive Versioning Rules

All schemas in `src/journal/` adhere to strict forward and backward compatibility:

1. **No Field Removals:** Existing payload fields can never be deleted within a schema version.
2. **Optional New Fields:** New fields added to existing event types must be optional (`.optional()`) or define sensible defaults (`.default(...)`).
3. **Immutable Semantics:** The semantic meaning and data type of existing fields cannot be altered.
4. **Discriminated Union Safety:** Consumers and projections must handle unknown future event types gracefully without crashing (ignoring unrecognized events or passing through).
5. **Upcaster Migrations:** Breaking changes or schema version bumps (e.g. payload v1 to v2) require an explicit upcaster transformation registered in the upcaster pipeline (P2-T07).
