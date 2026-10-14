import { fail } from '../core/errors.js';
import { relativePath } from '../core/config.js';
import { readPrivateJson } from '../native/private-files.js';
import { exact, parseJson } from '../generic/request-json.js';
import { validateReviewEnvelope } from '../generic/review-common.js';
import { preflightMembership } from '../generic/admission.js';
import { aiAppRequestDigest } from './request.js';

const spec = Object.freeze({
  format: 'REVIEWED_AI_APP_OPERATION@1',
  scope: 'reviewed-ai-app-only-no-external-money',
  reviewKind: 'project-owner-reviewed-membership-key-and-ai-app',
  digestRequest: aiAppRequestDigest,
  mismatchCode: 'MEMBER_BINDING_APP_MISMATCH',
});
const authorities = new WeakSet();
export const isAiAppAuthority = value => value !== null && typeof value === 'object' && authorities.has(value);
export function validateAiAppReview(review, args) {
  validateReviewEnvelope(review, args, spec);
  exact(review, ['format', 'credential', 'accessPasswordCredential', 'baseUrl', 'requestDigest', 'appDigest', 'fileDigests', 'scope', 'source', 'humanReview', 'expiresAt'], 'MEMBER_BINDING_INVALID');
  if (typeof review.appDigest !== 'string' || !/^[a-f0-9]{64}$/.test(review.appDigest)
    || args.appDigest !== undefined && review.appDigest !== args.appDigest) fail(spec.mismatchCode);
  return review;
}
export function createAiAppAuthority({ dataRoot }) {
  async function read(request) {
    if (!request.review) fail('COINS_ONLY_UNVERIFIED');
    return readPrivateJson(dataRoot, relativePath(request.review), 4 * 1024 * 1024, { ownerOnly: true, parse: parseJson });
  }
  const check = async args => validateAiAppReview(await read(args.request), args);
  const authority = Object.freeze({
    check,
    preflight(args) {
      return preflightMembership({ ...args, check: time => check({ ...args, ...time }) });
    },
  });
  authorities.add(authority); return authority;
}
