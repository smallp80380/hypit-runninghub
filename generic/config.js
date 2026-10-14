import { validateCoreConfig } from '../core/config.js';
import { fail } from '../core/errors.js';
import { exact, jsonValue } from './request.js';

export function validateGenericConfig(config) {
  jsonValue(config);
  if (config.schemaVersion !== 'hypit-runninghub.config@2' || config.family !== 'native-workflow') fail('INVALID_CONFIG_VERSION');
  exact(config.native, ['uploadProtocol', 'submitProtocol', 'queryProtocol'], 'INVALID_NATIVE_CONFIG');
  exact(config.budgets, ['maxRequestBytes', 'maxJournalBytes'], 'INVALID_CONFIG_LIMIT');
  const { budgets, accessPassword, ...rest } = config;
  if (accessPassword !== undefined) {
    exact(accessPassword, ['store', 'key'], 'CREDENTIAL_REFERENCE_REQUIRED');
    if (['store', 'key'].some(key => typeof accessPassword[key] !== 'string' || !accessPassword[key] || accessPassword[key].length > 200)) fail('CREDENTIAL_REFERENCE_REQUIRED');
  }
  // Reuse all account/origin/Coins/retry validation without exposing a legacy
  // descriptor dependency in the generic account contract.
  validateCoreConfig({ ...rest, schemaVersion: 'hypit-runninghub.config@1', native: { ...config.native, workflowDescriptor: 'unused.json' } });
  if (config.liveBillingEvidence.kind !== 'none') fail('PER_OPERATION_REVIEW_REQUIRED');
  if (!Number.isSafeInteger(budgets.maxRequestBytes) || budgets.maxRequestBytes < 1024 || budgets.maxRequestBytes > 4 * 1024 * 1024
    || !Number.isSafeInteger(budgets.maxJournalBytes) || budgets.maxJournalBytes < Math.max(4 * budgets.maxRequestBytes + 65536, 2 * config.http.maxResponseBytes + 65536)
    || budgets.maxJournalBytes > 64 * 1024 * 1024) fail('INVALID_CONFIG_LIMIT');
  return structuredClone(config);
}
