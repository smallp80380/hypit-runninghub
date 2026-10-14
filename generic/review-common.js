import { fail } from '../core/errors.js';
import { credentialSha256, MEMBER_CONTRACT_SHA256 } from '../native/member-binding.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { digest } from '../native/descriptor.js';
import { exact, jsonValue } from './request-json.js';

function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) fail('MEMBER_BINDING_TIME_INVALID');
  return Date.parse(value);
}
function credential(value, reference) {
  exact(value, ['reference', 'sha256'], 'MEMBER_BINDING_CREDENTIAL_MISMATCH');
  exact(value.reference, ['store', 'key'], 'MEMBER_BINDING_CREDENTIAL_MISMATCH');
  if (![value.reference.store, value.reference.key].every(v => typeof v === 'string' && v.length >= 1 && v.length <= 200)
    || digest(value.reference) !== digest(reference) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('MEMBER_BINDING_CREDENTIAL_MISMATCH');
}
export function validateReviewEnvelope(review, { config, request, fileDigests, secret, password, now, checkTime = true }, spec) {
  jsonValue(review);
  if (!review || typeof review !== 'object' || Array.isArray(review)) fail(spec.format === 'REVIEWED_AI_APP_OPERATION@1' ? 'COINS_ONLY_UNVERIFIED' : 'MEMBER_BINDING_INVALID');
  if (review.format !== spec.format) {
    if (spec.format === 'REVIEWED_AI_APP_OPERATION@1') fail(review.format === 'REVIEWED_WORKFLOW_OPERATION@1' ? spec.mismatchCode : 'COINS_ONLY_UNVERIFIED');
    fail('MEMBER_BINDING_FAMILY_MISMATCH');
  }
  if (config.keyType !== 'Consumer-Member' || review.scope !== spec.scope) fail('MEMBER_BINDING_FAMILY_MISMATCH');
  credential(review.credential, config.apiKey);
  if (config.accessPassword !== undefined) credential(review.accessPasswordCredential, config.accessPassword);
  else if (Object.hasOwn(review, 'accessPasswordCredential')) fail('MEMBER_BINDING_CREDENTIAL_MISMATCH');
  if (review.baseUrl !== config.baseUrl.replace(/\/$/, '')) fail('MEMBER_BINDING_ORIGIN_MISMATCH');
  if (review.requestDigest !== spec.digestRequest(request)
    || fileDigests !== undefined && digest(review.fileDigests) !== digest(fileDigests)) fail(spec.mismatchCode);
  if (!Array.isArray(review.fileDigests) || review.fileDigests.length !== request.files.length) fail(spec.mismatchCode);
  for (const [index, file] of review.fileDigests.entries()) {
    exact(file, ['key', 'sha256'], spec.mismatchCode);
    if (file.key !== request.files[index].key || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) fail(spec.mismatchCode);
  }
  exact(review.source, ['url', 'noteSha256'], 'MEMBER_BINDING_SOURCE_MISMATCH');
  if (review.source.url !== MEMBERSHIP_SOURCE || review.source.noteSha256 !== MEMBER_CONTRACT_SHA256) fail('MEMBER_BINDING_SOURCE_MISMATCH');
  const approvalCode = spec.format === 'REVIEWED_AI_APP_OPERATION@1' ? 'COINS_ONLY_UNVERIFIED' : 'MEMBER_REVIEW_REQUIRED';
  exact(review.humanReview, ['kind', 'recordId', 'reviewer', 'reviewedAt'], approvalCode);
  if (review.humanReview.kind !== spec.reviewKind
    || ![review.humanReview.recordId, review.humanReview.reviewer].every(v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(v))) fail(approvalCode);
  const reviewedAt = date(review.humanReview.reviewedAt), expiresAt = date(review.expiresAt);
  if (expiresAt <= reviewedAt) fail('MEMBER_BINDING_TIME_INVALID');
  if (checkTime && (!Number.isFinite(now) || reviewedAt > now || expiresAt <= now)) fail('MEMBER_BINDING_EXPIRED');
  if (secret !== undefined && credentialSha256(secret) !== review.credential.sha256) fail('MEMBER_BINDING_SECRET_MISMATCH');
  if (password !== undefined && (config.accessPassword === undefined || credentialSha256(password) !== review.accessPasswordCredential.sha256)) fail('MEMBER_BINDING_SECRET_MISMATCH');
  return review;
}
