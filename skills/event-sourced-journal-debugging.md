# Event-Sourced Journal Debugging

## Mission

Investigate append-only journal, SQLite index, replay, correlation, and audit-integrity defects. The journal is a source of truth: repair procedures must preserve evidence and never silently rewrite history.

## Triage and evidence preservation

- Copy the journal, index database, configuration, and relevant logs before attempting recovery.
- Record file sizes, modification times, commit SHA, schema/version metadata, and any available checksums.
- Reproduce against a disposable copy. Do not run destructive recovery against the only evidence.
- Establish whether the journal is authoritative and the SQLite database is a rebuildable index; follow the repository's documented storage contract.

## Append-only JSONL integrity

- Validate each complete line independently and report the first invalid byte/line offset without exposing sensitive payloads.
- Distinguish a missing final newline, a truncated final record, malformed JSON in the middle, duplicate event IDs, and invalid event ordering.
- Do not automatically discard a malformed middle record. Preserve it for diagnosis and fail recovery unless documented policy says otherwise.
- Test interrupted writes at multiple byte offsets, including process kill during append and disk-full/write-error simulation where feasible.
- Make append durability and flush behavior explicit; a successful in-memory write is not necessarily a durable commit.

## SQLite index consistency and recovery

- Compare journal-derived event IDs, sequence numbers, offsets, and hashes against the index.
- Test stale index, missing rows, extra rows, duplicate keys, interrupted transaction, locked database, and incompatible schema version.
- Rebuild the index from the authoritative journal in a temporary database, validate counts and ordering, then atomically replace the old index using a documented recovery procedure.
- Make rebuilds idempotent and safe to repeat. Preserve the original index until validation succeeds.
- Never use index presence alone as proof that an event was durably recorded.

## Deterministic replay

- Define the replay contract: input events, initial state, clock/randomness sources, side-effect policy, and expected final state.
- Separate pure state reduction from external effects. Replay must not repeat network calls, credential writes, or process launches unless explicitly simulated.
- Compare live execution and replay using stable state snapshots and normalized nondeterministic fields.
- Investigate event ordering, duplicate delivery, missing events, schema migration, time-dependent behavior, and unrecorded inputs.
- Use fixed clocks and deterministic identifiers in tests; document intentional non-determinism.

## Correlation IDs and audit trails

- Generate or validate a correlation/run ID at the boundary and propagate it through daemon, tool, sandbox, journal, and child-process logs.
- Preserve causal links between parent/child operations and retries.
- Ensure IDs are stable across one operation but unique across independent operations.
- Hash-chain verification must check sequence/order, prior-hash links, canonical serialization, and final digest. Specify the threat model: a hash chain detects alteration only if its trusted checkpoint cannot also be rewritten.
- Treat an audit verification failure as security-relevant; do not auto-heal by rewriting hashes.

## Practice targets

- Force a truncated final JSONL record and verify documented recovery behavior.
- Corrupt a middle line and ensure recovery preserves evidence and fails safely.
- Rebuild a stale SQLite index and prove equivalence to a clean index.
- Compare live and replay state for the same deterministic fixture.
- Verify hash-chain behavior under record modification, reordering, deletion, and truncation.

## Definition of done

- Recovery is reproducible on a copy and preserves original evidence.
- Journal/index consistency is proven by explicit invariants.
- Replay equivalence tests define and enforce intended semantics.
- Audit verification failures are visible and never silently repaired.
