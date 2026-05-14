export interface AltertableErrorOptions {
  cause?: unknown;
  operation?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  retriable?: boolean;
  requestId?: string | null;
  correlationId?: string | null;
}

export class AltertableLakehouseError extends Error {
  readonly operation: string | undefined;
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly statusCode: number | undefined;
  readonly retriable: boolean;
  readonly requestId: string | null;
  readonly correlationId: string | null;

  constructor(message: string, options: AltertableErrorOptions = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.operation = options.operation;
    this.method = options.method;
    this.path = options.path;
    this.statusCode = options.statusCode;
    this.retriable = options.retriable ?? false;
    this.requestId = options.requestId ?? null;
    this.correlationId = options.correlationId ?? null;
  }
}

export class ConfigurationError extends AltertableLakehouseError {}
export class AuthError extends AltertableLakehouseError {}
export class BadRequestError extends AltertableLakehouseError {}
export class NetworkError extends AltertableLakehouseError {}
export class TimeoutError extends AltertableLakehouseError {}
export class SerializationError extends AltertableLakehouseError {}

export class ParseError extends AltertableLakehouseError {
  readonly lineIndex: number;
  readonly rawLine: string;

  constructor(message: string, lineIndex: number, rawLine: string, options: AltertableErrorOptions = {}) {
    super(`${message} at line ${lineIndex}: ${rawLine}`, options);
    this.lineIndex = lineIndex;
    this.rawLine = rawLine;
  }
}

export class ApiError extends AltertableLakehouseError {
  readonly responseBody: string | undefined;

  constructor(message: string, options: AltertableErrorOptions & { responseBody?: string } = {}) {
    super(message, options);
    this.responseBody = options.responseBody;
  }
}
