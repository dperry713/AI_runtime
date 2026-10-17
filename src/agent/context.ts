/**
 * Context Assembly & Compaction Engine (Phase 6 - P6-T05).
 *
 * Implements token-aware conversation history management:
 * - Deterministic token estimation across text and structured message parts
 * - Automatic compaction when token count exceeds `maxContextTokens`
 * - Two-tier compaction:
 *   1. Tool output pruning (prunes lengthy tool results from older turns)
 *   2. History summarization (compresses intermediate turns into a summary milestone)
 * - Guarantees preservation of:
 *   - Base system prompt
 *   - Initial user objective (turn 0)
 *   - Most recent active turns (window preservation)
 * - Emits `context.compacted` journal events via EventBus
 * - Assembles NormalizedRequest payloads for provider invocations
 *
 * Adheres to:
 * - Rule R6: Clock/IdGenerator injection
 * - Rule R7: Strict TypeScript, no any
 * - Rule R8: Journal event emission (context.compacted)
 * - Rule R11: Typed AirError errors
 */

import { createEnvelope, type EventBus } from '../journal/index.js';
import {
  extractText,
  type MessagePart,
  type NormalizedMessage,
  type NormalizedRequest,
  type ProviderToolDefinition,
  type ToolResultPart,
} from '../providers/index.js';
import type { RunId } from '../types/index.js';
import {
  type Clock,
  type IdGenerator,
  SystemClock,
  UlidIdGenerator,
} from '../util/index.js';
import type { AgentManifest } from './manifest.js';

// ============================================================================
// 1. Token Estimation
// ============================================================================

/**
 * Fast, conservative token estimator (~3.8 characters per token + overhead for parts/roles).
 */
export function estimateMessageTokens(message: NormalizedMessage): number {
  let chars = 4; // Role + structure overhead

  if (typeof message.content === 'string') {
    chars += message.content.length;
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      chars += 4; // Part wrapper overhead
      switch (part.type) {
        case 'text':
          chars += part.text.length;
          break;
        case 'thinking':
          chars += part.thinking.length;
          break;
        case 'tool_call':
          chars += part.name.length;
          chars += typeof part.arguments === 'string'
            ? part.arguments.length
            : JSON.stringify(part.arguments).length;
          break;
        case 'tool_result':
          chars += part.toolCallId.length;
          chars += typeof part.content === 'string'
            ? part.content.length
            : JSON.stringify(part.content).length;
          break;
        case 'image':
          chars += 300; // Fixed token estimate for images
          break;
      }
    }
  }

  return Math.ceil(chars / 3.8);
}

