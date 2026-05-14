import {
  ApiError,
  AuthError,
  BadRequestError,
  ConfigurationError,
  NetworkError,
  ParseError,
  SerializationError,
  TimeoutError,
} from './errors.js';
import type {
  AppendRequest,
  AppendResponse,
  ClientOptions,
  QueryAllResult,
  QueryColumn,
  QueryLogResponse,
  QueryMetadata,
  QueryRequest,
  QueryRow,
  QueryStreamResult,
  RetryPolicy,
  UploadOptions,
  ValidateRequest,
  ValidateResponse,
  CancelQueryResponse,
} from './types.js';

const DEFAULT_BASE_URL = 'https://api.altertable.ai';
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_READ_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxAttempts: 2,
  baseDelayMs: 200,
  maxDelayMs: 1_000,
  retryOnStatuses: [408, 429, 500, 502, 503, 504],
};
import packageJson from '../package.json' with { type: 'json' };

const USER_AGENT = `${packageJson.name.replace(/^@[^/]+\//, '')}/${packageJson.version}`;

function encodeBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function resolveBasicAuthToken(options: ClientOptions): string {
  if (options.basicAuthToken) {
    return options.basicAuthToken;
  }

  if (options.username && options.password) {
    return encodeBasicAuth(options.username, options.password);
  }

  const envToken = process.env.ALTERTABLE_BASIC_AUTH_TOKEN;
  if (envToken) {
    return envToken;
  }

  const envUsername = process.env.ALTERTABLE_USERNAME;
  const envPassword = process.env.ALTERTABLE_PASSWORD;
  if (envUsername && envPassword) {
    return encodeBasicAuth(envUsername, envPassword);
  }

  throw new ConfigurationError('No Altertable credentials could be resolved.', {
    operation: 'configureClient',
    path: '/',
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mergeRetryPolicy(policy?: RetryPolicy): Required<RetryPolicy> {
  return {
    ...DEFAULT_RETRY_POLICY,
    ...policy,
    retryOnStatuses: policy?.retryOnStatuses ?? DEFAULT_RETRY_POLICY.retryOnStatuses,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function sanitizeBody(body: string): string {
  return body.length > 1_000 ? `${body.slice(0, 1_000)}…` : body;
}

function headersObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

export class AltertableLakehouseClient {
  readonly baseUrl: string;
  readonly connectTimeoutMs: number;
  readonly readTimeoutMs: number;
  readonly retryPolicy: Required<RetryPolicy>;
  private readonly authToken: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly userAgent: string;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.retryPolicy = mergeRetryPolicy(options.retryPolicy);
    this.authToken = resolveBasicAuthToken(options);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.userAgent = options.userAgentSuffix ? `${USER_AGENT} ${options.userAgentSuffix}` : USER_AGENT;
  }

  async append(params: { catalog: string; schema: string; table: string; body: AppendRequest }): Promise<AppendResponse> {
    return this.requestJson<AppendResponse>({
      operation: 'append',
      method: 'POST',
      path: '/append',
      query: {
        catalog: params.catalog,
        schema: params.schema,
        table: params.table,
      },
      body: params.body,
    });
  }

  async query(request: QueryRequest): Promise<QueryStreamResult> {
    const response = await this.request({
      operation: 'query',
      method: 'POST',
      path: '/query',
      body: request,
      headers: {
        Accept: 'application/x-ndjson',
      },
    });

    const reader = response.body?.getReader();
    if (!reader) {
      throw new ParseError('Expected streaming response body', 0, '', {
        operation: 'query',
        method: 'POST',
        path: '/query',
      });
    }

    const decoder = new TextDecoder();
    const streamReader = reader;
    const metadataLine = await this.readNextLine(streamReader, decoder, 'query');
    const columnsLine = await this.readNextLine(streamReader, decoder, 'query');
    const metadata = this.parseMetadataLine(metadataLine);
    const columns = this.parseColumnsLine(columnsLine);

    const self = this;
    async function* rows(): AsyncIterable<QueryRow> {
      let buffer = '';
      let lineIndex = 2;
      for (;;) {
        const { done, value } = await streamReader.read();
        if (done) {
          if (buffer.trim().length > 0) {
            yield self.parseRowLine(buffer, lineIndex, columns);
          }
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line.length > 0) {
            yield self.parseRowLine(line, lineIndex, columns);
            lineIndex += 1;
          }
          newlineIndex = buffer.indexOf('\n');
        }
      }
    }

    return { metadata, columns, rows: rows() };
  }

  async queryAll(request: QueryRequest): Promise<QueryAllResult> {
    const streamed = await this.query(request);
    const rows: QueryRow[] = [];
    for await (const row of streamed.rows) {
      rows.push(row);
    }
    return {
      metadata: streamed.metadata,
      columns: streamed.columns,
      rows,
    };
  }

  async upload(options: UploadOptions, body: ArrayBuffer | ArrayBufferView | Blob | string): Promise<void> {
    if (options.mode === 'upsert' && !options.primary_key) {
      throw new ConfigurationError('primary_key is required when mode=upsert', {
        operation: 'upload',
        method: 'POST',
        path: '/upload',
      });
    }

    await this.request({
      operation: 'upload',
      method: 'POST',
      path: '/upload',
      query: {
        catalog: options.catalog,
        schema: options.schema,
        table: options.table,
        format: options.format,
        mode: options.mode,
        primary_key: options.primary_key,
      },
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      rawBody: body,
    });
  }

  async getQuery(queryId: string): Promise<QueryLogResponse> {
    return this.requestJson<QueryLogResponse>({
      operation: 'getQuery',
      method: 'GET',
      path: `/query/${queryId}`,
    });
  }

  async cancelQuery(queryId: string, sessionId: string): Promise<CancelQueryResponse> {
    return this.requestJson<CancelQueryResponse>({
      operation: 'cancelQuery',
      method: 'DELETE',
      path: `/query/${queryId}`,
      query: { session_id: sessionId },
    });
  }

  async validate(request: ValidateRequest): Promise<ValidateResponse> {
    return this.requestJson<ValidateResponse>({
      operation: 'validate',
      method: 'POST',
      path: '/validate',
      body: request,
    });
  }

  private async requestJson<T>(options: RequestOptions): Promise<T> {
    const response = await this.request(options);
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new SerializationError('Failed to parse JSON response', {
        cause,
        operation: options.operation,
        method: options.method,
        path: options.path,
        statusCode: response.status,
        requestId: response.headers.get('x-request-id'),
        correlationId: response.headers.get('x-correlation-id'),
      });
    }
  }

  private async request(options: RequestOptions): Promise<Response> {
    const url = new URL(`${this.baseUrl}${options.path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers({
      Authorization: `Basic ${this.authToken}`,
      'User-Agent': this.userAgent,
      ...options.headers,
    });

    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
      try {
        body = JSON.stringify(options.body);
      } catch (cause) {
        throw new SerializationError('Failed to serialize request body', {
          cause,
          operation: options.operation,
          method: options.method,
          path: options.path,
        });
      }
    } else if (options.rawBody !== undefined) {
      body = options.rawBody as BodyInit;
    }

    const retryPolicy = this.retryPolicy;
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? this.readTimeoutMs;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const init: RequestInit = {
          method: options.method,
          headers,
          body: body ?? null,
          signal: controller.signal,
        };
        const response = await this.fetchImpl(url, init);
        clearTimeout(timeout);

        if (response.ok) {
          return response;
        }

        if (attempt < retryPolicy.maxAttempts && retryPolicy.retryOnStatuses.includes(response.status)) {
          await sleep(Math.min(retryPolicy.baseDelayMs * attempt, retryPolicy.maxDelayMs));
          continue;
        }

        throw await this.toApiError(response, options);
      } catch (error) {
        clearTimeout(timeout);

        if (error instanceof ApiError || error instanceof AuthError || error instanceof BadRequestError) {
          throw error;
        }

        if (isAbortError(error)) {
          throw new TimeoutError('Request timed out', {
            cause: error,
            operation: options.operation,
            method: options.method,
            path: options.path,
            retriable: true,
          });
        }

        if (attempt < retryPolicy.maxAttempts) {
          await sleep(Math.min(retryPolicy.baseDelayMs * attempt, retryPolicy.maxDelayMs));
          continue;
        }

        throw new NetworkError('Network request failed', {
          cause: error,
          operation: options.operation,
          method: options.method,
          path: options.path,
          retriable: true,
        });
      }
    }
  }

  private async toApiError(response: Response, options: RequestOptions): Promise<ApiError | AuthError | BadRequestError> {
    const responseBody = sanitizeBody(await response.text());
    const shared = {
      operation: options.operation,
      method: options.method,
      path: options.path,
      statusCode: response.status,
      requestId: response.headers.get('x-request-id'),
      correlationId: response.headers.get('x-correlation-id'),
      responseBody,
      retriable: this.retryPolicy.retryOnStatuses.includes(response.status),
    };

    if (response.status === 401) {
      return new AuthError('Authentication failed', shared);
    }

    if (response.status === 400) {
      return new BadRequestError(`Bad request: ${responseBody}`, shared);
    }

    return new ApiError(`API request failed with status ${response.status}`, shared);
  }

  private async readNextLine(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    decoder: TextDecoder,
    operation: string,
  ): Promise<string> {
    let buffer = '';
    for (;;) {
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        const remainder = buffer.slice(newlineIndex + 1);
        if (remainder.length > 0) {
          const encoded = new TextEncoder().encode(remainder);
          const rest = reader.read.bind(reader);
          let first = true;
          reader.read = async () => {
            if (first) {
              first = false;
              return { done: false, value: encoded };
            }
            return rest();
          };
        }
        return line;
      }

      const { done, value } = await reader.read();
      if (done) {
        throw new ParseError('Unexpected end of NDJSON stream', 0, buffer, {
          operation,
          method: 'POST',
          path: '/query',
        });
      }
      buffer += decoder.decode(value, { stream: true });
    }
  }

  private parseMetadataLine(line: string): QueryMetadata {
    try {
      return JSON.parse(line) as QueryMetadata;
    } catch (cause) {
      throw new ParseError('Failed to parse query metadata', 0, line, {
        cause,
        operation: 'query',
        method: 'POST',
        path: '/query',
      });
    }
  }

  private parseColumnsLine(line: string): QueryColumn[] {
    try {
      const parsed = JSON.parse(line);
      if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
        throw new TypeError('columns line must be a string array');
      }
      return parsed;
    } catch (cause) {
      throw new ParseError('Failed to parse query columns', 1, line, {
        cause,
        operation: 'query',
        method: 'POST',
        path: '/query',
      });
    }
  }

  private parseRowLine(line: string, lineIndex: number, columns: QueryColumn[]): QueryRow {
    try {
      const parsed = JSON.parse(line);
      if (!Array.isArray(parsed)) {
        throw new TypeError('row line must be an array');
      }
      const row: QueryRow = {};
      for (let i = 0; i < columns.length; i += 1) {
        const column = columns[i];
        if (column !== undefined) {
          row[column] = parsed[i];
        }
      }
      return row;
    } catch (cause) {
      throw new ParseError('Failed to parse query row', lineIndex, line, {
        cause,
        operation: 'query',
        method: 'POST',
        path: '/query',
      });
    }
  }

  debugConfiguration(): Record<string, unknown> {
    return {
      baseUrl: this.baseUrl,
      connectTimeoutMs: this.connectTimeoutMs,
      readTimeoutMs: this.readTimeoutMs,
      retryPolicy: this.retryPolicy,
      userAgent: this.userAgent,
      headers: headersObject(
        new Headers({
          Authorization: 'Basic [REDACTED]',
          'User-Agent': this.userAgent,
        }),
      ),
    };
  }
}

interface RequestOptions {
  operation: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: unknown;
  timeoutMs?: number;
}
