import assert from 'node:assert/strict';
import test from 'node:test';
import { AltertableLakehouseClient } from '../src/index.js';

test('query preserves UTF-8 and lines at every possible byte boundary', async () => {
  const bytes = new TextEncoder().encode(
    '{}\n[{"name":"name","type":"VARCHAR"}]\n["Zoë 🦀"]\n["last"]',
  );
  for (let split = 1; split < bytes.length; split++) {
    const client = new AltertableLakehouseClient({
      basicAuthToken: 'test',
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      })),
    });
    const result = await client.queryAll({ statement: 'SELECT name' });
    assert.deepEqual(result.rows, [{ name: 'Zoë 🦀' }, { name: 'last' }], `split ${split}`);
  }
});

test('query yields a row while the response is still open', { timeout: 2000 }, async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const client = new AltertableLakehouseClient({
    basicAuthToken: 'test', fetch: async () => new Response(body),
  });
  controller.enqueue(new TextEncoder().encode('{}\n[{"name":"id","type":"INTEGER"}]\n[1]\n'));
  try {
    const result = await client.query({ statement: 'SELECT id' });
    const rows = result.rows[Symbol.asyncIterator]();
    assert.deepEqual(await rows.next(), { done: false, value: { id: 1 } });
    controller.enqueue(new TextEncoder().encode('[2]'));
    controller.close();
    assert.deepEqual(await rows.next(), { done: false, value: { id: 2 } });
    assert.equal((await rows.next()).done, true);
  } finally {
    if (!body.locked) await body.cancel();
  }
});
