import { fail, safeError, ProviderError } from '../core/errors.js';
import { serviceBase } from '../core/config.js';
import { createJsonTransport, boundedBySignal } from '../core/transport.js';
import { digest } from '../native/descriptor.js';
import { jsonValue, exact, DEFAULT_JSON_BYTES } from '../generic/request.js';
import { parseRunningHubTarget } from '../generic/service-target.js';
import { workflowClock } from '../workflow/fetch.js';
import { validateAiAppRequest, validateAiAppTargets } from './request.js';
import { appDocumentContainsSecret } from '../generic/operation-sanitization.js';

const documentFields = ['format', 'baseUrl', 'webappId', 'webappName', 'accessEncrypted', 'nodeInfoList', 'appDigest'];
const nodeFields = ['nodeId', 'nodeName', 'fieldName', 'fieldValue', 'fieldData', 'fieldType', 'description', 'descriptionEn'];
const unsafeNames = new Set(['__proto__', 'constructor', 'prototype']);
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function interfaceDigest({ baseUrl, webappId, accessEncrypted, nodeInfoList }) {
  return digest({ baseUrl, webappId, accessEncrypted, nodeInfoList });
}

// Captured credentials may be supplied on repeat reads by an execution owner.
// No credential store or environment is consulted by this pure helper.
export function validateAiAppDocument(document, { secrets = [] } = {}) {
  jsonValue(document, DEFAULT_JSON_BYTES);
  exact(document, documentFields, 'INVALID_AI_APP_DOCUMENT');
  if (Object.keys(document).length !== documentFields.length || document.format !== 'hypit-runninghub.ai-app-document@1'
    || typeof document.webappId !== 'string' || !/^[0-9]{1,40}$/.test(document.webappId)
    || typeof document.webappName !== 'string' || typeof document.accessEncrypted !== 'boolean'
    || !Array.isArray(document.nodeInfoList)) fail('INVALID_AI_APP_DOCUMENT');
  const baseUrl = serviceBase(document.baseUrl, 'native-workflow');
  const targets = new Set();
  for (const node of document.nodeInfoList) {
    exact(node, nodeFields, 'INVALID_AI_APP_DOCUMENT');
    if (Object.keys(node).length !== nodeFields.length || nodeFields.some(field => typeof node[field] !== 'string')
      || ['nodeId', 'fieldName'].some(field => !node[field].trim() || /[\u0000-\u001f]/.test(node[field]))) fail('INVALID_AI_APP_DOCUMENT');
    if (unsafeNames.has(node.nodeId) || unsafeNames.has(node.fieldName)) fail('UNSAFE_JSON_KEY');
    const target = JSON.stringify([node.nodeId, node.fieldName]);
    if (targets.has(target)) fail('CONFLICTING_NODE_TARGET');
    targets.add(target);
  }
  if (appDocumentContainsSecret(document, secrets)) fail('AI_APP_RESPONSE_UNKNOWN');
  const canonical = { ...document, baseUrl };
  if (document.appDigest !== interfaceDigest(canonical)) fail('REVISION_DIGEST_MISMATCH');
  return freeze(structuredClone(canonical));
}

export function validateAiAppFetchConfig(config) {
  jsonValue(config);
  const fields = ['format', 'baseUrl', 'webappId', 'apiKey', 'requestTimeoutMs', 'maxResponseBytes'];
  exact(config, fields, 'INVALID_FETCH_CONFIG');
  if (Object.keys(config).length !== fields.length || config.format !== 'hypit-runninghub.ai-app-fetch@1'
    || !Number.isInteger(config.requestTimeoutMs) || config.requestTimeoutMs < 1 || config.requestTimeoutMs > 600000
    || !Number.isInteger(config.maxResponseBytes) || config.maxResponseBytes < 1 || config.maxResponseBytes > 16777216) fail('INVALID_FETCH_CONFIG');
  const baseUrl = serviceBase(config.baseUrl, 'native-workflow');
  const ref = config.apiKey;
  exact(ref, ['store', 'key'], 'INVALID_CREDENTIAL_REFERENCE');
  if (Object.keys(ref).length !== 2 || ['store', 'key'].some(field => typeof ref[field] !== 'string' || !ref[field] || ref[field].length > 200)) fail('INVALID_CREDENTIAL_REFERENCE');
  return { ...structuredClone(config), baseUrl, webappId: parseRunningHubTarget(config.webappId, 'ai-app').id };
}

// Only the documented metadata read is performed; this grants no submission
// permission. Raw curl, statistics, covers, tags and other metadata are discarded.
export async function fetchAiApp(config, { resolveCredential, fetch, clock = workflowClock } = {}) {
  const checked = validateAiAppFetchConfig(config);
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
    const response = await transport.request({ path: '/api/webapp/apiCallDemo', method: 'GET', secret,
      query: { apiKey: secret, webappId: checked.webappId } });
    const data = response.data;
    if (response.code !== 0 || !data || typeof data !== 'object' || Array.isArray(data)
      || typeof data.webappName !== 'string' || typeof data.accessEncrypted !== 'boolean' || !Array.isArray(data.nodeInfoList)) fail('AI_APP_RESPONSE_UNKNOWN');
    const nodeInfoList = data.nodeInfoList.map(node => {
      if (!node || typeof node !== 'object' || Array.isArray(node) || nodeFields.some(field => typeof node[field] !== 'string')) fail('AI_APP_RESPONSE_UNKNOWN');
      return Object.fromEntries(nodeFields.map(field => [field, node[field]]));
    });
    const content = { format: 'hypit-runninghub.ai-app-document@1', baseUrl: checked.baseUrl,
      webappId: checked.webappId, webappName: data.webappName, accessEncrypted: data.accessEncrypted, nodeInfoList };
    const document = { ...content, appDigest: interfaceDigest(content) };
    try { return validateAiAppDocument(document, { secrets: [secret] }); }
    catch { fail('AI_APP_RESPONSE_UNKNOWN'); }
  } catch (error) {
    // Never expose fetch/resolver error text, query URLs or upstream bodies.
    if (error instanceof ProviderError) throw new ProviderError(safeError(error).code, safeError(error));
    fail(safeError(error).code);
  }
}

export function requestFromAiAppDocument(document, { nodeInfoList = [], files = [], bindings = [], review, instanceType, draft = false } = {}) {
  const source = validateAiAppDocument(document);
  const request = validateAiAppRequest({ format: 'hypit-runninghub.ai-app-request@1', webappId: source.webappId,
    nodeInfoList, files, bindings, ...(review === undefined ? {} : { review }), ...(instanceType === undefined ? {} : { instanceType }) }, { draft });
  validateAiAppTargets(source, request);
  const targetKey = node => JSON.stringify([node.nodeId, node.fieldName]);
  const overrides = new Map(request.nodeInfoList.map(node => [targetKey(node), node]));
  const bound = new Set(request.bindings.map(targetKey));
  request.nodeInfoList = source.nodeInfoList.flatMap(node => {
    const key = targetKey(node);
    if (bound.has(key)) return [];
    return [overrides.get(key) ?? { nodeId: node.nodeId, fieldName: node.fieldName, fieldValue: node.fieldValue }];
  });
  return validateAiAppRequest(request, { draft });
}
