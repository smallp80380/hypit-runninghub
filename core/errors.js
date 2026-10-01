export class ProviderError extends Error {
  constructor(code, { retryable = false, category = 'local', taskIds = [], upstreamCode, httpStatus } = {}) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.category = category;
    this.taskIds = taskIds;
    this.upstreamCode = upstreamCode;
    this.httpStatus = httpStatus;
  }
}

export function fail(code, options) { throw new ProviderError(code, options); }

export function safeError(error) {
  // Neither upstream messages nor arbitrary properties enter the public journal.
  if (error instanceof ProviderError) return {
    code: /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'PROVIDER_ERROR',
    category: ['local', 'transient', 'business', 'unknown', 'billing'].includes(error.category) ? error.category : 'unknown',
    retryable: error.retryable === true,
    ...(typeof error.upstreamCode === 'string' && /^[0-9]{1,10}$/.test(error.upstreamCode) ? { upstreamCode: error.upstreamCode } : {}),
    ...(Number.isInteger(error.httpStatus) && error.httpStatus >= 100 && error.httpStatus <= 599 ? { httpStatus: error.httpStatus } : {}),
  };
  return { code: 'UNCLASSIFIED_ERROR', category: 'unknown', retryable: false };
}
