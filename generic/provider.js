import { defineEndpointPackage, canonicalize } from '@hypit/hypit/endpoint-kit';
import { fail, safeError } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { validTaskId } from '../core/submission-machine.js';
import { validateGenericConfig } from './config.js';
import { validateRequest } from './request.js';
import { workflowCapability, workflowTypes } from './model.js';
import { createWorkflowAuthority, isWorkflowAuthority } from './review.js';
import { createWorkflowLifecycle } from './lifecycle.js';
import { aiAppCapability } from '../ai-app/model.js';
import { aiAppSupport } from '../ai-app/provider.js';
import { createAiAppAuthority, isAiAppAuthority } from '../ai-app/review.js';
import { createAiAppLifecycle } from '../ai-app/lifecycle.js';

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
  const checked = validateGenericConfig(config), authority = createWorkflowAuthority({ dataRoot }), appAuthority = createAiAppAuthority({ dataRoot });
  if (!isWorkflowAuthority(authority) || !isAiAppAuthority(appAuthority)) fail('COINS_ONLY_UNVERIFIED');
  const lifecycle = createWorkflowLifecycle({ config: checked, dataRoot, instance, fetch, clock, authority });
  const appLifecycle = createAiAppLifecycle({ config: checked, dataRoot, instance, fetch, clock, authority: appAuthority });
  const wrap = (capability, operation, method) => async ctx => {
    const secrets = [];
    let credentialsCaptured = false;
    const safeTaskId = value => validTaskId(value) && !secrets.some(secret => value.includes(secret));
    try {
      if (method === 'start') {
        if (!checked.submissionEnabled) fail('SUBMISSION_DISABLED');
        if (digest(ctx.need?.capability) !== digest(capability)) fail('CAPABILITY_MISMATCH');
      }
      const credentials = ctx.credentials;
      const key = credentials?.apiKey?.secret;
      if (typeof key === 'string' && key) secrets.push(key);
      const password = checked.accessPassword ? credentials?.accessPassword?.secret : undefined;
      if (typeof password === 'string' && password) secrets.push(password);
      if (typeof key !== 'string' || !key) fail('CREDENTIAL_MISSING');
      if (checked.accessPassword && (typeof password !== 'string' || !password)) fail('ACCESS_PASSWORD_REQUIRED');
      credentialsCaptured = true;
      const capturedContext = Object.create(ctx, { credentials: { enumerable: true,
        value: { apiKey: { secret: key }, ...(checked.accessPassword ? { accessPassword: { secret: password } } : {}) } } });
      return canonicalize(await operation[method](capturedContext));
    } catch (error) {
      const safe = safeError(error);
      const taskId = credentialsCaptured
        ? error?.taskIds?.find(safeTaskId) ?? (safeTaskId(ctx.handle?.taskId) ? ctx.handle.taskId : undefined)
        : undefined;
      return { status: 'failed', failure: { code: safe.code, message: `RunningHub operation stopped: ${safe.code}.` },
        ...(taskId === undefined ? {} : { receipt: { id: taskId } }) };
    }
  };
  return defineEndpointPackage({ module: { name: '@local/provider-runninghub', version: '1' }, facet: 'workflow', instance, pool,
    credentials: { apiKey: checked.apiKey, ...(checked.accessPassword ? { accessPassword: checked.accessPassword } : {}) },
    credentialInputs: { apiKey: { label: 'RunningHub Membership API key' }, ...(checked.accessPassword ? { accessPassword: { label: 'RunningHub service access password' } } : {}) }, defaultConcurrency: 1,
    actionLimits: { submit: { concurrency: 1 }, poll: { concurrency: 1 }, collect: { concurrency: 1 } },
    pricing: { kind: 'page', url: 'https://www.runninghub.ai/enterprise-api/consumerApi' },
    capabilities: [
      { capability: workflowCapability, returns: workflowTypes.result, lifecycle: 'asynchronous', capacity: 'native-account',
        endpoint: { start: wrap(workflowCapability, lifecycle, 'start'), poll: wrap(workflowCapability, lifecycle, 'poll'), collect: wrap(workflowCapability, lifecycle, 'collect') }, supports: request => workflowSupport(checked, request) },
      { capability: aiAppCapability, returns: workflowTypes.result, lifecycle: 'asynchronous', capacity: 'native-account',
        endpoint: { start: wrap(aiAppCapability, appLifecycle, 'start'), poll: wrap(aiAppCapability, appLifecycle, 'poll'), collect: wrap(aiAppCapability, appLifecycle, 'collect') }, supports: request => aiAppSupport(checked, request) },
    ],
  });
}
