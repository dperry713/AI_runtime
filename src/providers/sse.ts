/**
 * Server-Sent Events (SSE) stream parser for streaming provider adapters.
 */

import { AirError } from '../errors/index.js';

function isAsyncIterable<T>(val: unknown): val is AsyncIterable<T> {
  return typeof val === 'object' && val !== null && Symbol.asyncIterator in val;
}

export interface SseEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Robust Server-Sent Events (SSE) parser supporting chunk fragmentation,
 * multi-line data, comments, and cancellation.
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
  signal?: AbortSignal
): AsyncIterable<SseEvent> {
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

  let currentEvent = 'message';
  const dataLines: string[] = [];

  for await (const chunk of iterable) {
    if (signal?.aborted) {
      throw new AirError('CANCELLED', 'SSE stream aborted by signal', {
        retryable: false,
      });
    }

    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith(':')) {
        // Comment/ping
        continue;
      }

      if (line === '') {
        if (dataLines.length > 0) {
          yield {
            event: currentEvent,
            data: dataLines.join('\n'),
          };
          dataLines.length = 0;
          currentEvent = 'message';
        }
        continue;
      }

      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    const lines = buffer.split(/\r?\n/);
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length > 0) {
      yield {
        event: currentEvent,
        data: dataLines.join('\n'),
      };
    }
  }
}
