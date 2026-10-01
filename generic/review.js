import { fail } from '../core/errors.js';
import { relativePath, accountObservation } from '../core/config.js';
import { createJsonTransport } from '../core/transport.js';
import { readPrivateJson } from '../native/private-files.js';
import { credentialSha256, MEMBER_CONTRACT_SHA256 } from '../native/member-binding.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { digest } from '../native/descriptor.js';
import { exact, jsonValue, requestDigest, parseJson } from './request.js';

const authorities = new WeakSet();
export const isWorkflowAuthority = value => value !== null && typeof value === 'object' && authorities.has(value);
function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) fail('MEMBER_BINDING_TIME_INVALID');
  return Date.parse(value);
}
export function validateWorkflowReview(review, { config, request, graphDigest, fileDigests, secret, now, checkTime = true }) {
  jsonValue(review); exact(review, ['format', 'credential', 'baseUrl', 'requestDigest', 'graphDigest', 'fileDigests', 'scope', 'source', 'humanReview', 'expiresAt'], 'MEMBER_BINDING_INVALID');
  if (review.format !== 'REVIEWED_WORKFLOW_OPERATION@1' || config.keyType !== 'Consumer-Member'
    || review.scope !== 'reviewed-native-only-no-external-money') fail('MEMBER_BINDING_FAMILY_MISMATCH');
  exact(review.credential, ['reference', 'sha256']);
  if (digest(review.credential.reference) !== digest(config.apiKey) || !/^[a-f0-9]{64}$/.test(review.credential.sha256)) fail('MEMBER_BINDING_CREDENTIAL_MISMATCH');
  if (review.baseUrl !== config.baseUrl.replace(/\/$/, '')) fail('MEMBER_BINDING_ORIGIN_MISMATCH');
  if (review.requestDigest !== requestDigest(request) || !/^[a-f0-9]{64}$/.test(review.graphDigest)
    || graphDigest !== undefined && review.graphDigest !== graphDigest
    || fileDigests !== undefined && digest(review.fileDigests) !== digest(fileDigests)) fail('MEMBER_BINDING_WORKFLOW_MISMATCH');
  if (!Array.isArray(review.fileDigests) || review.fileDigests.length !== request.files.length) fail('MEMBER_BINDING_WORKFLOW_MISMATCH');
  for (const [index, file] of review.fileDigests.entries()) {
    exact(file, ['key', 'sha256']);
    if (file.key !== request.files[index].key || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('MEMBER_BINDING_WORKFLOW_MISMATCH');
  }
  exact(review.source, ['url', 'noteSha256']);
  if (review.source.url !== MEMBERSHIP_SOURCE || review.source.noteSha256 !== MEMBER_CONTRACT_SHA256) fail('MEMBER_BINDING_SOURCE_MISMATCH');
  exact(review.humanReview, ['kind', 'recordId', 'reviewer', 'reviewedAt']);
  if (review.humanReview.kind !== 'project-owner-reviewed-membership-key-and-native-workflow'
    || ![review.humanReview.recordId, review.humanReview.reviewer].every(v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(v))) fail('MEMBER_REVIEW_REQUIRED');
  const reviewedAt = date(review.humanReview.reviewedAt), expiresAt = date(review.expiresAt);
  if (expiresAt <= reviewedAt) fail('MEMBER_BINDING_TIME_INVALID');
  if (checkTime && (!Number.isFinite(now) || reviewedAt > now || expiresAt <= now)) fail('MEMBER_BINDING_EXPIRED');
  if (secret !== undefined && credentialSha256(secret) !== review.credential.sha256) fail('MEMBER_BINDING_SECRET_MISMATCH');
  return review;
}
export function createWorkflowAuthority({ dataRoot }) {
  async function read(request) {
    if (!request.review) fail('COINS_ONLY_UNVERIFIED');
    return readPrivateJson(dataRoot, relativePath(request.review), 4 * 1024 * 1024, { ownerOnly: true, parse: parseJson });
  }
  const authority = Object.freeze({
    async check(args) { return validateWorkflowReview(await read(args.request), args); },
    async preflight(args) {
      const review = await this.check({ ...args, now: args.clock.now() });
      const transport = createJsonTransport({ baseUrl: args.config.baseUrl, family: 'native-workflow', fetch: args.fetch, clock: args.clock,
        timeoutMs: args.config.http.requestTimeoutMs, maxResponseBytes: args.config.http.maxResponseBytes });
      const before = args.clock.now();
      const response = await transport.request({ path: '/uc/openapi/accountStatus', secret: args.secret, body: { apikey: args.secret } });
      const observation = accountObservation(response);
      if (observation.actualAccountApiType === 'SHARED') fail('BILLING_MISMATCH');
      if (observation.actualAccountApiType !== 'NORMAL') fail('MEMBER_ACCOUNT_INCONSISTENT');
      const coins = response.data.remainCoins;
      if (typeof coins !== 'string' || coins.length > 32 || !/^\d+(\.\d+)?$/.test(coins) || !Number.isFinite(Number(coins)) || Number(coins) <= 0) fail('COINS_BALANCE_UNUSABLE');
      if (args.clock.now() < before || args.clock.now() - before > 60000) fail('ACCOUNT_PREFLIGHT_STALE');
      await this.check({ ...args, now: args.clock.now() });
      return { observedAt: args.clock.now(), expiresAt: Date.parse(review.expiresAt) };
    },
  });
  authorities.add(authority); return authority;
}
