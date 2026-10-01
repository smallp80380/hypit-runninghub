import { defineEndpointPackage, canonicalize } from '@hypit/hypit/endpoint-kit';
import { fail, safeError } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { validTaskId } from '../core/submission-machine.js';
import { validateGenericConfig } from './config.js';
import { validateRequest } from './request.js';
import { workflowCapability, workflowTypes } from './model.js';
import { createWorkflowAuthority, isWorkflowAuthority } from './review.js';
import { createWorkflowLifecycle } from './lifecycle.js';

export function workflowSupport(config, request) {
  try {
    if (digest(request.capability) !== digest(workflowCapability) || digest(request.returns) !== digest(workflowTypes.result)) fail('CAPABILITY_MISMATCH');
    validateRequest(request.constraints, { maxBytes: config.budgets.maxRequestBytes, draft: Boolean(request.pendingInputs?.length) });
    if (!config.submissionEnabled) fail('SUBMISSION_DISABLED');
    if (!request.constraints.review) fail('COINS_ONLY_UNVERIFIED');
    // Pure selection verifies intent and presence of owner evidence. Actual
    // private review, key/account and source checks happen before effects.
    return { status: 'supported' };
  } catch (error) { return { status: 'unsupported', reason: `${safeError(error).code}: generic native request or reviewed Coins operation is unavailable.` }; }
}
export function createWorkflowProvider({ config, dataRoot, instance, pool, fetch, clock }) {
  const checked = validateGenericConfig(config), authority = createWorkflowAuthority({ dataRoot });
  if (!isWorkflowAuthority(authority)) fail('COINS_ONLY_UNVERIFIED');
  const lifecycle = createWorkflowLifecycle({ config: checked, dataRoot, instance, fetch, clock, authority });
  const wrap = method => async ctx => {
    try {
      if (method === 'start') {
        if (!checked.submissionEnabled) fail('SUBMISSION_DISABLED');
        if (digest(ctx.need?.capability) !== digest(workflowCapability)) fail('CAPABILITY_MISMATCH');
      }
      const key = ctx.credentials?.apiKey?.secret;
      if (typeof key !== 'string' || !key) fail('CREDENTIAL_MISSING');
      return canonicalize(await lifecycle[method]({ ...ctx, credentials: { apiKey: { secret: key } } }));
    } catch (error) {
      const safe = safeError(error);
      const taskId = error?.taskIds?.find(validTaskId) ?? (validTaskId(ctx.handle?.taskId) ? ctx.handle.taskId : undefined);
      return { status: 'failed', failure: { code: safe.code, message: `RunningHub workflow operation stopped: ${safe.code}.` },
        ...(taskId === undefined ? {} : { receipt: { id: taskId } }) };
    }
  };
  return defineEndpointPackage({ module: { name: '@local/provider-runninghub', version: '1' }, facet: 'workflow', instance, pool,
    credentials: { apiKey: checked.apiKey }, credentialInputs: { apiKey: { label: 'RunningHub Workflow API key' } }, defaultConcurrency: 1,
    actionLimits: { submit: { concurrency: 1 }, poll: { concurrency: 1 }, collect: { concurrency: 1 } },
    pricing: { kind: 'page', url: 'https://www.runninghub.ai/enterprise-api/consumerApi' },
    capabilities: [{ capability: workflowCapability, returns: workflowTypes.result, lifecycle: 'asynchronous', capacity: 'native-account',
      endpoint: { start: wrap('start'), poll: wrap('poll'), collect: wrap('collect') }, supports: request => workflowSupport(checked, request) }],
  });
}
