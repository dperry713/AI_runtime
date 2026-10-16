/**
 * Redaction engine enforcing Rule R4: Never log secrets.
 * Supports registered secret strings, regex pattern matching, and sensitive field-name filtering.
 */

const registeredSecrets = new Map<string, string>();

const SENSITIVE_KEY_PATTERN = /(?:password|secret|token|apikey|api_key|authorization|cookie)/i;

const COMMON_SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Bearer tokens
  { pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, replacement: 'Bearer [REDACTED]' },
  // OpenAI / Anthropic keys
  { pattern: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED:api-key]' },
  // NVIDIA NIM API keys
  { pattern: /nvapi-[a-zA-Z0-9_-]{20,}/g, replacement: '[REDACTED:nvapi-key]' },
  // Private keys
  { pattern: /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g, replacement: '[REDACTED:private-key]' },
  // HTTP Authorization / Cookie headers in raw text
  { pattern: /(?:authorization|cookie|set-cookie):\s*[^\r\n]+/gi, replacement: '$1: [REDACTED]' },
];

export function registerSecret(name: string, value: string): void {
  const trimmed = value.trim();
  if (trimmed.length >= 4) {
    registeredSecrets.set(name, trimmed);
  }
}

export function unregisterSecret(name: string): void {
  registeredSecrets.delete(name);
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

export function redactString(text: string): string {
  if (!text || typeof text !== 'string') return text;

  let result = text;

  // 1. Registered secrets (exact, URL-encoded, base64, JSON-escaped)
  for (const [name, secret] of registeredSecrets.entries()) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, `[REDACTED:${name}]`);
    }

    try {
      const urlEncoded = encodeURIComponent(secret);
      if (urlEncoded !== secret && result.includes(urlEncoded)) {
        result = result.replaceAll(urlEncoded, `[REDACTED:${name}]`);
      }
    } catch {
      // Ignore URL encode errors
    }

    try {
      const b64 = Buffer.from(secret, 'utf-8').toString('base64');
      if (b64.length >= 8 && result.includes(b64)) {
        result = result.replaceAll(b64, `[REDACTED:${name}]`);
      }
    } catch {
      // Ignore base64 errors
    }

    try {
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      if (jsonEscaped !== secret && result.includes(jsonEscaped)) {
        result = result.replaceAll(jsonEscaped, `[REDACTED:${name}]`);
      }
    } catch {
      // Ignore JSON escape errors
    }
  }

  // 2. Pattern redactors
  for (const { pattern, replacement } of COMMON_SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }

  return result;
}

export function redactObject<T>(input: T, seen = new WeakSet<object>()): T {
  if (input === null || typeof input !== 'object') {
    if (typeof input === 'string') {
      return redactString(input) as unknown as T;
    }
    return input;
  }

  if (seen.has(input)) {
    return '[Circular]' as unknown as T;
  }
  seen.add(input);

  if (Array.isArray(input)) {
    return (input as unknown[]).map((item: unknown) => redactObject(item, seen)) as unknown as T;
  }

  if (input instanceof Error) {
    const errorObj: Record<string, unknown> = {
      message: redactString(input.message),
      name: input.name,
    };
    if (input.stack) {
      errorObj['stack'] = redactString(input.stack);
    }
    for (const [key, val] of Object.entries(input)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        errorObj[key] = `[REDACTED:${key}]`;
      } else {
        errorObj[key] = redactObject(val, seen);
      }
    }
    return errorObj as unknown as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      output[key] = `[REDACTED:${key}]`;
    } else {
      output[key] = redactObject(value, seen);
    }
  }

  return output as unknown as T;
}
