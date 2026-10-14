import { fail } from '../core/errors.js';
import { serviceBase } from '../core/config.js';
import { validateGenericConfig } from '../generic/config.js';
import { reviewCandidateEnvelope, reviewCandidateInputs } from '../generic/review-candidate-common.js';
import { validateAiAppDocument } from './document.js';
import { validateAiAppRequest, validateAiAppTargets } from './request.js';

export async function prepareAiAppReviewCandidate({ config, request, app, credentialSha256, accessPasswordSha256, files = [] }) {
  const checked = validateGenericConfig(config), draft = validateAiAppRequest(request, { draft: true });
  if (app === undefined) fail('REVIEW_APP_REQUIRED');
  const source = validateAiAppDocument(app);
  if (source.webappId !== draft.webappId
    || serviceBase(source.baseUrl, 'native-workflow') !== serviceBase(checked.baseUrl, 'native-workflow')) fail('MEMBER_BINDING_APP_MISMATCH');
  validateAiAppTargets(source, draft);
  if (source.accessEncrypted && checked.accessPassword === undefined) fail('ACCESS_PASSWORD_REQUIRED');
  const envelope = reviewCandidateEnvelope(checked, credentialSha256, accessPasswordSha256);
  const inputs = await reviewCandidateInputs(draft, files);
  return { reviewRequired: true, semanticValidation: 'UNVERIFIED', record: {
    format: 'REVIEWED_AI_APP_OPERATION@1', ...envelope, ...inputs, appDigest: source.appDigest,
    scope: 'reviewed-ai-app-only-no-external-money',
  } };
}
