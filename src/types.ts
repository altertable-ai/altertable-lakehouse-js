export type ComputeSize = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type UploadMode = 'create' | 'append' | 'upsert' | 'overwrite';
export type SessionKind =
  | 'ArrowFlightSQL'
  | 'HttpQuery'
  | 'HttpCancel'
  | 'HttpValidate'
  | 'HttpExplain'
  | 'HttpAutocomplete'
  | 'Postgres';

export type AppendPayload = Record<string, unknown>;
export type AppendRequest = { Single: AppendPayload } | { Batch: AppendPayload[] };

export interface AppendResponse {
  ok: boolean;
  error_code?: 'invalid-data' | null;
  error_message?: string | null;
  task_id?: string | null;
}

export interface QueryRequest {
  statement: string;
  cache?: boolean | null;
  catalog?: string | null;
  compute_size?: ComputeSize | null;
  ephemeral?: boolean | null;
  limit?: number | null;
  offset?: number | null;
  query_id?: string | null;
  requested_by?: string | null;
  sanitize?: boolean | null;
  schema?: string | null;
  session_id?: string | null;
  timezone?: string | null;
  visible?: boolean | null;
}

export interface ValidateRequest {
  statement: string;
  catalog?: string | null;
  schema?: string | null;
  session_id?: string | null;
}

export interface ValidateResponse {
  valid: boolean;
  statement: string;
  connections_errors: Record<string, string>;
  error?: string | null;
}

export interface CancelQueryResponse {
  cancelled: boolean;
  message: string;
}

export interface CachingStats {
  data_hits: number;
  data_misses: number;
  data_bytes_hits: number;
  data_bytes_misses: number;
  filehandle_hits: number;
  filehandle_misses: number;
  metadata_hits: number;
  metadata_misses: number;
}

export interface MemoryStats {
  total_usage_bytes: number;
}

export interface ScanStats {
  estimated_result_rows: number;
  estimated_scanned_rows: number;
}

export interface QueryStats {
  caching?: CachingStats | null;
  memory?: MemoryStats | null;
  scan?: ScanStats | null;
}

export interface Progress {
  percentage: number;
  rows_processed: number;
  total_rows: number;
}

export interface QueryLog {
  uuid: string;
  start_time: string;
  end_time?: string | null;
  duration_ms?: number | null;
  query: string;
  session_id: string;
  client_interface: SessionKind;
  error?: string | null;
  stats?: QueryStats | null;
  requested_by?: string | null;
  user_agent?: string | null;
  visible: boolean;
}

export interface QueryLogResponse extends QueryLog {
  percentage?: number;
  rows_processed?: number;
  total_rows?: number;
}

export type QueryColumn = string;
export type QueryRow = Record<string, unknown>;

export interface QueryMetadata {
  statement?: string;
  rows_limit?: number | null;
  rows_offset?: number | null;
  init_time_ms?: number | null;
  connections_errors?: Record<string, string>;
  session_id?: string;
  query_id?: string;
  worker_slug?: string;
  [key: string]: unknown;
}

export interface QueryStreamResult {
  metadata: QueryMetadata;
  columns: QueryColumn[];
  rows: AsyncIterable<QueryRow>;
}

export interface QueryAllResult {
  metadata: QueryMetadata;
  columns: QueryColumn[];
  rows: QueryRow[];
}

export interface RetryPolicy {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOnStatuses?: number[];
}

export interface ClientOptions {
  baseUrl?: string;
  username?: string;
  password?: string;
  basicAuthToken?: string;
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  retryPolicy?: RetryPolicy;
  userAgentSuffix?: string;
  fetch?: typeof globalThis.fetch;
}

export interface UploadOptions {
  catalog: string;
  schema: string;
  table: string;
  mode?: UploadMode;
  primary_key?: string;
  contentType?: string;
}