export function estimateTotalTokens(
  systemPrompt: string | undefined,
  messages: readonly NormalizedMessage[],
): number {
  let total = 0;
  if (systemPrompt) {
    total += Math.ceil((systemPrompt.length + 8) / 3.8);
  }
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

// ============================================================================
// 2. Compaction Types & Options
// ============================================================================

export interface ContextManagerOptions {
  readonly runId: RunId | string;
  readonly maxContextTokens?: number | undefined;
  /** Number of most recent messages to protect from compaction. Default: 4. */
  readonly preserveRecentCount?: number | undefined;
  /** Max characters allowed for a tool result before pruning during compaction. Default: 200. */
  readonly toolPruneThresholdChars?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly idGenerator?: IdGenerator | undefined;
  readonly eventBus?: EventBus | undefined;
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly previousTokens: number;
  readonly compactedTokens: number;
  readonly removedMessageCount: number;
  readonly summary?: string | undefined;
}

// ============================================================================
// 3. ContextManager Class
// ============================================================================

export class ContextManager {
  private readonly runId: string;
  private readonly maxContextTokens: number;
  private readonly preserveRecentCount: number;
  private readonly toolPruneThresholdChars: number;
  private readonly clock: Clock;
  private readonly idGenerator: IdGenerator;
  private readonly eventBus?: EventBus | undefined;

  private systemPrompt = '';
  private messages: NormalizedMessage[] = [];
  private seq = 1;

  public constructor(options: ContextManagerOptions) {
    this.runId = String(options.runId);
    this.maxContextTokens = options.maxContextTokens ?? 100_000;
    this.preserveRecentCount = Math.max(2, options.preserveRecentCount ?? 4);
    this.toolPruneThresholdChars = options.toolPruneThresholdChars ?? 200;
    this.clock = options.clock ?? new SystemClock();
    this.idGenerator = options.idGenerator ?? new UlidIdGenerator(this.clock);
    this.eventBus = options.eventBus;
  }

  public setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  public getSystemPrompt(): string {
    return this.systemPrompt;
  }

  public getMessages(): readonly NormalizedMessage[] {
    return [...this.messages];
  }

  public addMessage(message: NormalizedMessage): void {
    this.messages.push(message);
  }

  public addMessages(messages: readonly NormalizedMessage[]): void {
    for (const msg of messages) {
      this.messages.push(msg);
    }
  }

  public getEstimatedTokens(): number {
    return estimateTotalTokens(this.systemPrompt, this.messages);
  }

  /**
   * Compares current tokens against limit and triggers compaction if necessary.
   */
  public maybeCompact(): CompactionResult {
    const currentTokens = this.getEstimatedTokens();
    if (currentTokens <= this.maxContextTokens) {
      return {
        compacted: false,
        previousTokens: currentTokens,
        compactedTokens: currentTokens,
        removedMessageCount: 0,
      };
    }

    // Step 1: Prune large tool results in older messages
    const previousTokens = currentTokens;
    this.pruneOldToolResults();

    let tokensAfterPrune = this.getEstimatedTokens();
    if (tokensAfterPrune <= this.maxContextTokens) {
      const result: CompactionResult = {
        compacted: true,
        previousTokens,
        compactedTokens: tokensAfterPrune,
        removedMessageCount: 0,
        summary: 'Pruned historical tool outputs exceeding size threshold',
      };
      this.emitCompactedEvent(result);
      return result;
    }

    // Step 2: Summarize intermediate messages
    const removedCount = this.summarizeIntermediateMessages();
    tokensAfterPrune = this.getEstimatedTokens();

    const result: CompactionResult = {
      compacted: true,
      previousTokens,
      compactedTokens: tokensAfterPrune,
      removedMessageCount: removedCount,
      summary: `Summarized ${removedCount} intermediate turns into a context milestone`,
    };

    this.emitCompactedEvent(result);
    return result;
  }

  /**
   * Prunes tool results from messages outside the protected recent window.
   */
  private pruneOldToolResults(): void {
    const totalMsgs = this.messages.length;
    if (totalMsgs <= this.preserveRecentCount) return;

    const cutoff = totalMsgs - this.preserveRecentCount;

    for (let i = 1; i < cutoff; i++) {
      const msg = this.messages[i];
      if (!msg) continue;

      if (Array.isArray(msg.content)) {
        const updatedParts: MessagePart[] = msg.content.map((part) => {
          if (part.type === 'tool_result') {
            const rawContent = typeof part.content === 'string'
              ? part.content
              : JSON.stringify(part.content);

            if (rawContent.length > this.toolPruneThresholdChars) {
              const prunedContent: ToolResultPart = {
                type: 'tool_result',
                toolCallId: part.toolCallId,
                content: `[Tool output pruned: ${rawContent.length} chars originally]`,
                isError: part.isError,
              };
              return prunedContent;
            }
          }
          return part;
        });

        this.messages[i] = {
          ...msg,
          content: updatedParts,
        };
      }
    }
  }

  /**
   * Collapses intermediate messages between turn 0 (initial user goal) and the recent window.
   */
  private summarizeIntermediateMessages(): number {
    const totalMsgs = this.messages.length;
    if (totalMsgs <= this.preserveRecentCount + 1) {
      return 0; // Not enough messages to compress
    }

    // Keep msg 0 (initial user message) and the last `preserveRecentCount` messages
    const initialMsg = this.messages[0];
    if (!initialMsg) return 0;

    const recentIndex = totalMsgs - this.preserveRecentCount;
    const intermediateMsgs = this.messages.slice(1, recentIndex);

    if (intermediateMsgs.length === 0) return 0;

    // Build condensed summary of intermediate actions
    const summaryLines: string[] = [];
    for (const msg of intermediateMsgs) {
      const text = extractText(msg);
      if (text.trim().length > 0) {
        const preview = text.trim().slice(0, 100).replace(/\s+/g, ' ');
        summaryLines.push(`- [${msg.role}]: ${preview}...`);
      }
    }

    const summaryBlock: NormalizedMessage = {
      role: 'user',
      content: `[CONVERSATION COMPACTED: ${intermediateMsgs.length} earlier turns condensed]\n${summaryLines.slice(0, 10).join('\n')}`,
    };

    const recentMsgs = this.messages.slice(recentIndex);
    this.messages = [initialMsg, summaryBlock, ...recentMsgs];

    return intermediateMsgs.length;
  }

  private emitCompactedEvent(result: CompactionResult): void {
    if (!this.eventBus) return;

    try {
      this.eventBus.publish(
        createEnvelope({
          stream: `run:${this.runId}`,
          seq: this.seq++,
          type: 'context.compacted',
          payload: {
            previousTokens: result.previousTokens,
            compactedTokens: result.compactedTokens,
            removedMessageCount: result.removedMessageCount,
            summary: result.summary,
          },
          meta: { runId: this.runId },
          clock: this.clock,
          idGenerator: this.idGenerator,
        }),
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Assembles a complete NormalizedRequest for LLM invocation.
   */
  public assembleRequest(
    manifest: AgentManifest,
    tools?: readonly ProviderToolDefinition[],
  ): NormalizedRequest {
    // 1. Compact if necessary before assembly
    this.maybeCompact();

    // 2. Build request
    const request: NormalizedRequest = {
      model: manifest.model.model,
      system: this.systemPrompt,
      messages: [...this.messages],
      tools: tools ? [...tools] : undefined,
      temperature: manifest.model.temperature,
      maxTokens: manifest.model.maxTokens,
      topP: manifest.model.topP,
    };

    return request;
  }
}
