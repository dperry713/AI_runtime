/**
 * Retrieval and ranking engine for AIR Memory (P8-T04).
 *
 * Provides:
 * - Recency score calculation with exponential half-life decay
 * - Importance and relevance score blending with configurable weights
 * - Search result re-ranking (rankSearchResults)
 * - Token-budgeted context retrieval and markdown assembly (retrieveForContext)
 * - Compliant with Rule R6 (injected Clock, no raw Date.now())
 */

import { z } from 'zod';
import { AirError } from '../errors/index.js';
import type { Clock } from '../util/index.js';
import { SystemClock } from '../util/index.js';
import type {
  MemoryEntry,
  MemoryFilter,
  MemorySearchMode,
  MemorySearchResult,
  MemoryStore,
} from './types.js';

/**
 * Fast conservative estimate of tokens for plain text / markdown (~3.8 characters per token).
 */
export function estimateTextTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  return Math.ceil(text.length / 3.8);
}

// ============================================================================
// Schemas & Types
// ============================================================================

export const RankingWeightsSchema = z.object({
  /** Weight for relevance score (BM25 / vector cosine similarity). Defaults to 0.5. */
  relevance: z.number().min(0).max(1).default(0.5),
  /** Weight for recency score (exponential half-life decay). Defaults to 0.3. */
  recency: z.number().min(0).max(1).default(0.3),
  /** Weight for importance score (entry's importance metadata). Defaults to 0.2. */
  importance: z.number().min(0).max(1).default(0.2),
});
export type RankingWeights = {
  relevance?: number | undefined;
  recency?: number | undefined;
  importance?: number | undefined;
};

export const RecencyDecayOptionsSchema = z.object({
  /** Half-life period in hours after which score decays by 50%. Defaults to 168 (7 days). */
  halfLifeHours: z.number().positive().default(168),
  /** Whether to use accessedAt timestamp if present, instead of only createdAt. Defaults to true. */
  useAccessedAt: z.boolean().default(true),
});
export type RecencyDecayOptions = {
  halfLifeHours?: number | undefined;
  useAccessedAt?: boolean | undefined;
};

export interface ScoredMemory {
  entry: MemoryEntry;
  /** Composite blended score in [0, 1]. */
  score: number;
  /** Normalized relevance score from search (BM25 or cosine similarity). */
  relevanceScore: number;
  /** Normalized recency score from exponential decay. */
  recencyScore: number;
  /** Normalized importance score from entry metadata. */
  importanceScore: number;
  /** Snippet highlights from keyword search when available. */
  highlights?:
    | {
        title?: string[] | undefined;
        content?: string[] | undefined;
      }
    | undefined;
}

export interface RetrieveForContextOptions {
  /** The backing memory store to query. */
  store: MemoryStore;
  /** Query text to match memories against. */
  query: string;
  /** Maximum token budget allowed for the packed context. */
  tokenBudget: number;
  /** Optional metadata filters (agentId, sessionId, kinds, scopes, tags, etc.). */
  filter?: MemoryFilter | undefined;
  /** Search mode: 'keyword', 'vector', or 'hybrid'. Defaults to 'hybrid'. */
  mode?: MemorySearchMode | undefined;
  /** Optional query vector when performing vector or hybrid search. */
  vector?: number[] | undefined;
  /** Weights for score blending. Defaults to { relevance: 0.5, recency: 0.3, importance: 0.2 }. */
  weights?: RankingWeights | undefined;
  /** Recency decay parameters. */
  decay?: RecencyDecayOptions | undefined;
  /** Minimum composite score threshold required to include a memory. */
  minScore?: number | undefined;
  /** Initial number of candidate memories to fetch from store before ranking. Defaults to 50. */
  candidateLimit?: number | undefined;
  /** Injected clock for deterministic timestamps (Rule R6). */
  clock?: Clock | undefined;
  /** Custom token estimation function. Defaults to estimateTokens from providers layer. */
  tokenizer?: ((text: string) => number) | undefined;
  /** Custom formatting function for each memory entry. */
  formatEntry?: ((entry: MemoryEntry, score: number) => string) | undefined;
}

