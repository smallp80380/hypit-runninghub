import { fail, safeError } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { validateAiAppRequest } from './request.js';
import { aiAppCapability } from './model.js';
import { workflowTypes } from '../generic/references.js';

export function aiAppSupport(config, request) {
  try {
    if (digest(request.capability) !== digest(aiAppCapability) || digest(request.returns) !== digest(workflowTypes.result)) fail('CAPABILITY_MISMATCH');
    validateAiAppRequest(request.constraints, { maxBytes: config.budgets.maxRequestBytes, draft: Boolean(request.pendingInputs?.length) });
    if (!config.submissionEnabled) fail('SUBMISSION_DISABLED');
    if (!request.constraints.review) fail('COINS_ONLY_UNVERIFIED');
    // Intent selection is not verification of private review or account access.
    return { status: 'supported' };
  } catch (error) { return { status: 'unsupported', reason: `${safeError(error).code}: AI App request or reviewed Coins operation is unavailable.` }; }
}
