# ADR-0002: Event-sourced journal (JSONL segments + SQLite index)

- Status: accepted
- Date: 2026-10-15

## Context
We need auditability, crash recovery, resume, and deterministic replay of agent runs, plus fast queries
(list runs, tail logs, find events by run).

## Decision
All meaningful state changes are immutable, versioned events appended to per-stream JSONL segment files
(`<crc32> <json>\n` per line). A SQLite database (WAL) indexes streams/runs/sessions for queries and can be
fully rebuilt from segments. Run state is a projection (fold) of events. Tool lifecycle events are written
ahead of side effects (write-ahead rule).

## Consequences
+ Crash recovery = truncate torn tail + rebuild index. Replay and audit come almost free.
+ Segments are plain text: debuggable with PowerShell.
− Storage grows; needs rotation/compaction/snapshots (P2-T05) and upcasters for schema evolution (P2-T07).
− Requires discipline: no hidden state outside events (rule R8).

## Alternatives considered
- SQLite only: simpler, but a corrupt DB loses everything and diffs/debug are harder.
- External broker/DB: unnecessary operational weight for a single-machine runtime.
