import { describe, expect, it } from 'vitest';
import {
  ContextManager,
  estimateMessageTokens,
  estimateTotalTokens,
} from '../../../src/agent/context.js';
import { EventBus } from '../../../src/journal/index.js';
import type { NormalizedMessage } from '../../../src/providers/index.js';
import { FakeClock } from '../../../src/util/index.js';
import type { AgentManifest } from '../../../src/agent/manifest.js';

describe('ContextManager (P6-T05)', () => {
  const dummyManifest: AgentManifest = {
    schemaVersion: 1,
    id: 'developer',
    name: 'Developer Agent',
    description: 'Autonomous dev agent',
    version: '1.0.0',
    model: {
      model: 'mock-model',
      temperature: 0.1,
      maxTokens: 2048,
    },
    systemPrompt: 'You are a developer.',
    tools: ['*'],
    policyProfile: 'project-write',
    maxContextTokens: 1000,
    maxParallelTools: 4,
  };

  describe('Token Estimation', () => {
    it('estimates tokens for string messages and parts', () => {
      const msg: NormalizedMessage = {
        role: 'user',
        content: 'Hello world! This is a test message.',
      };
      const count = estimateMessageTokens(msg);
      expect(count).toBeGreaterThan(5);
      expect(count).toBeLessThan(20);

      const complexMsg: NormalizedMessage = {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Executing tool' },
          { type: 'tool_call', id: 'call_1', name: 'fs.read', arguments: { path: 'file.txt' } },
        ],
      };
      const complexCount = estimateMessageTokens(complexMsg);
      expect(complexCount).toBeGreaterThan(count);
    });

    it('estimates total tokens including system prompt', () => {
      const total = estimateTotalTokens('System prompt here', [
        { role: 'user', content: 'Query' },
        { role: 'assistant', content: 'Response' },
      ]);
      expect(total).toBeGreaterThan(10);
    });
  });

  describe('Compaction Mechanics', () => {
    it('does not compact when well within budget', () => {
      const manager = new ContextManager({
        runId: 'run-1',
        maxContextTokens: 1000,
      });
      manager.setSystemPrompt('System prompt');
      manager.addMessage({ role: 'user', content: 'Short message' });

      const result = manager.maybeCompact();
      expect(result.compacted).toBe(false);
      expect(manager.getMessages().length).toBe(1);
    });

    it('tier 1: prunes large tool output in older messages when exceeding budget', () => {
      const manager = new ContextManager({
        runId: 'run-1',
        maxContextTokens: 200,
        preserveRecentCount: 2,
        toolPruneThresholdChars: 50,
      });

      // Turn 0: initial user message
      manager.addMessage({ role: 'user', content: 'Goal: build the system' });

      // Turn 1: older message with huge tool result
      manager.addMessage({
        role: 'assistant',
        content: [
          {
            type: 'tool_result',
            toolCallId: 'tc-huge',
            content: 'x'.repeat(1000), // Huge content
          },
        ],
      });

      // Turn 2 and 3: recent window messages
      manager.addMessage({ role: 'user', content: 'Recent query' });
      manager.addMessage({ role: 'assistant', content: 'Recent reply' });

      const prevTokens = manager.getEstimatedTokens();
      expect(prevTokens).toBeGreaterThan(200);

      const result = manager.maybeCompact();
      expect(result.compacted).toBe(true);

      const msgs = manager.getMessages();
      expect(msgs.length).toBe(4);

      // Verify the large tool output was pruned
      const turn1 = msgs[1];
      expect(turn1).toBeDefined();
      expect(Array.isArray(turn1?.content)).toBe(true);
      const parts = turn1?.content as Array<{ type: string; content?: unknown }>;
      expect(String(parts[0]?.content)).toContain('[Tool output pruned: 1000 chars originally]');
    });

    it('tier 2: summarizes intermediate messages if pruning tool results is insufficient', () => {
      const manager = new ContextManager({
        runId: 'run-1',
        maxContextTokens: 100, // Very tight token budget
        preserveRecentCount: 2,
      });

      // Msg 0: initial goal
      manager.addMessage({ role: 'user', content: 'Initial user objective' });

      // Intermediate messages 1 to 5 (lengthy text)
      for (let i = 1; i <= 5; i++) {
        manager.addMessage({
          role: i % 2 === 0 ? 'assistant' : 'user',
          content: `Intermediate turn ${i} with substantial detailed explanation and discussion ${'z'.repeat(50)}`,
        });
      }

      // Recent 2 messages
      manager.addMessage({ role: 'user', content: 'Final question' });
      manager.addMessage({ role: 'assistant', content: 'Final answer' });

      expect(manager.getMessages().length).toBe(8);

      const result = manager.maybeCompact();
      expect(result.compacted).toBe(true);
      expect(result.removedMessageCount).toBe(5);

      const msgs = manager.getMessages();
      // Should preserve: msg 0 (initial goal) + 1 summary message + 2 recent messages = 4
      expect(msgs.length).toBe(4);
      expect(msgs[0]?.content).toBe('Initial user objective');
      expect(typeof msgs[1]?.content === 'string' && msgs[1]?.content).toContain('[CONVERSATION COMPACTED: 5 earlier turns condensed]');
      expect(msgs[2]?.content).toBe('Final question');
      expect(msgs[3]?.content).toBe('Final answer');
    });

    it('emits context.compacted journal event on EventBus', async () => {
      const clock = new FakeClock('2026-10-17T12:00:00.000Z');
      const eventBus = new EventBus();
      const publishedTypes: string[] = [];
      const sub = eventBus.subscribe({ types: ['context.compacted'] }, (ev) => {
        publishedTypes.push(ev.type);
      });

      const manager = new ContextManager({
        runId: 'run-compact-test',
        maxContextTokens: 50,
        preserveRecentCount: 2,
        clock,
        eventBus,
      });

      manager.addMessage({ role: 'user', content: 'Goal' });
      manager.addMessage({ role: 'user', content: 'm1: ' + 'a'.repeat(200) });
      manager.addMessage({ role: 'user', content: 'm2: ' + 'b'.repeat(200) });
      manager.addMessage({ role: 'user', content: 'recent 1' });
      manager.addMessage({ role: 'assistant', content: 'recent 2' });

      manager.maybeCompact();
      await sub.drain();

      expect(publishedTypes).toContain('context.compacted');
    });
  });

  describe('assembleRequest', () => {
    it('constructs a complete NormalizedRequest', () => {
      const manager = new ContextManager({ runId: 'run-req' });
      manager.setSystemPrompt('System prompt');
      manager.addMessage({ role: 'user', content: 'Hello' });

      const req = manager.assembleRequest(dummyManifest, [
        {
          name: 'fs.read',
          description: 'Read file',
          parameters: { type: 'object' },
        },
      ]);

      expect(req.model).toBe('mock-model');
      expect(req.system).toBe('System prompt');
      expect(req.messages.length).toBe(1);
      expect(req.tools?.length).toBe(1);
      expect(req.temperature).toBe(0.1);
    });
  });
});
