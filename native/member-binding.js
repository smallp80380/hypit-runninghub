import { createHash } from 'node:crypto';
import { fail } from '../core/errors.js';
import { accountObservation, serviceBase } from '../core/config.js';
import { createJsonTransport } from '../core/transport.js';
import { digest } from './descriptor.js';
import { readPrivateJson } from './private-files.js';
import { MEMBERSHIP_SOURCE } from './membership-assessment.js';

export const MEMBER_CONTRACT_SHA256 = 'becf0e9cb51ceee2460b77ebeddc394343e7e982f9fdbb029a3e6e4055386097';
export const credentialSha256 = secret => createHash('sha256').update(secret).digest('hex');
const authorities = new WeakSet();
export const isReviewedMemberAuthority = value => value !== null && typeof value === 'object' && authorities.has(value);
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) fail('MEMBER_BINDING_INVALID');
}
function token(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) fail('MEMBER_REVIEW_REQUIRED');
}
function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) fail('MEMBER_BINDING_TIME_INVALID');
  return Date.parse(value);
}

// A trusted local project assertion plus the provider's documented Membership
// contract. This is NOT a server entitlement proof or a NORMAL=>Member enum.
export function validateMemberBinding(binding, config, descriptor, now, { checkTime = true } = {}) {
  exact(binding, ['format', 'credential', 'family', 'baseUrl', 'workflow', 'source', 'humanReview', 'expiresAt']);
  const v2 = descriptor.schemaVersion === 'hypit-runninghub.workflow@2';
  if (binding.format !== (v2 ? 'REVIEWED_MEMBER_BINDING@2' : 'REVIEWED_MEMBER_BINDING@1') || binding.family !== 'native-workflow'
    || config.family !== 'native-workflow' || config.keyType !== 'Consumer-Member') fail('MEMBER_BINDING_FAMILY_MISMATCH');
  if (descriptor.fixtureOnly !== false) fail('MEMBER_BINDING_FIXTURE_FORBIDDEN');
  if (binding.baseUrl !== serviceBase(config.baseUrl, config.family)) fail('MEMBER_BINDING_ORIGIN_MISMATCH');
  exact(binding.credential, ['reference', 'sha256']);
  exact(binding.credential.reference, ['store', 'key']);
  if (digest(binding.credential.reference) !== digest(config.apiKey) || !/^[a-f0-9]{64}$/.test(binding.credential.sha256)) fail('MEMBER_BINDING_CREDENTIAL_MISMATCH');
  exact(binding.workflow, ['workflowId', 'graphDigest', 'descriptorDigest', 'scope', ...(v2 ? ['sourceMode', 'mappingPolicy'] : [])]);
  if (binding.workflow.workflowId !== descriptor.workflowId || binding.workflow.graphDigest !== descriptor.graphDigest.value
    || binding.workflow.descriptorDigest !== digest(descriptor)
    || binding.workflow.scope !== 'reviewed-native-only-no-external-money') fail('MEMBER_BINDING_WORKFLOW_MISMATCH');
  if (v2 && (binding.workflow.sourceMode !== descriptor.sourceMode
    || binding.workflow.mappingPolicy !== 'declared-port-inputs-only')) fail('MEMBER_BINDING_WORKFLOW_MISMATCH');
  exact(binding.source, ['url', 'noteSha256']);
  if (binding.source.url !== MEMBERSHIP_SOURCE || binding.source.noteSha256 !== MEMBER_CONTRACT_SHA256) fail('MEMBER_BINDING_SOURCE_MISMATCH');
  exact(binding.humanReview, ['kind', 'recordId', 'reviewer', 'reviewedAt']);
  if (binding.humanReview.kind !== 'project-owner-reviewed-membership-key-and-native-workflow') fail('MEMBER_REVIEW_REQUIRED');
  token(binding.humanReview.recordId); token(binding.humanReview.reviewer);
  const reviewedAt = timestamp(binding.humanReview.reviewedAt), expiresAt = timestamp(binding.expiresAt);
  if (expiresAt <= reviewedAt) fail('MEMBER_BINDING_TIME_INVALID');
  if (checkTime && (!Number.isFinite(now) || reviewedAt > now || expiresAt <= now)) fail('MEMBER_BINDING_EXPIRED');
  return binding;
}

export async function loadReviewedMemberAuthority({ dataRoot, config, descriptor }) {
  if (config.liveBillingEvidence.kind !== 'private-file') fail('COINS_ONLY_UNVERIFIED');
  const read = async () => readPrivateJson(dataRoot, config.liveBillingEvidence.path, 8192, { ownerOnly: true });
  // Static structure/scope is admitted at activation. Expiry is checked in
  // supports and before new effects, allowing an already-acknowledged resume.
  const snapshot = await read();
  validateMemberBinding(snapshot, config, descriptor, 0, { checkTime: false });
  const authority = Object.freeze({
    checkStatic({ config: currentConfig, descriptor: currentDescriptor, now }) {
      validateMemberBinding(snapshot, currentConfig, currentDescriptor, now);
    },
    async preflight({ config: currentConfig, descriptor: currentDescriptor, secret, fetch, clock }) {
      const binding = await read();
      validateMemberBinding(binding, currentConfig, currentDescriptor, clock.now());
      if (typeof secret !== 'string' || !secret || credentialSha256(secret) !== binding.credential.sha256) fail('MEMBER_BINDING_SECRET_MISMATCH');
      const transport = createJsonTransport({ baseUrl: currentConfig.baseUrl, family: 'native-workflow', fetch, clock,
        timeoutMs: currentConfig.http.requestTimeoutMs, maxResponseBytes: currentConfig.http.maxResponseBytes });
      const receivedAt = clock.now();
      const response = await transport.request({ path: '/uc/openapi/accountStatus', secret, body: { apikey: secret } });
      const actual = accountObservation(response);
      if (actual.actualAccountApiType === 'SHARED') fail('BILLING_MISMATCH');
      if (actual.actualAccountApiType !== 'NORMAL') fail('MEMBER_ACCOUNT_INCONSISTENT');
      // The public accountStatus example specifies string balances.
      const coins = response.data.remainCoins;
      if (typeof coins !== 'string' || coins.length > 32 || !/^\d+(\.\d+)?$/.test(coins)
        || !Number.isFinite(Number(coins)) || Number(coins) <= 0) fail('COINS_BALANCE_UNUSABLE');
      if (clock.now() - receivedAt > 60_000 || clock.now() < receivedAt) fail('ACCOUNT_PREFLIGHT_STALE');
      validateMemberBinding(binding, currentConfig, currentDescriptor, clock.now());
      return { actualAccountApiType: actual.actualAccountApiType, observedAt: clock.now(), expiresAt: Date.parse(binding.expiresAt),
        trust: 'reviewed-project-membership-binding' };
    },
  });
  authorities.add(authority);
  return authority;
}
