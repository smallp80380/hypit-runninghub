import { fail } from '../core/errors.js';
import { relativePath } from '../core/config.js';
import { readPrivateJson } from '../native/private-files.js';
import { exact, requestDigest, parseJson } from './request.js';
import { validateReviewEnvelope } from './review-common.js';
import { preflightMembership } from './admission.js';

const spec = Object.freeze({
  format: 'REVIEWED_WORKFLOW_OPERATION@1',
  scope: 'reviewed-native-only-no-external-money',
  reviewKind: 'project-owner-reviewed-membership-key-and-native-workflow',
  digestRequest: requestDigest,
  mismatchCode: 'MEMBER_BINDING_WORKFLOW_MISMATCH',
});
const authorities = new WeakSet();
export const isWorkflowAuthority = value => value !== null && typeof value === 'object' && authorities.has(value);
export function validateWorkflowReview(review, args) {
  validateReviewEnvelope(review, args, spec);
  exact(review, ['format', 'credential', 'accessPasswordCredential', 'baseUrl', 'requestDigest', 'graphDigest', 'fileDigests', 'scope', 'source', 'humanReview', 'expiresAt'], 'MEMBER_BINDING_INVALID');
  if (typeof review.graphDigest !== 'string' || !/^[a-f0-9]{64}$/.test(review.graphDigest)
    || args.graphDigest !== undefined && review.graphDigest !== args.graphDigest) fail(spec.mismatchCode);
  return review;
}
export function createWorkflowAuthority({ dataRoot }) {
  async function read(request) {
    if (!request.review) fail('COINS_ONLY_UNVERIFIED');
    return readPrivateJson(dataRoot, relativePath(request.review), 4 * 1024 * 1024, { ownerOnly: true, parse: parseJson });
  }
  const check = async args => validateWorkflowReview(await read(args.request), args);
  const authority = Object.freeze({
    check,
    preflight(args) {
      return preflightMembership({ ...args, check: time => check({ ...args, ...time }) });
    },
  });
  authorities.add(authority); return authority;
}
