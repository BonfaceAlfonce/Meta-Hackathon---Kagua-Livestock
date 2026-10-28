/**
 * Minimal Meta Model API client for structured (JSON-schema) chat completions.
 *
 * Follows https://dev.meta.ai/docs/structured-output and /docs/error-handling:
 * - response_format json_schema with strict: true
 * - retry only 429/500/503, honouring Retry-After; never retry 4xx or 504 unchanged
 * Uses fetch directly (no SDK), so it runs in Deno and Node and is easy to mock.
 */

export const MUSE_SPARK_MODEL = 'muse-spark-1.3';
const ENDPOINT = 'https://api.meta.ai/v1/chat/completions';
const RETRYABLE = new Set([429, 500, 503]);

export type ChatMessage = { role: 'system' | 'user'; content: string };

export interface StructuredCallOptions {
  apiKey: string;
  messages: ChatMessage[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxCompletionTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** Upper bound on any single wait, so callers stay inside platform time limits. */
  maxRetryDelayMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class MuseSparkError extends Error {
  constructor(message: string, readonly status: number | null, readonly retryable: boolean) {
    super(message);
    this.name = 'MuseSparkError';
  }
}

export interface StructuredResult<T> {
  data: T;
  usage: { promptTokens: number; completionTokens: number } | null;
  attempts: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function retryDelayMs(attempt: number, retryAfter: string | null, cap: number, random: () => number): number {
  const seconds = retryAfter === null ? NaN : Number(retryAfter);
  const base = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 500 * 2 ** attempt + random() * 1000;
  return Math.min(base, cap);
}

export async function callMuseSparkStructured<T>(options: StructuredCallOptions): Promise<StructuredResult<T>> {
  const {
    apiKey,
    messages,
    schemaName,
    schema,
    maxCompletionTokens = 700,
    timeoutMs = 25_000,
    maxRetries = 2,
    maxRetryDelayMs = 5_000,
    fetchImpl = fetch,
    sleep = defaultSleep,
    random = Math.random,
  } = options;
  if (!apiKey) throw new MuseSparkError('MODEL_API_KEY is not configured.', null, false);

  const body = JSON.stringify({
    model: MUSE_SPARK_MODEL,
    messages,
    max_completion_tokens: maxCompletionTokens,
    reasoning_effort: 'low',
    response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } },
  });

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new MuseSparkError(aborted ? `Request timed out after ${timeoutMs} ms.` : 'Network error calling Meta Model API.', null, false);
    }
    clearTimeout(timer);

    if (!response.ok) {
      let detail = '';
      try {
        const payload = await response.json();
        detail = payload?.error?.type ? ` (${payload.error.type})` : '';
      } catch {
        // Some errors (e.g. 404) have empty bodies.
      }
      const retryable = RETRYABLE.has(response.status);
      if (retryable && attempt < maxRetries) {
        await sleep(retryDelayMs(attempt, response.headers.get('retry-after'), maxRetryDelayMs, random));
        continue;
      }
      throw new MuseSparkError(`Meta Model API returned ${response.status}${detail}.`, response.status, retryable);
    }

    const payload = await response.json();
    const choice = payload?.choices?.[0];
    const message = choice?.message;
    if (!message) throw new MuseSparkError('Response had no choices.', response.status, false);
    if (message.refusal) throw new MuseSparkError('Model refused the request.', response.status, false);
    if (choice.finish_reason !== 'stop') {
      throw new MuseSparkError(`Generation ended with finish_reason "${choice.finish_reason}".`, response.status, false);
    }
    if (typeof message.content !== 'string') throw new MuseSparkError('Response content was empty.', response.status, false);

    let data: T;
    try {
      data = JSON.parse(message.content) as T;
    } catch {
      throw new MuseSparkError('Response content was not valid JSON.', response.status, false);
    }
    const usage = payload.usage
      ? { promptTokens: payload.usage.prompt_tokens, completionTokens: payload.usage.completion_tokens }
      : null;
    return { data, usage, attempts: attempt + 1 };
  }
}
