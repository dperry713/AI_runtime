/**
 * Newline-Delimited JSON (NDJSON) stream parser for streaming provider adapters (e.g. Ollama).
 */

import { AirError } from '../errors/index.js';

function isAsyncIterable<T>(val: unknown): val is AsyncIterable<T> {
  return typeof val === 'object' && val !== null && Symbol.asyncIterator in val;
}

/**
 * Robust NDJSON parser supporting chunk fragmentation across arbitrary slices,
 * empty line filtering, and cancellation.
 */
export async function* parseNdjsonStream<T = unknown>(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<T> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const iterable: AsyncIterable<Uint8Array> = isAsyncIterable<Uint8Array>(stream)
    ? stream
    : {
        [Symbol.asyncIterator]() {
          const reader = (stream as ReadableStream<Uint8Array>).getReader();
          return {
            async next() {
              const { done, value } = await reader.read();
              if (done) {
                return { done: true, value: undefined };
              }
              return { done: false, value };
            },
            async return() {
              await reader.cancel();
              reader.releaseLock();
              return { done: true, value: undefined };
            },
          };
        },
      };

  for await (const chunk of iterable) {
    if (signal?.aborted) {
      throw new AirError('CANCELLED', 'NDJSON stream aborted by signal', {
        retryable: false,
      });
    }

    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = JSON.parse(trimmed) as T;
        yield parsed;
      } catch {
        // Skip malformed individual line in NDJSON stream
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as T;
        yield parsed;
      } catch {
        // Skip malformed trailing line
      }
    }
  }
}
