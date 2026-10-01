import { fail, safeError, ProviderError } from '../core/errors.js';
import { serviceBase } from '../core/config.js';
import { createJsonTransport, boundedBySignal } from '../core/transport.js';
import { parseDocument, importWorkflow, safeJSON } from './revision.js';

export const workflowClock = Object.freeze({
  now: () => Date.now(),
  timeout(ms) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, cancel: () => clearTimeout(timer) };
  },
});
export function validateFetchConfig(config) {
  safeJSON(config);
  const keys = ['format', 'baseUrl', 'workflowId', 'apiKey', 'requestTimeoutMs', 'maxResponseBytes'];
  if (!config || Array.isArray(config) || Object.keys(config).length !== keys.length || Object.keys(config).some(k => !keys.includes(k))
    || config.format !== 'hypit-runninghub.fetch@1' || !/^[0-9]{1,40}$/.test(config.workflowId)
    || !Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 || config.requestTimeoutMs > 300000
    || !Number.isInteger(config.maxResponseBytes) || config.maxResponseBytes < 1024 || config.maxResponseBytes > 16777216) fail('INVALID_FETCH_CONFIG');
  serviceBase(config.baseUrl, 'native-workflow');
  const ref = config.apiKey;
  if (!ref || Array.isArray(ref) || Object.keys(ref).length !== 2 || Object.keys(ref).some(k => !['store', 'key'].includes(k))
    || ['store', 'key'].some(k => typeof ref[k] !== 'string' || !ref[k] || ref[k].length > 200)) fail('INVALID_CREDENTIAL_REFERENCE');
  return structuredClone(config);
}

// Resolver belongs to the consumer. No credential stores or environment are
// inspected by this SDK API. This calls only the documented read operation.
export async function fetchWorkflow(config, { resolveCredential, fetch, clock = workflowClock } = {}) {
  const checked = validateFetchConfig(config);
  if (typeof resolveCredential !== 'function' || typeof fetch !== 'function') fail('INJECTED_FETCH_RESOLVER_REQUIRED');
  let secret;
  const timer = clock.timeout(checked.requestTimeoutMs);
  try {
    const resolved = await boundedBySignal(timer.signal, () => resolveCredential(checked.apiKey));
    secret = typeof resolved === 'string' ? resolved : resolved?.secret;
    if (typeof secret !== 'string' || !secret) fail('CREDENTIAL_MISSING');
  } catch (error) {
    if (error instanceof ProviderError) throw new ProviderError(safeError(error).code, safeError(error));
    fail('CREDENTIAL_RESOLUTION_FAILED');
  } finally { timer.cancel(); }
  try {
    const transport = createJsonTransport({ baseUrl: checked.baseUrl, family: 'native-workflow', fetch, clock,
      timeoutMs: checked.requestTimeoutMs, maxResponseBytes: checked.maxResponseBytes });
    const response = await transport.request({ path: '/api/openapi/getJsonApiFormat', secret,
      body: { apiKey: secret, workflowId: checked.workflowId } });
    if (response.code !== 0 || typeof response.data?.prompt !== 'string') fail('WORKFLOW_RESPONSE_UNKNOWN');
    const graph = parseDocument(response.data.prompt);
    return importWorkflow(graph, { kind: 'fetched-workflow', workflowId: checked.workflowId, baseUrl: checked.baseUrl });
  } catch (error) {
    // Never propagate resolver/fetch error text or remote response bodies.
    if (error instanceof ProviderError) throw new ProviderError(safeError(error).code, safeError(error));
    fail(safeError(error).code);
  }
}