export interface RetrievedContext {
  /** Individual memories selected and packed into the budget, ordered by score DESC. */
  entries: ScoredMemory[];
  /** Formatted markdown block ready for injection into system or user prompt. */
  formattedContext: string;
  /** Estimated total token count of the formattedContext. */
  totalTokens: number;
  /** The token budget that was applied. */
  budget: number;
  /** Whether some candidate memories were omitted due to budget exhaustion. */
  budgetExceeded: boolean;
}

// ============================================================================
// Core Ranking Utilities
// ============================================================================

/**
 * Calculates exponential recency decay score in [0, 1].
 *
 * Formula: S_rec = exp(-ln(2) * delta_hours / halfLifeHours)
 *
 * @param entry The memory entry (or object with createdAt / accessedAt)
 * @param nowIso ISO timestamp representing current time
 * @param options Decay configuration
 */
export function calculateRecencyScore(
  entry: Pick<MemoryEntry, 'createdAt'> & Partial<Pick<MemoryEntry, 'accessedAt'>>,
  nowIso: string,
  options?: RecencyDecayOptions,
): number {
  const halfLifeHours = options?.halfLifeHours ?? 168;
  const useAccessedAt = options?.useAccessedAt !== false;

  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) {
    throw new AirError('INVALID_ARGUMENT', `Invalid current time ISO string: "${nowIso}"`);
  }

  const createdMs = Date.parse(entry.createdAt);
  if (Number.isNaN(createdMs)) {
    throw new AirError('INVALID_ARGUMENT', `Invalid entry createdAt ISO string: "${entry.createdAt}"`);
  }

  let effectiveMs = createdMs;
  if (useAccessedAt && entry.accessedAt) {
    const accessedMs = Date.parse(entry.accessedAt);
    if (!Number.isNaN(accessedMs)) {
      effectiveMs = Math.max(createdMs, accessedMs);
    }
  }

  const deltaMs = Math.max(0, nowMs - effectiveMs);
  const deltaHours = deltaMs / (1000 * 60 * 60);

  // Exponential decay constant: lambda = ln(2) / halfLifeHours
  const lambda = Math.LN2 / halfLifeHours;
  const score = Math.exp(-lambda * deltaHours);

  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}

/**
 * Blends relevance, recency, and importance scores into a composite score in [0, 1].
 *
 * Automatically normalizes weights if their sum is not 1.0.
 */
export function blendScores(
  relevanceScore: number,
  recencyScore: number,
  importanceScore: number,
  weights?: RankingWeights,
): number {
  const wRel = weights?.relevance ?? 0.5;
  const wRec = weights?.recency ?? 0.3;
  const wImp = weights?.importance ?? 0.2;

  const sumWeights = wRel + wRec + wImp;
  if (sumWeights <= 0) {
    // If all weights are zero, use equal thirds
    return (relevanceScore + recencyScore + importanceScore) / 3;
  }

  const normRel = wRel / sumWeights;
  const normRec = wRec / sumWeights;
  const normImp = wImp / sumWeights;

  const clampedRel = Math.max(0, Math.min(1, relevanceScore));
  const clampedRec = Math.max(0, Math.min(1, recencyScore));
  const clampedImp = Math.max(0, Math.min(1, importanceScore));

  const composite = normRel * clampedRel + normRec * clampedRec + normImp * clampedImp;
  return Math.max(0, Math.min(1, composite));
}

export interface RankSearchResultsOptions {
  weights?: RankingWeights | undefined;
  decay?: RecencyDecayOptions | undefined;
  minScore?: number | undefined;
  limit?: number | undefined;
}

/**
 * Ranks search results by blending search relevance with recency decay and importance.
 * Returns ScoredMemory entries sorted descending by blended score.
 */
