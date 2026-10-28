import { describe, expect, it, vi } from 'vitest';
import { callMuseSparkStructured, MUSE_SPARK_MODEL, MuseSparkError } from './museSpark.ts';

function okResponse(content: unknown, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), refusal: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
      ...extra,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function errorResponse(status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: { message: 'x', type: 'server_error', param: null, code: null } }), { status, headers });
}

const base = {
  apiKey: 'test-key',
  messages: [{ role: 'user' as const, content: 'hi' }],
  schemaName: 'note',
  schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
  sleep: vi.fn(async () => {}),
  random: () => 0,
};

describe('callMuseSparkStructured', () => {
  it('sends a strict json_schema request and parses the JSON content', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ a: 'hello' }));
    const result = await callMuseSparkStructured<{ a: string }>({ ...base, fetchImpl });

    expect(result).toEqual({ data: { a: 'hello' }, usage: { promptTokens: 120, completionTokens: 40 }, attempts: 1 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(MUSE_SPARK_MODEL);
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'note', schema: base.schema, strict: true } });
    expect(body.max_completion_tokens).toBe(700);
  });

  it('retries 503 honouring Retry-After (capped), then succeeds', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(503, { 'Retry-After': '60' }))
      .mockResolvedValueOnce(okResponse({ a: 'ok' }));
    const result = await callMuseSparkStructured({ ...base, fetchImpl, sleep });
    expect(result.attempts).toBe(2);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('retries 429 and 500 with exponential backoff', async () => {
    const sleep = vi.fn(async () => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(errorResponse(500))
      .mockResolvedValueOnce(okResponse({ a: 'ok' }));
    await callMuseSparkStructured({ ...base, fetchImpl, sleep });
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it('gives up after maxRetries on a retryable error', async () => {
    const fetchImpl = vi.fn(async () => errorResponse(503));
    await expect(callMuseSparkStructured({ ...base, fetchImpl, maxRetries: 2 })).rejects.toMatchObject({ status: 503, retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 402, 404, 504])('never retries %i', async (status) => {
    const fetchImpl = vi.fn(async () => errorResponse(status));
    await expect(callMuseSparkStructured({ ...base, fetchImpl })).rejects.toBeInstanceOf(MuseSparkError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects refusals, truncated output and invalid JSON', async () => {
    const refusal = new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] }), { status: 200 });
    await expect(callMuseSparkStructured({ ...base, fetchImpl: vi.fn(async () => refusal) })).rejects.toThrow('refused');

    const truncated = new Response(JSON.stringify({ choices: [{ message: { content: '{"a":', refusal: null }, finish_reason: 'length' }] }), { status: 200 });
    await expect(callMuseSparkStructured({ ...base, fetchImpl: vi.fn(async () => truncated) })).rejects.toThrow('finish_reason "length"');

    await expect(callMuseSparkStructured({ ...base, fetchImpl: vi.fn(async () => okResponse('not json')) })).rejects.toThrow('not valid JSON');
  });

  it('fails fast without an API key and converts timeouts into errors', async () => {
    await expect(callMuseSparkStructured({ ...base, apiKey: '', fetchImpl: vi.fn() })).rejects.toThrow('MODEL_API_KEY');

    const hanging = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        }),
    );
    await expect(callMuseSparkStructured({ ...base, fetchImpl: hanging as unknown as typeof fetch, timeoutMs: 10 })).rejects.toThrow('timed out');
  });
});
