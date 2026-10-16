"""
Comprehensive unit tests for Python Planner-Executor protocol.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
import pytest
from pydantic import ValidationError

from python.planner import (
    Config,
    EventLogger,
    ExecutionResult,
    FailureClass,
    InMemoryExecutor,
    Orchestrator,
    Planner,
    Scope,
    ScopeValidator,
    StepProposal,
    StepStatus,
    ToolCall,
)


class MockChatMessage:
    def __init__(self, content: str, thinking: str = ""):
        self.content = content
        self.thinking = thinking


class MockChatResponse:
    def __init__(self, content: str, thinking: str = ""):
        self.message = MockChatMessage(content=content, thinking=thinking)


class MockOllamaClient:
    def __init__(self, responses: list[MockChatResponse]):
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def chat(self, **kwargs: Any) -> MockChatResponse:
        self.calls.append(kwargs)
        if not self.responses:
            raise RuntimeError("No more mocked responses available")
        return self.responses.pop(0)


# ---------------------------------------------------------------------------
# Unit tests: Models and Validation
# ---------------------------------------------------------------------------

def test_step_proposal_valid():
    proposal = StepProposal(
        thought_summary="Planning next action",
        action="next",
        tool_call=ToolCall(name="echo", arguments={"msg": "hello"}),
        confidence=0.9,
    )
    assert proposal.action == "next"
    assert proposal.tool_call is not None
    assert proposal.tool_call.name == "echo"
    assert proposal.confidence == 0.9


def test_step_proposal_invalid_action():
    with pytest.raises(ValidationError):
        StepProposal(
            thought_summary="Invalid action test",
            action="destroy_everything",
            reasoning="none",
        )


def test_scope_validator_allowed_tools():
    scope = Scope(allowed_tools=["echo", "read_file"], max_steps=5)
    validator = ScopeValidator(scope)

    valid_proposal = StepProposal(
        thought_summary="Use echo",
        action="next",
        tool_call=ToolCall(name="echo"),
    )
    res1 = validator.validate(valid_proposal)
    assert res1.accepted is True

    invalid_tool_proposal = StepProposal(
        thought_summary="Use bash",
        action="next",
        tool_call=ToolCall(name="bash"),
    )
    res2 = validator.validate(invalid_tool_proposal)
    assert res2.accepted is False
    assert "tool_not_allowed" in (res2.reason or "")


def test_scope_validator_max_steps():
    scope = Scope(allowed_tools=["echo"], max_steps=2)
    validator = ScopeValidator(scope)

    proposal = StepProposal(thought_summary="Echo", action="next", tool_call=ToolCall(name="echo"))
    assert validator.validate(proposal).accepted is True
    assert validator.validate(proposal).accepted is True

    # 3rd step exceeds max_steps=2
    res = validator.validate(proposal)
    assert res.accepted is False
    assert res.reason == "max_steps_exceeded"


# ---------------------------------------------------------------------------
# Unit tests: InMemoryExecutor & Idempotency
# ---------------------------------------------------------------------------

def test_executor_echo_and_idempotency():
    executor = InMemoryExecutor()
    tool_call = ToolCall(name="echo", arguments={"text": "hello AIR"}, idempotency_key="key-123")

    res1 = executor.execute(tool_call)
    assert res1.success is True
    assert res1.output == {"echoed": {"text": "hello AIR"}}
    assert res1.idempotency_key == "key-123"

    # Repeated call with same idempotency key returns exact same cached result
    res2 = executor.execute(tool_call)
    assert res2 is res1


def test_executor_transient_and_fatal_errors():
    executor = InMemoryExecutor()

    # Transient error
    res_transient = executor.execute(ToolCall(name="fail_transient", idempotency_key="t-1"))
    assert res_transient.success is False
    assert res_transient.failure_class == FailureClass.TRANSIENT

    # Fatal error
    res_fatal = executor.execute(ToolCall(name="fail_fatal", idempotency_key="f-1"))
    assert res_fatal.success is False
    assert res_fatal.failure_class == FailureClass.FATAL


# ---------------------------------------------------------------------------
# Unit tests: EventLogger
# ---------------------------------------------------------------------------

def test_event_logger_writes_jsonl(tmp_path: Path):
    run_id = "test-run-001"
    with EventLogger(run_id, tmp_path) as logger:
        logger.emit("test_event", {"key": "val"}, step_id="step-0001")

    log_file = tmp_path / f"{run_id}.jsonl"
    assert log_file.exists()

    with open(log_file, "r", encoding="utf-8") as fh:
        lines = [json.loads(line) for line in fh]

    assert len(lines) == 1
    assert lines[0]["run_id"] == run_id
    assert lines[0]["step_id"] == "step-0001"
    assert lines[0]["event_type"] == "test_event"
    assert lines[0]["payload"] == {"key": "val"}


# ---------------------------------------------------------------------------
# Unit tests: Planner parsing & thinking capture
# ---------------------------------------------------------------------------

def test_planner_parses_json_and_markdown_fence(tmp_path: Path):
    config = Config(log_dir=tmp_path)
    logger = EventLogger("test-run", tmp_path)

    raw_json = json.dumps({
        "thought_summary": "Echoing greeting",
        "action": "next",
        "tool_call": {
            "name": "echo",
            "arguments": {"greeting": "hi"},
            "idempotency_key": "k-1",
        },
        "assumptions": ["server is running"],
        "confidence": 0.95,
    })

    # Wrap in markdown ```json ... ```
    wrapped_content = f"```json\n{raw_json}\n```"
    mock_client = MockOllamaClient([MockChatResponse(content=wrapped_content, thinking="I should say hi")])

    planner = Planner(config, logger, client=mock_client)
    scope = Scope(allowed_tools=["echo"])
    proposal, thinking = planner.propose("test goal", scope, [], "step-0001")

    assert proposal is not None
    assert proposal.thought_summary == "Echoing greeting"
    assert proposal.action == "next"
    assert proposal.tool_call is not None
    assert proposal.tool_call.name == "echo"
    assert proposal.reasoning == "I should say hi"
    assert thinking == "I should say hi"


def test_planner_handles_unparseable_response(tmp_path: Path):
    config = Config(log_dir=tmp_path)
    logger = EventLogger("test-run", tmp_path)

    mock_client = MockOllamaClient([MockChatResponse(content="I cannot give you JSON right now", thinking="Puzzled")])
    planner = Planner(config, logger, client=mock_client)
    scope = Scope(allowed_tools=["echo"])
    proposal, thinking = planner.propose("test goal", scope, [], "step-0001")

    assert proposal is None
    assert thinking == "Puzzled"


# ---------------------------------------------------------------------------
# Unit tests: Orchestrator Loop
# ---------------------------------------------------------------------------

def test_orchestrator_successful_run(tmp_path: Path):
    config = Config(log_dir=tmp_path, max_planner_steps=10)
    scope = Scope(allowed_tools=["echo"], max_steps=5)

    step1_json = json.dumps({
        "thought_summary": "Echo something",
        "action": "next",
        "tool_call": {"name": "echo", "arguments": {"x": 1}, "idempotency_key": "step1"},
        "assumptions": [],
        "confidence": 1.0,
    })
    step2_json = json.dumps({
        "thought_summary": "Finish now",
        "action": "finish",
        "tool_call": None,
        "assumptions": [],
        "confidence": 1.0,
    })

    mock_client = MockOllamaClient([
        MockChatResponse(content=step1_json, thinking="Step 1 thinking"),
        MockChatResponse(content=step2_json, thinking="Step 2 thinking"),
    ])

    executor = InMemoryExecutor()
    logger = EventLogger("orch-run", tmp_path)
    planner = Planner(config, logger, client=mock_client)
    orch = Orchestrator(config, scope, executor, planner=planner, event_logger=logger)

    result = orch.run("Test successful orchestration")

    assert result["goal"] == "Test successful orchestration"
    history = result["history"]
    assert len(history) == 2
    assert history[0]["status"] == StepStatus.SUCCEEDED
    assert history[0]["result"]["output"] == {"echoed": {"x": 1}}
    assert history[1]["action"] == "finish"
    assert history[1]["status"] == StepStatus.SUCCEEDED


def test_orchestrator_ask_human_terminal(tmp_path: Path):
    config = Config(log_dir=tmp_path, max_planner_steps=5)
    scope = Scope(allowed_tools=["echo"], require_human_on=["ask_human"])

    ask_human_json = json.dumps({
        "thought_summary": "Need human guidance",
        "action": "ask_human",
        "tool_call": None,
        "assumptions": [],
        "confidence": 0.5,
    })

    mock_client = MockOllamaClient([MockChatResponse(content=ask_human_json, thinking="Unsure")])

    executor = InMemoryExecutor()
    logger = EventLogger("ask-run", tmp_path)
    planner = Planner(config, logger, client=mock_client)
    orch = Orchestrator(config, scope, executor, planner=planner, event_logger=logger)

    result = orch.run("Test ask human")
    history = result["history"]
    assert len(history) == 1
    assert history[0]["action"] == "ask_human"
    assert history[0]["status"] == StepStatus.SKIPPED
