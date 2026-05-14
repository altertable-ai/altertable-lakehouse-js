import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AltertableLakehouseClient,
  AuthError,
  ConfigurationError,
  ParseError,
} from '../src/index.js';

const encoder = new TextEncoder();

function makeNdjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

test('requires credentials at construction time', () => {
  const username = process.env.ALTERTABLE_USERNAME;
  const password = process.env.ALTERTABLE_PASSWORD;
  const token = process.env.ALTERTABLE_BASIC_AUTH_TOKEN;
  delete process.env.ALTERTABLE_USERNAME;
  delete process.env.ALTERTABLE_PASSWORD;
  delete process.env.ALTERTABLE_BASIC_AUTH_TOKEN;

  assert.throws(() => new AltertableLakehouseClient({ fetch: globalThis.fetch }), ConfigurationError);

  if (username) process.env.ALTERTABLE_USERNAME = username;
  if (password) process.env.ALTERTABLE_PASSWORD = password;
  if (token) process.env.ALTERTABLE_BASIC_AUTH_TOKEN = token;
});

test('uses direct credentials for Authorization header', async () => {
  let authorization = '';
  const client = new AltertableLakehouseClient({
    username: 'testuser',
    password: 'testpass',
    fetch: async (_input, init) => {
      authorization = String(new Headers(init?.headers).get('authorization'));
      return new Response(JSON.stringify({ valid: true, statement: 'SELECT 1', connections_errors: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.validate({ statement: 'SELECT 1' });
  assert.equal(authorization, `Basic ${Buffer.from('testuser:testpass').toString('base64')}`);
});

test('queryAll accumulates metadata, columns, and rows', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async () =>
      new Response(
        makeNdjsonStream([
          JSON.stringify({ statement: 'SELECT 42 AS answer', query_id: 'q1', session_id: 's1' }),
          JSON.stringify(['answer']),
          JSON.stringify([42]),
        ]),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      ),
  });

  const result = await client.queryAll({ statement: 'SELECT 42 AS answer' });
  assert.equal(result.metadata.statement, 'SELECT 42 AS answer');
  assert.deepEqual(result.columns, ['answer']);
  assert.deepEqual(result.rows, [{ answer: 42 }]);
});

test('query exposes async row iteration', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async () =>
      new Response(
        makeNdjsonStream([
          JSON.stringify({ statement: 'SELECT 1 AS id, 2 AS value' }),
          JSON.stringify(['id', 'value']),
          JSON.stringify([1, 2]),
          JSON.stringify([3, 4]),
        ]),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      ),
  });

  const result = await client.query({ statement: 'SELECT 1 AS id, 2 AS value' });
  const rows = [];
  for await (const row of result.rows) {
    rows.push(row);
  }

  assert.deepEqual(rows, [
    { id: 1, value: 2 },
    { id: 3, value: 4 },
  ]);
});

test('query parse failures include line context', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async () =>
      new Response(
        makeNdjsonStream([
          JSON.stringify({ statement: 'SELECT 1' }),
          JSON.stringify(['value']),
          'not-json',
        ]),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      ),
  });

  const result = await client.query({ statement: 'SELECT 1' });
  await assert.rejects(async () => {
    for await (const _row of result.rows) {
      // iterate fully
    }
  }, (error: unknown) => {
    assert.ok(error instanceof ParseError);
    assert.equal(error.lineIndex, 2);
    assert.equal(error.rawLine, 'not-json');
    return true;
  });
});

test('upload requires primary_key for upsert mode', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: globalThis.fetch,
  });

  await assert.rejects(
    () =>
      client.upload(
        {
          catalog: 'memory',
          schema: 'main',
          table: 'items',
          format: 'json',
          mode: 'upsert',
        },
        '{"id":1}',
      ),
    ConfigurationError,
  );
});

test('401 responses raise AuthError', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'bad-token',
    fetch: async () => new Response('unauthorized', { status: 401 }),
  });

  await assert.rejects(() => client.validate({ statement: 'SELECT 1' }), AuthError);
});

test('debugConfiguration redacts credentials', () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'super-secret',
    fetch: globalThis.fetch,
  });

  assert.deepEqual(client.debugConfiguration(), {
    baseUrl: 'https://api.altertable.ai',
    connectTimeoutMs: 5000,
    readTimeoutMs: 60000,
    retryPolicy: {
      maxAttempts: 2,
      baseDelayMs: 200,
      maxDelayMs: 1000,
      retryOnStatuses: [408, 429, 500, 502, 503, 504],
    },
    userAgent: 'altertable-lakehouse-js/0.1.0',
    headers: {
      authorization: 'Basic [REDACTED]',
      'user-agent': 'altertable-lakehouse-js/0.1.0',
    },
  });
});
