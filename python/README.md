# AIR Python Planner Reference Implementation

This directory contains the production-grade Python reference implementation of the **Planner-Executor Protocol** (Ollama + Qwen3.5:9b) for the AIR runtime.

## Architecture

The protocol implements a deterministic, scope-validated turn engine:
1. **Planner (`Planner`)**: Interacts with Ollama (Qwen3.5) with reasoning capture (`think=True`) to produce structured `StepProposal` decisions (`next`, `replan`, `finish`, `ask_human`).
2. **Validator (`ScopeValidator`)**: Enforces mechanical safety boundaries (allowed tools, maximum steps, human intervention points) before any side-effect can execute.
3. **Executor (`Executor` / `InMemoryExecutor`)**: Enforces tool execution with strict idempotency tracking via `idempotency_key` and failure classification (`FailureClass`: `transient`, `logic`, `permission`, `fatal`).
4. **Journaling (`EventLogger`)**: Records append-only JSONL events for every step (`run_started`, `planner_request`, `planner_response`, `proposal_accepted`, `execution_started`, `execution_finished`, `run_finished`).
5. **Orchestrator (`Orchestrator`)**: Coordinates the planner, validator, and executor loop.

## Running Tests

Using `uv`:
```bash
uv run --with pytest --with pydantic --with ollama pytest python/tests
```

## Running the Protocol Demo

```bash
uv run --with pydantic --with ollama python python/planner.py
```
