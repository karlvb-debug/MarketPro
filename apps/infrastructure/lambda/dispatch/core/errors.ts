// Error triage for dispatch Lambdas.
//
// Retryable errors (infrastructure/systemic) must bubble up so SQS redelivers
// the record and, after maxReceiveCount, parks it in the DLQ. Per-recipient
// errors (bad address, provider 4xx validation) must NOT fail the record —
// they are recorded on the campaign_messages row and the campaign continues.

/** Thrown by dispatch internals to force an SQS retry of the whole record. */
export class RetryableDispatchError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RetryableDispatchError';
    this.cause = cause;
  }
}

const RETRYABLE_ERROR_NAMES = new Set([
  // AWS SDK throttling / availability
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'ServiceUnavailable',
  'InternalServerError',
  'InternalServiceErrorException',
  'InternalFailure',
  'RequestTimeout',
  'TimeoutError',
  'LimitExceededException',
  'ProvisionedThroughputExceededException',
  // Generic network
  'NetworkingError',
  'AbortError',
]);

const RETRYABLE_CODE_PATTERNS = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
];

// node-postgres error codes that indicate the database (not the data) is the
// problem: connection failures, admin shutdown, too many connections, etc.
const RETRYABLE_PG_CODE_PREFIXES = ['08', '53', '57'];

interface ErrorLike {
  name?: string;
  code?: string | number;
  message?: string;
  $metadata?: { httpStatusCode?: number };
  $retryable?: { throttling?: boolean };
}

/**
 * True if the error is systemic (DB down, network, provider throttling/5xx)
 * and the whole SQS record should be retried. False means the error is
 * data-specific and must be handled per recipient.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof RetryableDispatchError) return true;
  if (!err || typeof err !== 'object') return false;
  const e = err as ErrorLike;

  if (e.$retryable?.throttling) return true;
  if (e.name && RETRYABLE_ERROR_NAMES.has(e.name)) return true;

  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined && (status >= 500 || status === 429)) return true;

  const code = String(e.code ?? '');
  if (RETRYABLE_CODE_PATTERNS.some((p) => code.includes(p))) return true;
  if (RETRYABLE_PG_CODE_PREFIXES.some((p) => code.startsWith(p)) && code.length === 5) return true;

  const message = e.message ?? '';
  if (/connection terminated|connection timeout|timeout expired/i.test(message)) return true;

  return false;
}

/** Compact error code string for the campaign_messages.error_code column. */
export function errorCodeOf(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err).substring(0, 100);
  const e = err as ErrorLike;
  return String(e.name || e.code || e.message || 'UnknownError').substring(0, 100);
}
