import { defineEndpointPackage, canonicalize } from '@hypit/hypit/endpoint-kit';
import * as generation from '@hypit/hypit/generation';
import { defineExactModelModule } from '@hypit/hypit/model-kit';
import { validateCoreConfig } from '../core/config.js';
import { safeError, fail } from '../core/errors.js';
import { validateDescriptor, digest } from './descriptor.js';
import { createNativeLifecycle } from './lifecycle.js';
import { validTaskId } from '../core/submission-machine.js';
import { isReviewedMemberAuthority } from './member-binding.js';

export function createNativeModel(descriptor, graph) {
  const checked = validateDescriptor(descriptor, graph, generation.assertGenerationPortTable);
  if (checked.capability.name !== checked.portTable.model) fail('MODEL_CAPABILITY_MISMATCH');
  return defineExactModelModule({ module: checked.capability.module, endpoints: [{ key: 'generation',
    requestTypeName: 'NativeGenerationRequest', producerName: 'generate-native', ports: generation.sealGenerationPortTable(checked.portTable) }] });
}

export function nativeSupport(descriptor, request) {
  try {
    if (digest(request.capability) !== digest(descriptor.capability)) fail('CAPABILITY_MISMATCH');
    const returns = descriptor.portTable.result === 'video' ? generation.generationTypes.videoSet : generation.generationTypes.imageSet;
    if (digest(request.returns) !== digest(returns)) fail('RESULT_TYPE_MISMATCH');
    if (request.pendingInputs?.length) {
      // Public SDK planning input: media artifacts and authored text may not
      // exist yet. Validate the existing semantic draft, never invent bytes.
      generation.verifyRequestDraftAgainstPorts(descriptor.portTable, request.constraints);
    } else generation.verifyRequestAgainstPorts(descriptor.portTable, request.constraints);
    return { status: 'supported' };
  } catch { return { status: 'unsupported', reason: 'Request does not match the exact configured native workflow ports.' }; }
}

export function createNativeProvider({ config, descriptor, graph, dataRoot, instance, pool, fetch, clock, memberAuthority }) {
  const checkedConfig = validateCoreConfig(config);
  if (checkedConfig.family !== 'native-workflow') fail('MODEL_EXECUTION_DEFERRED_COINS_ONLY');
  const checked = validateDescriptor(descriptor, graph, generation.assertGenerationPortTable);
  createNativeModel(checked, graph);
  const admit = async ctx => {
    if (!checkedConfig.submissionEnabled) fail('SUBMISSION_DISABLED');
    if (!isReviewedMemberAuthority(memberAuthority)) fail('COINS_ONLY_UNVERIFIED');
    return memberAuthority.preflight({ config: checkedConfig, descriptor: checked, secret: ctx.credentials.apiKey.secret, fetch, clock });
  };
  const lifecycle = createNativeLifecycle({ config: checkedConfig, descriptor: checked, graph, dataRoot, instance, fetch, clock, sdk: generation,
    beforePrepare: admit, beforeSubmit: admit });
  const wrap = method => async ctx => {
    try { return canonicalize(await lifecycle[method](ctx)); }
    catch (error) {
      const safe = safeError(error);
      return { status: 'failed', failure: { code: safe.code, message: `RunningHub operation stopped: ${safe.code}.` },
        ...(validTaskId(ctx.handle?.taskId) ? { receipt: { id: ctx.handle.taskId } } : {}) };
    }
  };
  const endpoint = {
    async start(ctx) {
      try {
        if (!checkedConfig.submissionEnabled) fail('SUBMISSION_DISABLED');
        if (!isReviewedMemberAuthority(memberAuthority)) fail('COINS_ONLY_UNVERIFIED');
        const key = ctx.credentials?.apiKey?.secret;
        if (typeof key !== 'string' || !key) fail('CREDENTIAL_MISSING');
        // Capture the exact credential for every admission/upload/attempt.
        const captured = { ...ctx, credentials: { apiKey: { secret: key } } };
        return canonicalize(await lifecycle.start(captured));
      } catch (error) {
        const safe = safeError(error);
        return { status: 'failed', failure: { code: safe.code, message: `RunningHub submission stopped: ${safe.code}.` },
          ...(validTaskId(error?.taskIds?.[0]) ? { receipt: { id: error.taskIds[0] } } : {}) };
      }
    },
    poll: wrap('poll'), collect: wrap('collect'),
  };
  return defineEndpointPackage({ module: { name: '@local/provider-runninghub', version: '1' }, facet: 'native', instance, pool,
    credentials: { apiKey: checkedConfig.apiKey }, credentialInputs: { apiKey: { label: 'RunningHub Workflow API key' } },
    defaultConcurrency: 1,
    actionLimits: { submit: { concurrency: 1 }, poll: { concurrency: 1 }, collect: { concurrency: 1 } },
    pricing: { kind: 'page', url: 'https://www.runninghub.ai/enterprise-api/consumerApi' },
    capabilities: [{ capability: checked.capability,
      returns: checked.portTable.result === 'video' ? generation.generationTypes.videoSet : generation.generationTypes.imageSet,
      lifecycle: 'asynchronous', endpoint, capacity: checked.capability.name, supports: request => {
        const semantic = nativeSupport(checked, request);
        if (semantic.status === 'unsupported') return semantic;
        try {
          if (!checkedConfig.submissionEnabled) fail('SUBMISSION_DISABLED');
          if (!isReviewedMemberAuthority(memberAuthority)) fail('COINS_ONLY_UNVERIFIED');
          memberAuthority.checkStatic({ config: checkedConfig, descriptor: checked, now: clock.now() });
          // Supported means selectable subject to credential/account preflight.
          // The public SDK has no supported-with-reason or billing-proof field.
          return { status: 'supported' };
        } catch (error) { return { status: 'unsupported', reason: `${safeError(error).code}: reviewed Membership binding required; credential preflight has not passed.` }; }
      } }],
  });
}
