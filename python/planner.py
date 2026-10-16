#!/usr/bin/env python3
"""
Production Planner-Executor Protocol
Ollama + Qwen3.5:9b reference implementation for AIR.
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional, Protocol, Tuple, runtime_checkable

import ollama
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

logger = logging.getLogger("air.planner")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

class Config(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    model: str = "qwen3.5:9b"
    ollama_host: str = "http://localhost:11434"
    log_dir: Path = Path("./runs")
    max_planner_steps: int = 25
    max_rejections_per_step: int = 3
    temperature: float = 0.6
    top_p: float = 0.95
    top_k: int = 20
    presence_penalty: float = 0.0
    num_predict: int = 8192
    request_timeout: float = 180.0


# ---------------------------------------------------------------------------
# Domain Models
# ---------------------------------------------------------------------------

class FailureClass(str, Enum):
    TRANSIENT = "transient"      # network, rate-limit -> retry
    LOGIC = "logic"              # bad plan -> replan
    PERMISSION = "permission"    # scope violation -> reject + escalate/log
    FATAL = "fatal"              # unrecoverable


class StepStatus(str, Enum):
    PROPOSED = "proposed"
    REJECTED = "rejected"
    EXECUTING = "executing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"


class ToolCall(BaseModel):
    name: str
    arguments: Dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class StepProposal(BaseModel):
    """What the planner is allowed to emit."""
    thought_summary: str = Field(..., description="One-sentence summary of current reasoning")
    action: str = Field(..., description="next | replan | finish | ask_human")
    tool_call: Optional[ToolCall] = None
    reasoning: str = Field(default="", description="Full chain-of-thought (will be overwritten by real thinking)")
    assumptions: List[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0, default=0.7)

    @field_validator("action")
    @classmethod
    def validate_action(cls, v: str) -> str:
        allowed = {"next", "replan", "finish", "ask_human"}
        if v not in allowed:
            raise ValueError(f"action must be one of {allowed}")
        return v


class ExecutionResult(BaseModel):
    success: bool
    output: Any = None
    error: Optional[str] = None
    failure_class: Optional[FailureClass] = None
    duration_ms: int = 0
    idempotency_key: str


class Scope(BaseModel):
    """Mechanical boundaries the validator enforces."""
    allowed_tools: List[str]
    max_steps: int = 25
    max_cost_units: float = 100.0
    forbidden_side_effects: List[str] = Field(default_factory=list)
    require_human_on: List[str] = Field(default_factory=lambda: ["ask_human"])


# ---------------------------------------------------------------------------
# Event Logging (primary artifact store)
# ---------------------------------------------------------------------------

class Event(BaseModel):
    event_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    run_id: str
    step_id: Optional[str] = None
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    event_type: str
    payload: Dict[str, Any]


class EventLogger:
    def __init__(self, run_id: str, log_dir: Path):
        self.run_id = run_id
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.path = self.log_dir / f"{run_id}.jsonl"
        self._fh = open(self.path, "a", encoding="utf-8")

    def emit(self, event_type: str, payload: Dict[str, Any], step_id: Optional[str] = None) -> Event:
        event = Event(
            run_id=self.run_id,
            step_id=step_id,
            event_type=event_type,
            payload=payload,
        )
        line = event.model_dump_json() + "\n"
        self._fh.write(line)
        self._fh.flush()
        return event

    def close(self) -> None:
        if not self._fh.closed:
            self._fh.close()

    def __enter__(self) -> EventLogger:
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()


# ---------------------------------------------------------------------------
# Validator (mechanical scope enforcement)
# ---------------------------------------------------------------------------

class ValidationResult(BaseModel):
    accepted: bool
    reason: Optional[str] = None
    proposal: Optional[StepProposal] = None


class ScopeValidator:
    def __init__(self, scope: Scope):
        self.scope = scope
        self.steps_taken = 0
        self.cost_units = 0.0

    def validate(self, raw: Dict[str, Any] | StepProposal) -> ValidationResult:
        try:
            if isinstance(raw, dict):
                proposal = StepProposal.model_validate(raw)
            else:
                proposal = raw
        except ValidationError as e:
            return ValidationResult(accepted=False, reason=f"schema_violation: {e}")

        if self.steps_taken >= self.scope.max_steps:
            return ValidationResult(accepted=False, reason="max_steps_exceeded")

        if proposal.action == "next" and proposal.tool_call:
            if proposal.tool_call.name not in self.scope.allowed_tools:
                return ValidationResult(
                    accepted=False,
                    reason=f"tool_not_allowed: {proposal.tool_call.name}",
                )

        if proposal.action in self.scope.require_human_on:
            # Accepted for human escalation routing
            pass

        self.steps_taken += 1
        return ValidationResult(accepted=True, proposal=proposal)


# ---------------------------------------------------------------------------
# Executor interface + in-memory implementation
# ---------------------------------------------------------------------------

@runtime_checkable
class Executor(Protocol):
    def execute(self, tool_call: ToolCall) -> ExecutionResult: ...


class InMemoryExecutor:
    """In-memory tool executor with strict idempotency tracking."""

    def __init__(self):
        self._seen: Dict[str, ExecutionResult] = {}

    def execute(self, tool_call: ToolCall) -> ExecutionResult:
        key = tool_call.idempotency_key
        if key in self._seen:
            return self._seen[key]

        start = time.perf_counter()
        try:
            if tool_call.name == "echo":
                output = {"echoed": tool_call.arguments}
            elif tool_call.name == "fail_transient":
                raise ConnectionError("simulated network blip")
            elif tool_call.name == "fail_fatal":
                raise RuntimeError("simulated fatal failure")
            else:
                output = {"status": "ok", "tool": tool_call.name, "args": tool_call.arguments}

            result = ExecutionResult(
                success=True,
                output=output,
                duration_ms=int((time.perf_counter() - start) * 1000),
                idempotency_key=key,
            )
        except ConnectionError as e:
            result = ExecutionResult(
                success=False,
                error=str(e),
                failure_class=FailureClass.TRANSIENT,
                duration_ms=int((time.perf_counter() - start) * 1000),
                idempotency_key=key,
            )
        except Exception as e:
            result = ExecutionResult(
                success=False,
                error=str(e),
                failure_class=FailureClass.FATAL if tool_call.name == "fail_fatal" else FailureClass.LOGIC,
                duration_ms=int((time.perf_counter() - start) * 1000),
                idempotency_key=key,
            )

        self._seen[key] = result
        return result


# ---------------------------------------------------------------------------
# Planner (Ollama + Qwen3.5:9b)
# ---------------------------------------------------------------------------

PLANNER_SYSTEM = """You are the Planner in a strict Planner-Executor protocol.

