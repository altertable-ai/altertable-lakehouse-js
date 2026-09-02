import assert from 'node:assert/strict';
import test from 'node:test';

import packageJson from '../package.json' with { type: 'json' };
import {
  AltertableLakehouseClient,
  AuthError,
  ConfigurationError,
  ParseError,
  QueryError,
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
          JSON.stringify([{ name: 'answer', type: 'INTEGER' }]),
          JSON.stringify([42]),
        ]),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      ),
  });

  const result = await client.queryAll({ statement: 'SELECT 42 AS answer' });
  assert.equal(result.metadata.statement, 'SELECT 42 AS answer');
  assert.deepEqual(result.columns, [{ name: 'answer', type: 'INTEGER' }]);
  assert.deepEqual(result.rows, [{ answer: 42 }]);
});

test('query exposes async row iteration', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async () =>
      new Response(
        makeNdjsonStream([
          JSON.stringify({ statement: 'SELECT 1 AS id, 2 AS value' }),
          JSON.stringify([
            { name: 'id', type: 'INTEGER' },
            { name: 'value', type: 'INTEGER' },
          ]),
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
          JSON.stringify([{ name: 'value', type: 'INTEGER' }]),
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

test('append sends a single row as a raw JSON object', async () => {
  let body = '';
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.append({
    catalog: 'memory',
    schema: 'main',
    table: 'events',
    body: { user_id: 1, action: 'signup' },
  });

  assert.deepEqual(JSON.parse(body), { user_id: 1, action: 'signup' });
});

test('append sends multiple rows as a raw JSON array', async () => {
  let body = '';
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async (_input, init) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await client.append({
    catalog: 'memory',
    schema: 'main',
    table: 'events',
    body: [
      { user_id: 2, action: 'login' },
      { user_id: 3, action: 'purchase' },
    ],
  });

  assert.deepEqual(JSON.parse(body), [
    { user_id: 2, action: 'login' },
    { user_id: 3, action: 'purchase' },
  ]);
});

test('upsert posts to upsert endpoint without format query parameter or content type', async () => {
  let requestedUrl: string | undefined;
  let requestedContentType: string | null = null;
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async (input, init) => {
      requestedUrl = String(input);
      requestedContentType = new Headers(init?.headers).get('Content-Type');
      return new Response('', { status: 200 });
    },
  });

  await client.upsert(
    {
      catalog: 'memory',
      schema: 'main',
      table: 'items',
      primary_key: 'account_id,item_id',
      cursor_field: 'updated_at,sequence',
    },
    '{"id":1}',
  );

  assert.ok(requestedUrl?.includes('/upsert?'));
  assert.ok(!requestedUrl?.includes('format='));
  assert.ok(requestedUrl?.includes('primary_key=account_id%2Citem_id'));
  assert.ok(requestedUrl?.includes('cursor_field=updated_at%2Csequence'));
  assert.equal(requestedContentType, null);
});

test('upload sends create_append mode to the upload endpoint', async () => {
  let requestedUrl: string | undefined;
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async (input) => {
      requestedUrl = String(input);
      return new Response('', { status: 200 });
    },
  });

  await client.upload(
    { catalog: 'memory', schema: 'main', table: 'items', mode: 'create_append' },
    'id,name\n1,Alice\n',
  );

  assert.ok(requestedUrl?.includes('/upload?'));
  assert.ok(requestedUrl?.includes('mode=create_append'));
});

test('query stream errors raise QueryError with line context', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async () => new Response(makeNdjsonStream([
      JSON.stringify({ statement: 'SELECT * FROM missing' }),
      JSON.stringify({ error: 'Catalog Error: table missing' }),
    ]), { status: 200 }),
  });

  await assert.rejects(() => client.query({ statement: 'SELECT * FROM missing' }), (error: unknown) => {
    assert.ok(error instanceof QueryError);
    assert.equal(error.lineIndex, 1);
    assert.equal(error.rawLine, '{"error":"Catalog Error: table missing"}');
    return true;
  });
});

test('query row stream errors stop iteration with QueryError', async () => {
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'token',
    fetch: async () => new Response(makeNdjsonStream([
      JSON.stringify({ statement: 'SELECT * FROM events' }),
      JSON.stringify([{ name: 'id', type: 'INTEGER' }]),
      JSON.stringify([1]),
      JSON.stringify({ error: 'stream interrupted' }),
    ]), { status: 200 }),
  });

  const result = await client.query({ statement: 'SELECT * FROM events' });
  const rows: Array<Record<string, unknown>> = [];
  await assert.rejects(async () => {
    for await (const row of result.rows) rows.push(row);
  }, QueryError);
  assert.deepEqual(rows, [{ id: 1 }]);
});

test('AUTO compute size cannot be combined with a session id', async () => {
  const client = new AltertableLakehouseClient({ basicAuthToken: 'token', fetch: globalThis.fetch });
  await assert.rejects(
    () => client.query({ statement: 'SELECT 1', compute_size: 'AUTO', session_id: 'session' }),
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
  const expectedUserAgent = `altertable-lakehouse-js/${packageJson.version}`;
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
    userAgent: expectedUserAgent,
    headers: {
      authorization: 'Basic [REDACTED]',
      'user-agent': expectedUserAgent,
    },
  });
});
