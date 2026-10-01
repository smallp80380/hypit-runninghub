import { fail } from './errors.js';

export const OFFICIAL_ORIGINS = Object.freeze(['https://www.runninghub.ai', 'https://www.runninghub.cn']);
export function serviceBase(value, family) {
  let url;
  try { url = new URL(value); } catch { fail('INVALID_SERVICE_BASE'); }
  const path = family === 'standard-model' ? '/openapi/v2' : '';
  if (!OFFICIAL_ORIGINS.includes(url.origin) || url.username || url.password || url.search || url.hash
    || url.pathname.replace(/\/$/, '') !== path) fail('UNTRUSTED_SERVICE_BASE');
  return url.origin + path;
}

export function relativePath(value) {
  if (typeof value !== 'string' || value.length > 300 || !/^[A-Za-z0-9_./-]+$/.test(value)
    || value.startsWith('/') || value.split('/').some(p => !p || p === '.' || p === '..')) fail('UNSAFE_PRIVATE_PATH');
  return value;
}

function exact(object, keys, code) {
  if (!object || typeof object !== 'object' || Array.isArray(object)
    || Object.keys(object).some(k => !keys.includes(k))) fail(code);
}
function positive(value, maximum = 86_400_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('INVALID_CONFIG_LIMIT');
}

export function validateCoreConfig(config) {
  exact(config, ['schemaVersion', 'family', 'baseUrl', 'apiKey', 'keyType', 'accountPreflight',
    'billingExpectation', 'liveBillingEvidence', 'submissionEnabled', 'retry', 'polling', 'http', 'paths', 'native', 'standard'], 'UNKNOWN_CONFIG_FIELD');
  if (config.schemaVersion !== 'hypit-runninghub.config@1'
    || !['native-workflow', 'standard-model'].includes(config.family)) fail('INVALID_CONFIG_VERSION');
  serviceBase(config.baseUrl, config.family);
  exact(config.apiKey, ['store', 'key'], 'CREDENTIAL_REFERENCE_REQUIRED');
  for (const v of [config.apiKey.store, config.apiKey.key]) {
    if (typeof v !== 'string' || !v || v.length > 200) fail('CREDENTIAL_REFERENCE_REQUIRED');
  }
  if (!['Consumer-Member', 'Enterprise-Shared', 'Enterprise-Dedicated', 'unknown'].includes(config.keyType)) fail('UNKNOWN_DECLARED_KEY_TYPE');
  if (config.family === 'standard-model' && config.keyType !== 'Enterprise-Shared') fail('DECLARED_KEY_TYPE_MISMATCH');
  exact(config.accountPreflight, ['mode'], 'INVALID_ACCOUNT_PREFLIGHT');
  if (config.accountPreflight.mode !== 'read-only-required') fail('INVALID_ACCOUNT_PREFLIGHT');
  exact(config.billingExpectation, ['policy', 'ledger', 'gate'], 'COINS_ONLY_REQUIRED');
  if (config.billingExpectation.policy !== 'COINS_ONLY' || config.billingExpectation.ledger !== 'coins'
    || config.billingExpectation.gate !== 'require-provider-guarantee') fail('COINS_ONLY_REQUIRED');
  exact(config.liveBillingEvidence, ['kind', 'path'], 'INVALID_BILLING_REFERENCE');
  if (config.liveBillingEvidence.kind === 'private-file') relativePath(config.liveBillingEvidence.path);
  else if (config.liveBillingEvidence.kind !== 'none' || config.liveBillingEvidence.path !== undefined) fail('INVALID_BILLING_REFERENCE');
  if (typeof config.submissionEnabled !== 'boolean') fail('INVALID_SUBMISSION_FLAG');
  exact(config.retry, ['submit', 'upload'], 'INVALID_RETRY_CONFIG');
  for (const action of ['submit', 'upload']) {
    const policy = config.retry[action]; exact(policy, ['maxAttempts', 'initialDelayMs', 'maxDelayMs'], 'INVALID_RETRY_CONFIG');
    if (policy.maxAttempts !== 3) fail('INVALID_RETRY_BUDGET');
    positive(policy.initialDelayMs, 60_000); positive(policy.maxDelayMs, 300_000);
    if (policy.initialDelayMs > policy.maxDelayMs) fail('INVALID_RETRY_CONFIG');
  }
  exact(config.polling, ['intervalMs', 'maxElapsedMs', 'maxConsecutiveTransientFailures'], 'INVALID_POLL_CONFIG');
  positive(config.polling.intervalMs, 600_000); positive(config.polling.maxElapsedMs);
  positive(config.polling.maxConsecutiveTransientFailures, 20);
  exact(config.http, ['requestTimeoutMs', 'maxResponseBytes', 'maxDownloadBytes', 'allowedDownloadHosts'], 'INVALID_HTTP_CONFIG');
  positive(config.http.requestTimeoutMs, 600_000); positive(config.http.maxResponseBytes, 10_485_760);
  positive(config.http.maxDownloadBytes, 4_294_967_296);
  if (!Array.isArray(config.http.allowedDownloadHosts) || !config.http.allowedDownloadHosts.length
    || config.http.allowedDownloadHosts.some(h => typeof h !== 'string' || !/^[a-z0-9.-]+$/.test(h))) fail('INVALID_DOWNLOAD_HOSTS');
  exact(config.paths, ['journalDirectory'], 'INVALID_PATH_CONFIG'); relativePath(config.paths.journalDirectory);
  if (config.family === 'native-workflow') {
    if (config.standard !== undefined) fail('MIXED_API_CONFIG');
    exact(config.native, ['workflowDescriptor', 'uploadProtocol', 'submitProtocol', 'queryProtocol'], 'INVALID_NATIVE_CONFIG');
    relativePath(config.native.workflowDescriptor);
    if (config.native.uploadProtocol !== 'legacy-filename' || config.native.submitProtocol !== 'legacy-create'
      || config.native.queryProtocol !== 'v2-query') fail('UNSUPPORTED_NATIVE_PROTOCOL');
  } else {
    if (config.native !== undefined) fail('MIXED_API_CONFIG');
    exact(config.standard, ['registrySha256', 'modelDescriptors'], 'INVALID_REGISTRY_CONFIG');
    if (!/^[a-f0-9]{64}$/.test(config.standard.registrySha256) || !Array.isArray(config.standard.modelDescriptors)
      || !config.standard.modelDescriptors.length) fail('INVALID_REGISTRY_CONFIG');
    config.standard.modelDescriptors.forEach(relativePath);
  }
  return structuredClone(config);
}

export function accountObservation(value) {
  if (!value || value.code !== 0 || !value.data || typeof value.data.apiType !== 'string') fail('ACCOUNT_TYPE_UNKNOWN');
  const actualAccountApiType = value.data.apiType;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(actualAccountApiType)) fail('ACCOUNT_TYPE_UNKNOWN');
  // NORMAL is the documented example, not a documented Member mapping.
  // SHARED is a separately observed denial, not a claim about a complete enum.
  return { actualAccountApiType, interpretation: actualAccountApiType === 'SHARED' ? 'known-denial' : 'unverified' };
}

export function assertCoinsExecution(config, observation) {
  if (!config.submissionEnabled) fail('SUBMISSION_DISABLED', { category: 'billing' });
  if (observation?.actualAccountApiType === 'SHARED') fail('BILLING_MISMATCH', { category: 'billing' });
  // Membership page promises Coins, but accountStatus exposes no documented
  // Membership key-class verifier. Private files, balances,
  // key declarations and post-task usage never grant execution authority.
  fail('COINS_ONLY_UNVERIFIED', { category: 'billing' });
}
