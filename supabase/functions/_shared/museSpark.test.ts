import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { callMuseSparkStructured, MUSE_SPARK_MODEL, MuseSparkError } from './museSpark.ts';

function okResponse(content: unknown) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: typeof content === 'string' ? content : JSON.stringify(content), refusal: null }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function errorResponse(status: number, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify({ error: { message: 'x', type: 'server_error', param: null, code: null } }), { status, headers });
}

/** A fetch mock that returns the given responses in order. */
function fetchSequence(...responses: Response[]) {
  return mock.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('fetch called more times than expected');
    return next;
  });
}

const sleepMock = () => mock.fn(async (_ms: number) => {});

const base = {
  apiKey: 'test-key',
  messages: [{ role: 'user' as const, content: 'hi' }],
  schemaName: 'note',
  schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false },
  sleep: async () => {},
  random: () => 0,
};

describe('callMuseSparkStructured', () => {
  it('sends a strict json_schema request and parses the JSON content', async () => {
    const fetchImpl = fetchSequence(okResponse({ a: 'hello' }));
    const result = await callMuseSparkStructured<{ a: string }>({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });

    assert.deepEqual(result, { data: { a: 'hello' }, usage: { promptTokens: 120, completionTokens: 40 }, attempts: 1 });
    const [url, init] = fetchImpl.mock.calls[0].arguments as [string, RequestInit];
    assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer test-key');
    const body = JSON.parse(init.body as string);
    assert.equal(body.model, MUSE_SPARK_MODEL);
    assert.deepEqual(body.response_format, { type: 'json_schema', json_schema: { name: 'note', schema: base.schema, strict: true } });
    assert.equal(body.max_completion_tokens, 700);
  });

  it('retries 503 honouring Retry-After (capped), then succeeds', async () => {
    const sleep = sleepMock();
    const fetchImpl = fetchSequence(errorResponse(503, { 'Retry-After': '60' }), okResponse({ a: 'ok' }));
    const result = await callMuseSparkStructured({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    assert.equal(result.attempts, 2);
    assert.deepEqual(sleep.mock.calls[0].arguments, [5000]);
  });

  it('retries 429 and 500 with exponential backoff', async () => {
    const sleep = sleepMock();
    const fetchImpl = fetchSequence(errorResponse(429), errorResponse(500), okResponse({ a: 'ok' }));
    await callMuseSparkStructured({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    assert.deepEqual(sleep.mock.calls.map((call) => call.arguments), [[500], [1000]]);
  });

  it('gives up after maxRetries on a retryable error', async () => {
    const fetchImpl = fetchSequence(errorResponse(503), errorResponse(503), errorResponse(503));
    await assert.rejects(
      callMuseSparkStructured({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2 }),
      (error: unknown) => error instanceof MuseSparkError && error.status === 503 && error.retryable === true,
    );
    assert.equal(fetchImpl.mock.callCount(), 3);
  });

  for (const status of [400, 401, 402, 404, 504]) {
    it(`never retries ${status}`, async () => {
      const fetchImpl = fetchSequence(errorResponse(status));
      await assert.rejects(callMuseSparkStructured({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch }), MuseSparkError);
      assert.equal(fetchImpl.mock.callCount(), 1);
    });
  }

  it('rejects refusals, truncated output and invalid JSON', async () => {
    const refusal = new Response(JSON.stringify({ choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] }), { status: 200 });
    await assert.rejects(callMuseSparkStructured({ ...base, fetchImpl: fetchSequence(refusal) as unknown as typeof fetch }), /refused/);

    const truncated = new Response(JSON.stringify({ choices: [{ message: { content: '{"a":', refusal: null }, finish_reason: 'length' }] }), { status: 200 });
    await assert.rejects(callMuseSparkStructured({ ...base, fetchImpl: fetchSequence(truncated) as unknown as typeof fetch }), /finish_reason "length"/);

    await assert.rejects(callMuseSparkStructured({ ...base, fetchImpl: fetchSequence(okResponse('not json')) as unknown as typeof fetch }), /not valid JSON/);
  });

  it('fails fast without an API key and converts timeouts into errors', async () => {
    const unused = fetchSequence();
    await assert.rejects(callMuseSparkStructured({ ...base, apiKey: '', fetchImpl: unused as unknown as typeof fetch }), /MODEL_API_KEY/);
    assert.equal(unused.mock.callCount(), 0);

    const hanging = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    await assert.rejects(callMuseSparkStructured({ ...base, fetchImpl: hanging as unknown as typeof fetch, timeoutMs: 10 }), /timed out/);
  });
});