You receive:
- The overall goal
- The current scoped outlook
- Full history of previous steps and their outcomes
- The list of allowed tools

Your job is to decide the single next action.
You may improvise freely inside the given scope.
You must never request a tool that is not in the allowed list.

Respond with a single JSON object that matches this schema exactly:
{
  "thought_summary": "one sentence",
  "action": "next" | "replan" | "finish" | "ask_human",
  "tool_call": {
    "name": "tool_name",
    "arguments": {},
    "idempotency_key": "unique-string"
  } | null,
  "assumptions": ["list of assumptions you are making"],
  "confidence": 0.0-1.0
}

Do not wrap the JSON in markdown. Emit pure JSON only after your internal reasoning.
"""


class Planner:
    def __init__(self, config: Config, logger: EventLogger, client: Optional[Any] = None):
        self.config = config
        self.logger = logger
        self.client = client if client is not None else ollama.Client(host=config.ollama_host)

    def propose(
        self,
        goal: str,
        scope: Scope,
        history: List[Dict[str, Any]],
        step_id: str,
    ) -> Tuple[Optional[StepProposal], str]:
        """
        Returns (proposal_or_None, raw_thinking)
        """
        messages = [
            {"role": "system", "content": PLANNER_SYSTEM},
            {
                "role": "user",
                "content": self._build_user_message(goal, scope, history),
            },
        ]

        self.logger.emit(
            "planner_request",
            {
                "messages": messages,
                "model": self.config.model,
            },
            step_id=step_id,
        )

        try:
            response = self.client.chat(
                model=self.config.model,
                messages=messages,
                think=True,
                options={
                    "temperature": self.config.temperature,
                    "top_p": self.config.top_p,
                    "top_k": self.config.top_k,
                    "presence_penalty": self.config.presence_penalty,
                    "num_predict": self.config.num_predict,
                },
            )
        except Exception as e:
            self.logger.emit(
                "planner_error",
                {"error": str(e), "type": type(e).__name__},
                step_id=step_id,
            )
            raise

        message = getattr(response, "message", None)
        thinking = getattr(message, "thinking", "") or ""
        content = getattr(message, "content", "") or ""

        self.logger.emit(
            "planner_response",
            {
                "thinking": thinking,
                "content": content,
                "model": self.config.model,
            },
            step_id=step_id,
        )

        try:
            cleaned = content.strip()
            if cleaned.startswith("```"):
                parts = cleaned.split("```")
                if len(parts) >= 2:
                    cleaned = parts[1]
                if cleaned.startswith("json"):
                    cleaned = cleaned[4:]
            cleaned = cleaned.strip()
            data = json.loads(cleaned)
            proposal = StepProposal.model_validate(data)
            proposal.reasoning = thinking
            return proposal, thinking
        except (json.JSONDecodeError, ValidationError) as e:
            self.logger.emit(
                "planner_parse_error",
                {"error": str(e), "raw_content": content},
                step_id=step_id,
            )
            return None, thinking

    def _build_user_message(
        self, goal: str, scope: Scope, history: List[Dict[str, Any]]
    ) -> str:
        return json.dumps(
            {
                "goal": goal,
                "scope": {
                    "allowed_tools": scope.allowed_tools,
                    "max_steps": scope.max_steps,
                    "forbidden_side_effects": scope.forbidden_side_effects,
                },
                "history": history[-12:],
            },
            indent=2,
            default=str,
        )


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

class Orchestrator:
    def __init__(
        self,
        config: Config,
        scope: Scope,
        executor: Executor,
        planner: Optional[Planner] = None,
        event_logger: Optional[EventLogger] = None,
    ):
        self.config = config
        self.scope = scope
        self.executor = executor
        self.run_id = str(uuid.uuid4())
        self.logger = event_logger if event_logger is not None else EventLogger(self.run_id, config.log_dir)
        self.planner = planner if planner is not None else Planner(config, self.logger)
        self.validator = ScopeValidator(scope)
        self.history: List[Dict[str, Any]] = []

    def run(self, goal: str) -> Dict[str, Any]:
        self.logger.emit("run_started", {"goal": goal, "scope": self.scope.model_dump()})

        step_count = 0
        rejections = 0

        while step_count < self.config.max_planner_steps:
            step_id = f"step-{step_count:04d}"
            step_count += 1

            # 1. Planner proposes
            proposal, thinking = self.planner.propose(
                goal=goal,
                scope=self.scope,
                history=self.history,
                step_id=step_id,
            )

            if proposal is None:
                rejections += 1
                self.history.append(
                    {
                        "step_id": step_id,
                        "status": StepStatus.REJECTED,
                        "reason": "unparseable_proposal",
                        "thinking": thinking,
                    }
                )
                if rejections >= self.config.max_rejections_per_step:
                    break
                continue

            # 2. Mechanical validation
            validation = self.validator.validate(proposal)
            if not validation.accepted:
                rejections += 1
                self.logger.emit(
                    "proposal_rejected",
                    {"reason": validation.reason, "proposal": proposal.model_dump()},
                    step_id=step_id,
                )
                self.history.append(
                    {
                        "step_id": step_id,
                        "status": StepStatus.REJECTED,
                        "reason": validation.reason,
                        "proposal": proposal.model_dump(),
                        "thinking": thinking,
                    }
                )
                if rejections >= self.config.max_rejections_per_step:
                    break
                continue

            rejections = 0
            proposal = validation.proposal
            assert proposal is not None

            self.logger.emit(
                "proposal_accepted",
                {"proposal": proposal.model_dump()},
                step_id=step_id,
            )

            # 3. Terminal actions
            if proposal.action == "finish":
                self.history.append(
                    {
                        "step_id": step_id,
                        "status": StepStatus.SUCCEEDED,
                        "action": "finish",
                        "thinking": thinking,
                    }
                )
                break

            if proposal.action == "ask_human":
                self.history.append(
                    {
                        "step_id": step_id,
                        "status": StepStatus.SKIPPED,
                        "action": "ask_human",
                        "thinking": thinking,
                        "message": "Human intervention required",
                    }
                )
                break

            if proposal.action == "replan":
                self.history.append(
                    {
                        "step_id": step_id,
                        "status": StepStatus.SUCCEEDED,
                        "action": "replan",
                        "thinking": thinking,
                    }
                )
                continue

            # 4. Execute
            assert proposal.tool_call is not None
            self.logger.emit(
                "execution_started",
                {"tool_call": proposal.tool_call.model_dump()},
                step_id=step_id,
            )

            result = self.executor.execute(proposal.tool_call)

            self.logger.emit(
                "execution_finished",
                {"result": result.model_dump()},
                step_id=step_id,
            )

            status = StepStatus.SUCCEEDED if result.success else StepStatus.FAILED
            self.history.append(
                {
                    "step_id": step_id,
                    "status": status,
                    "proposal": proposal.model_dump(),
                    "result": result.model_dump(),
                    "thinking": thinking,
                }
            )

            if not result.success and result.failure_class == FailureClass.FATAL:
                break

        self.logger.emit(
            "run_finished",
            {
                "steps": step_count,
                "final_history_length": len(self.history),
            },
        )
        self.logger.close()

        return {
            "run_id": self.run_id,
            "goal": goal,
            "history": self.history,
            "log_path": str(self.logger.path),
        }


# ---------------------------------------------------------------------------
# CLI demonstration entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)

    config = Config(
        model="qwen3.5:9b",
        log_dir=Path("./runs"),
        max_planner_steps=15,
    )

    scope = Scope(
        allowed_tools=["echo", "search", "write_file", "read_file"],
        max_steps=15,
        forbidden_side_effects=["delete", "network_unrestricted"],
    )

    executor = InMemoryExecutor()
    orch = Orchestrator(config, scope, executor)

    demo_result = orch.run(
        goal="Demonstrate the protocol by echoing a message and then finishing."
    )

    print(json.dumps(demo_result, indent=2, default=str))
