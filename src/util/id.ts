/**
 * ID generator abstractions for AIR (Rule R6: Injected IdGenerator).
 */

import { ulid } from 'ulid';
import type { AgentId, EventId, RunId, SessionId, ToolCallId, TurnId } from '../types/index.js';
import {
  parseAgentId,
  parseEventId,
  parseRunId,
  parseSessionId,
  parseToolCallId,
  parseTurnId,
} from '../types/index.js';
import type { Clock } from './clock.js';
import { SystemClock } from './clock.js';

export interface IdGenerator {
  next(): string;
  nextRunId(): RunId;
  nextToolCallId(): ToolCallId;
  nextEventId(): EventId;
  nextTurnId(): TurnId;
  nextSessionId(): SessionId;
  nextAgentId(): AgentId;
}

export class UlidIdGenerator implements IdGenerator {
  constructor(private readonly clock: Clock = new SystemClock()) {}

  next(): string {
    return ulid(this.clock.now().getTime());
  }

  nextRunId(): RunId {
    return parseRunId(this.next());
  }

  nextToolCallId(): ToolCallId {
    return parseToolCallId(this.next());
  }

  nextEventId(): EventId {
    return parseEventId(this.next());
  }

  nextTurnId(): TurnId {
    return parseTurnId(this.next());
  }

  nextSessionId(): SessionId {
    return parseSessionId(this.next());
  }

  nextAgentId(): AgentId {
    return parseAgentId(this.next());
  }
}

export class FakeIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix: string = 'id') {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${String(this.counter).padStart(6, '0')}`;
  }

  nextRunId(): RunId {
    this.counter += 1;
    return parseRunId(`run-${String(this.counter).padStart(6, '0')}`);
  }

  nextToolCallId(): ToolCallId {
    this.counter += 1;
    return parseToolCallId(`call-${String(this.counter).padStart(6, '0')}`);
  }

  nextEventId(): EventId {
    this.counter += 1;
    return parseEventId(`evt-${String(this.counter).padStart(6, '0')}`);
  }

  nextTurnId(): TurnId {
    this.counter += 1;
    return parseTurnId(`turn-${String(this.counter).padStart(6, '0')}`);
  }

  nextSessionId(): SessionId {
    this.counter += 1;
    return parseSessionId(`sess-${String(this.counter).padStart(6, '0')}`);
  }

  nextAgentId(): AgentId {
    this.counter += 1;
    return parseAgentId(`agent-${String(this.counter).padStart(6, '0')}`);
  }

  reset(): void {
    this.counter = 0;
  }
}
