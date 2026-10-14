import { createRuntimeEndpointAdapterFacet } from '@hypit/hypit/runtime-kit';
import { validateCoreConfig } from './core/config.js';
import { readPrivateJson } from './native/private-files.js';
import { createNativeProvider } from './native/provider.js';
import { loadReviewedMemberAuthority } from './native/member-binding.js';
import { createWorkflowProvider } from './generic/provider.js';
import { workflowAuthorContribution } from './generic/author.js';
import { aiAppAuthorContribution } from './ai-app/author.js';

const clock = {
  now: () => Date.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeout(ms) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, cancel: () => clearTimeout(timer) }; },
};
const adapter = createRuntimeEndpointAdapterFacet({ use: '@local/provider-runninghub', async activate(context) {
  if (context.config?.schemaVersion === 'hypit-runninghub.config@2') return {
    endpoint: createWorkflowProvider({ config: context.config, dataRoot: context.dataRoot, instance: context.instance,
      pool: context.pool ?? context.instance, fetch: globalThis.fetch, clock }),
  };
  const config = validateCoreConfig(context.config);
  if (config.family !== 'native-workflow') throw new Error('MODEL_EXECUTION_DEFERRED_COINS_ONLY');
  const descriptor = await readPrivateJson(context.dataRoot, config.native.workflowDescriptor);
  const graph = await readPrivateJson(context.dataRoot, descriptor.graphFile);
  const memberAuthority = config.liveBillingEvidence.kind === 'private-file'
    ? await loadReviewedMemberAuthority({ dataRoot: context.dataRoot, config, descriptor }) : undefined;
  return { endpoint: createNativeProvider({ config, descriptor, graph, dataRoot: context.dataRoot,
    instance: context.instance, pool: context.pool ?? context.instance, fetch: globalThis.fetch, clock, memberAuthority }) };
} });
export default { ...workflowAuthorContribution,
  components: [...workflowAuthorContribution.components, ...aiAppAuthorContribution.components],
  hostFacets: [adapter, ...workflowAuthorContribution.hostFacets, ...aiAppAuthorContribution.hostFacets] };
