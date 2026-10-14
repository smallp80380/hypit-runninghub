import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { validateGenericConfig } from './config.js';
import { validateRequest, validateApiGraph, parseJson, validateTargets } from './request.js';
import { reviewCandidateEnvelope, reviewCandidateInputs } from './review-candidate-common.js';

export async function prepareWorkflowReviewCandidate({ config, request, graph, credentialSha256, accessPasswordSha256, files = [] }) {
  const checked = validateGenericConfig(config), draft = validateRequest(request, { draft: true });
  const envelope = reviewCandidateEnvelope(checked, credentialSha256, accessPasswordSha256);
  const source = graph ?? (draft.workflowJson === undefined ? undefined : parseJson(draft.workflowJson));
  if (!source) fail('REVIEW_GRAPH_REQUIRED'); validateApiGraph(source); validateTargets(source, draft);
  if (draft.workflowJson !== undefined && digest(parseJson(draft.workflowJson)) !== digest(source)) fail('WORKFLOW_REVISION_MISMATCH');
  const inputs = await reviewCandidateInputs(draft, files);
  return { reviewRequired: true, semanticValidation: 'UNVERIFIED', record: {
    format: 'REVIEWED_WORKFLOW_OPERATION@1', ...envelope, ...inputs, graphDigest: digest(source),
    scope: 'reviewed-native-only-no-external-money',
  } };
}
