# Altertable Lakehouse JS/TS SDK

TypeScript-first client for the Altertable Lakehouse API.

## Installation

```bash
npm install @altertable/lakehouse
```

## Configuration

```ts
import { AltertableLakehouseClient } from '@altertable/lakehouse';

const client = new AltertableLakehouseClient({
  username: process.env.ALTERTABLE_USERNAME,
  password: process.env.ALTERTABLE_PASSWORD,
  // or basicAuthToken: process.env.ALTERTABLE_BASIC_AUTH_TOKEN,
  userAgentSuffix: 'my-app/1.0.0',
});
```

The client defaults to `https://api.altertable.ai`, uses HTTP Basic auth, enables configurable retries, and uses a 60s default read timeout. Override `baseUrl`, `connectTimeoutMs`, `readTimeoutMs`, and `retryPolicy` when needed.

## Examples

### append

```ts
await client.append({
  catalog: 'memory',
  schema: 'main',
  table: 'events',
  body: { Single: { user_id: 1, action: 'signup' } },
});
```

### query (streamed)

```ts
const result = await client.query({ statement: 'SELECT 42 AS answer' });
console.log(result.metadata);
console.log(result.columns);
for await (const row of result.rows) {
  console.log(row);
}
```

### queryAll

```ts
const result = await client.queryAll({ statement: 'SELECT 42 AS answer' });
console.log(result.rows);
```

### getQuery

```ts
const log = await client.getQuery('123e4567-e89b-12d3-a456-426614174000');
console.log(log);
```

### cancelQuery

```ts
const cancelled = await client.cancelQuery(
  '123e4567-e89b-12d3-a456-426614174000',
  '123e4567-e89b-12d3-a456-426614174001',
);
console.log(cancelled);
```

### upload

```ts
await client.upload(
  {
    catalog: 'memory',
    schema: 'main',
    table: 'events',
    format: 'csv',
    mode: 'create',
  },
  'id,name\n1,Alice\n',
);
```

### validate

```ts
const validation = await client.validate({ statement: 'SELECT 1' });
console.log(validation.valid);
```

## Development

```bash
npm install
npm run lint
npm test
npm run build
```
