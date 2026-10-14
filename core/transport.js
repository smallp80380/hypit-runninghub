import { ProviderError, fail } from './errors.js';
import { serviceBase } from './config.js';
import { validTaskId } from './submission-machine.js';

// Source: pinned official native/errors.txt; not a fabricated complete enum.
const transientBusinessCodes = new Set(['415', '1003', '1005', '1010', '1011', '1012', '1504']);
const deterministicBusinessCodes = new Set(['301', '380', '412', '416', '421', '423', '433', '435', '436',
  '801', '802', '803', '804', '805', '806', '807', '809', '810', '811', '812', '813', '901',
  '1001', '1002', '1004', '1007', '1008', '1009', '1014', '1101', '1501', '1505']);

export function classifyResponse(status, body) {
  const rawCode = body && (body.errorCode || body.error_code || (body.code !== undefined && body.code !== 0 ? body.code : undefined));
  const hasError = rawCode !== undefined || Boolean(body?.errorMessage || body?.error_message);
  if (hasError) {
    const code = String(rawCode ?? '');
    if (deterministicBusinessCodes.has(code)) return new ProviderError('UPSTREAM_BUSINESS_ERROR', { category: 'business', upstreamCode: code, httpStatus: status });
    if ([400, 401, 403, 404, 422].includes(status)) return new ProviderError(`HTTP_${status}`, { category: 'business', httpStatus: status });
    if (transientBusinessCodes.has(code)) return new ProviderError('UPSTREAM_TRANSIENT_ERROR', { category: 'transient', retryable: true, upstreamCode: code, httpStatus: status });
    return new ProviderError('UPSTREAM_BUSINESS_UNKNOWN', { category: 'unknown', upstreamCode: /^[0-9]{1,10}$/.test(code) ? code : undefined, httpStatus: status });
  }
  if ([400, 401, 403, 404, 422].includes(status)) return new ProviderError(`HTTP_${status}`, { category: 'business' });
  if (status === 429 || status >= 500) return new ProviderError(`HTTP_${status}`, { category: 'transient', retryable: true });
  if (status < 200 || status >= 300) return new ProviderError('HTTP_UNSUPPORTED_STATUS', { category: 'unknown' });
}

function networkError(error) {
  if (error instanceof ProviderError) return error;
  if (error instanceof TypeError || ['AbortError', 'TimeoutError'].includes(error?.name)
    || ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(error?.code ?? error?.cause?.code)) {
    return new ProviderError('NETWORK_TRANSIENT', { category: 'transient', retryable: true });
  }
  return new ProviderError('TRANSPORT_UNKNOWN');
}

export async function boundedBySignal(signal, work) {
  if (signal.aborted) throw new ProviderError('NETWORK_TRANSIENT', { category: 'transient', retryable: true });
  let listener;
  const interrupted = new Promise((_, reject) => {
    listener = () => reject(new ProviderError('NETWORK_TRANSIENT', { category: 'transient', retryable: true }));
    signal.addEventListener('abort', listener, { once: true });
  });
  try { return await Promise.race([work(), interrupted]); }
  finally { signal.removeEventListener('abort', listener); }
}

export async function boundedBytes(response, maxBytes) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) fail('RESPONSE_TOO_LARGE');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        // Cancellation is cleanup: it must never delay or replace this known
        // deterministic limit, even for a rejecting or uncooperative stream.
        try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
        fail('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(c => Buffer.from(c)), size);
}

export function createJsonTransport({ baseUrl, family, fetch: fetcher, clock, timeoutMs, maxResponseBytes }) {
  const base = serviceBase(baseUrl, family);
  if (typeof fetcher !== 'function' || !clock || typeof clock.timeout !== 'function') fail('INJECTED_TRANSPORT_REQUIRED');
  return {
    async request({ path, secret, body, form, method = 'POST', query, extractTaskIds = () => [], observeResponse }) {
      if (typeof path !== 'string' || !/^\/[A-Za-z0-9_/-]+$/.test(path) || path.includes('..')) fail('INVALID_API_PATH');
      if (typeof secret !== 'string' || !secret) fail('CREDENTIAL_MISSING');
      if (method !== 'POST' && !(method === 'GET' && family === 'native-workflow' && path === '/api/webapp/apiCallDemo')) fail('INVALID_API_PATH');
      if (method === 'GET') {
        if (body !== undefined || form !== undefined || !query || Object.getPrototypeOf(query) !== Object.prototype
          || Object.keys(query).length !== 2 || Object.keys(query).some(k => !['apiKey', 'webappId'].includes(k))
          || query.apiKey !== secret || typeof query.webappId !== 'string' || !/^[0-9]{1,40}$/.test(query.webappId)) fail('INVALID_MULTIPART_BODY');
      } else if (query !== undefined) fail('INVALID_MULTIPART_BODY');
      if (form !== undefined && (!(form instanceof FormData) || body !== undefined)) fail('INVALID_MULTIPART_BODY');
      const timer = clock.timeout(timeoutMs);
      try {
        let response;
        try {
          const url = base + path + (method === 'GET' ? `?${new URLSearchParams(query)}` : '');
          response = await boundedBySignal(timer.signal, () => fetcher(url, { method, redirect: 'error', signal: timer.signal,
            headers: { authorization: `Bearer ${secret}`, ...(method === 'POST' && form === undefined ? { 'content-type': 'application/json' } : {}) },
            ...(method === 'POST' ? { body: form ?? JSON.stringify(body) } : {}) }));
        } catch (error) {
          throw networkError(error);
        }
        let text;
        try { text = (await boundedBySignal(timer.signal, () => boundedBytes(response, maxResponseBytes))).toString('utf8'); }
        catch (error) {
          // Local size limits remain deterministic, including on HTTP429/5xx.
          if (error instanceof ProviderError && !error.retryable) throw error;
          const statusError = classifyResponse(response.status, undefined);
          if (statusError && !statusError.retryable) throw statusError;
          throw networkError(error);
        }
        let data;
        try { data = JSON.parse(text); } catch {
          const statusError = classifyResponse(response.status, undefined);
          if (statusError && !statusError.retryable) throw statusError;
          throw new ProviderError('TRANSIENT_INVALID_JSON', { category: 'transient', retryable: true });
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail('UPSTREAM_SCHEMA_UNKNOWN');
        if (observeResponse) await observeResponse(data);
        const taskIds = extractTaskIds(data).filter(validTaskId);
        const error = classifyResponse(response.status, data);
        if (error) { error.taskIds = taskIds; throw error; }
        return data;
      } finally { timer.cancel(); }
    },
  };
}
