import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { MEMBER_CONTRACT_SHA256 } from '../native/member-binding.js';
import { createHash } from 'node:crypto';
import { validateGenericConfig } from './config.js';
import { validateRequest, validateApiGraph, parseJson, validateTargets, jsonValue, exact } from './request.js';
import { admitFile } from './media.js';
import { readBoundedFile } from './document.js';

export async function prepareWorkflowReviewCandidate({ config, request, graph, credentialSha256, files = [] }) {
  const checked = validateGenericConfig(config), draft = validateRequest(request, { draft: true });
  jsonValue(files);
  if (!/^[a-f0-9]{64}$/.test(credentialSha256)) fail('CREDENTIAL_SHA256_REQUIRED');
  const source = graph ?? (draft.workflowJson === undefined ? undefined : parseJson(draft.workflowJson));
  if (!source) fail('REVIEW_GRAPH_REQUIRED'); validateApiGraph(source); validateTargets(source, draft);
  if (draft.workflowJson !== undefined && digest(parseJson(draft.workflowJson)) !== digest(source)) fail('WORKFLOW_REVISION_MISMATCH');
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
  return { reviewRequired: true, semanticValidation: 'UNVERIFIED', record: {
    format: 'REVIEWED_WORKFLOW_OPERATION@1', credential: { reference: checked.apiKey, sha256: credentialSha256 }, baseUrl: checked.baseUrl.replace(/\/$/, ''),
    requestDigest: digest({ ...content, files: metadata }), graphDigest: digest(source), fileDigests,
    scope: 'reviewed-native-only-no-external-money', source: { url: MEMBERSHIP_SOURCE, noteSha256: MEMBER_CONTRACT_SHA256 },
    humanReview: { kind: 'UNREVIEWED_OWNER_MUST_CHECK', recordId: 'OWNER_MUST_SET', reviewer: 'OWNER_MUST_SET', reviewedAt: null }, expiresAt: null,
  } };
}
