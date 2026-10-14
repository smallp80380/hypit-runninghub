import { createHash } from 'node:crypto';
import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { MEMBER_CONTRACT_SHA256 } from '../native/member-binding.js';
import { exact, jsonValue } from './request.js';
import { admitFile } from './media.js';
import { readBoundedFile } from './document.js';

const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function reviewCandidateEnvelope(config, credentialSha256, accessPasswordSha256) {
  if (!sha256(credentialSha256)) fail('CREDENTIAL_SHA256_REQUIRED');
  if (config.accessPassword !== undefined) {
    if (!sha256(accessPasswordSha256)) fail('ACCESS_PASSWORD_SHA256_REQUIRED');
  } else if (accessPasswordSha256 !== undefined) fail('MEMBER_BINDING_CREDENTIAL_MISMATCH');
  return {
    credential: { reference: config.apiKey, sha256: credentialSha256 },
    ...(config.accessPassword === undefined ? {} : { accessPasswordCredential: { reference: config.accessPassword, sha256: accessPasswordSha256 } }),
    baseUrl: config.baseUrl.replace(/\/$/, ''),
    source: { url: MEMBERSHIP_SOURCE, noteSha256: MEMBER_CONTRACT_SHA256 },
    humanReview: { kind: 'UNREVIEWED_OWNER_MUST_CHECK', recordId: 'OWNER_MUST_SET', reviewer: 'OWNER_MUST_SET', reviewedAt: null },
    expiresAt: null,
  };
}

export async function reviewCandidateInputs(draft, files) {
  jsonValue(files);
  if (!Array.isArray(files)) fail('REVIEW_FILE_MISMATCH');
  const metadata = [], fileDigests = [], keys = new Set();
  for (const file of files) {
    exact(file, ['key', 'path', 'mediaType']);
    if (typeof file.key !== 'string' || !file.key || keys.has(file.key)) fail('DUPLICATE_FILE_KEY'); keys.add(file.key);
    const raw = await readBoundedFile(file.path, 30 * 1024 * 1024);
    const admitted = admitFile({ mediaType: file.mediaType, size: raw.length }, raw);
    metadata.push({ key: file.key, mediaType: file.mediaType, size: admitted.bytes.length });
    fileDigests.push({ key: file.key, sha256: createHash('sha256').update(admitted.bytes).digest('hex') });
  }
  for (const [index, file] of draft.files.entries()) {
    if (metadata[index]?.key !== file.key || metadata[index]?.mediaType !== file.blob.mediaType || metadata[index]?.size !== file.blob.size) fail('REVIEW_FILE_MISMATCH');
  }
  for (const binding of draft.bindings) if (!keys.has(binding.fileKey)) fail('FILE_BINDING_MISSING');
  const { review, ...content } = draft;
  return { requestDigest: digest({ ...content, files: metadata }), fileDigests };
}