export function rankSearchResults(
  results: MemorySearchResult[],
  nowIso: string,
  options?: RankSearchResultsOptions,
): ScoredMemory[] {
  const scoredList: ScoredMemory[] = [];
  const minScore = options?.minScore;

  for (const res of results) {
    const entry = res.entry;
    const relevanceScore = Math.max(0, Math.min(1, res.score));
    const recencyScore = calculateRecencyScore(entry, nowIso, options?.decay);
    const importanceScore = Math.max(0, Math.min(1, entry.importance));

    const compositeScore = blendScores(
      relevanceScore,
      recencyScore,
      importanceScore,
      options?.weights,
    );

    if (minScore !== undefined && compositeScore < minScore) {
      continue;
    }

    scoredList.push({
      entry,
      score: compositeScore,
      relevanceScore,
      recencyScore,
      importanceScore,
      highlights: res.highlights,
    });
  }

  scoredList.sort((a, b) => b.score - a.score);

  if (options?.limit !== undefined && options.limit > 0) {
    return scoredList.slice(0, options.limit);
  }

  return scoredList;
}

/**
 * Default markdown formatter for injecting a memory entry into an LLM prompt.
 */
export function defaultFormatMemoryEntry(entry: MemoryEntry, score: number): string {
  const pct = Math.round(score * 100);
  const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
  return `### ${entry.title}${tagsStr} (score: ${pct}%)\n${entry.content}`;
}

// ============================================================================
// High-Level Context Retrieval
// ============================================================================

/**
 * Retrieves relevant memories from a MemoryStore, ranks them using relevance/recency/importance,
 * and packs them greedily into the provided token budget.
 *
 * @param options Context retrieval options including store, query, tokenBudget, and filters
 * @returns RetrievedContext containing selected entries, formattedContext string, and accounting
 */
export async function retrieveForContext(
  options: RetrieveForContextOptions,
): Promise<RetrievedContext> {
  if (options.tokenBudget <= 0) {
    throw new AirError('INVALID_ARGUMENT', `tokenBudget must be positive, got ${options.tokenBudget}`);
  }
  if (!options.query || options.query.trim().length === 0) {
    throw new AirError('INVALID_ARGUMENT', 'query cannot be empty');
  }

  const clock = options.clock ?? new SystemClock();
  const nowIso = clock.iso();
  const tokenizer = options.tokenizer ?? estimateTextTokens;
  const formatEntry = options.formatEntry ?? defaultFormatMemoryEntry;
  const candidateLimit = options.candidateLimit ?? 50;

  // 1. Fetch search candidates from backing store
  const searchResults = await options.store.search({
    query: options.query,
    filter: options.filter,
    mode: options.mode ?? 'hybrid',
    vector: options.vector,
    limit: candidateLimit,
  });

  // 2. Score and rank candidates using blended ranking
  const ranked = rankSearchResults(searchResults, nowIso, {
    weights: options.weights,
    decay: options.decay,
    minScore: options.minScore,
  });

  // 3. Greedily pack memories into the token budget
  const packedEntries: ScoredMemory[] = [];
  const formattedSections: string[] = [];
  let totalTokens = 0;
  let budgetExceeded = false;

  for (const candidate of ranked) {
    const formatted = formatEntry(candidate.entry, candidate.score);
    const tokens = tokenizer(formatted);

    if (totalTokens + tokens <= options.tokenBudget) {
      packedEntries.push(candidate);
      formattedSections.push(formatted);
      totalTokens += tokens;
    } else {
      budgetExceeded = true;
      // Continue checking subsequent smaller entries that might fit
    }
  }

  // 4. Assemble final markdown context block
  let formattedContext = '';
  if (formattedSections.length > 0) {
    formattedContext = [
      '# Relevant Context from Memory',
      ...formattedSections,
    ].join('\n\n');
  }

  return {
    entries: packedEntries,
    formattedContext,
    totalTokens,
    budget: options.tokenBudget,
    budgetExceeded,
  };
}
