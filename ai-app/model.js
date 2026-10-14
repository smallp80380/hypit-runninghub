import { canonicalize, sealGraphFragment } from '@hypit/hypit/author-kit';
import { artifactTypes } from '@hypit/hypit/artifact';
import { workflowModule, workflowTypes, workflowProducers } from '../generic/references.js';
import { validateAiAppRequest } from './request.js';
import { fail } from '../core/errors.js';

export const aiAppTypes = Object.freeze({ request: { module: workflowModule, name: 'AiAppRequest' },
  draft: { module: workflowModule, name: 'AiAppDraft' }, result: workflowTypes.result,
  fileKey: workflowTypes.fileKey, outputIndex: workflowTypes.outputIndex });
export const aiAppCapability = Object.freeze({ module: workflowModule, name: 'run-ai-app' });
export const aiAppProducers = Object.freeze({ run: { module: workflowModule, name: 'run-ai-app' },
  bind: { module: workflowModule, name: 'bind-ai-app-file' }, finalize: { module: workflowModule, name: 'finalize-ai-app' }, output: workflowProducers.output });
export const aiAppDeclarations = {
  types: [aiAppTypes.request, aiAppTypes.draft].map(type => ({ name: type.name })),
  capabilities: [{ name: aiAppCapability.name, returns: workflowTypes.result }],
  producers: [
    { name: aiAppProducers.run.name, inputs: [{ name: 'request', type: aiAppTypes.request }], outputs: [], needs: [{ name: 'aiApp', capability: aiAppCapability, returns: workflowTypes.result }] },
    { name: aiAppProducers.bind.name, inputs: [{ name: 'draft', type: aiAppTypes.draft }, { name: 'key', type: workflowTypes.fileKey }, { name: 'file', type: artifactTypes.blob }], outputs: [{ name: 'draft', type: aiAppTypes.draft }], needs: [] },
    { name: aiAppProducers.finalize.name, inputs: [{ name: 'draft', type: aiAppTypes.draft }], outputs: [{ name: 'request', type: aiAppTypes.request }], needs: [] },
  ],
};
const inline = record => {
  if (record?.value.kind !== 'inline') fail('AI_APP_INLINE_REQUIRED');
  return record.value.value;
};
export const aiAppComponent = {
  validators: [
    { type: aiAppTypes.request, handler: ({ value }) => validateAiAppRequest(inline({ value })) },
    { type: aiAppTypes.draft, handler: ({ value }) => validateAiAppRequest(inline({ value }), { draft: true }) },
  ],
  producers: [
    { producer: aiAppProducers.run, handler: ({ inputs }) => ({ outputs: {}, needs: { aiApp: canonicalize(validateAiAppRequest(inline(inputs.request))) } }) },
    { producer: aiAppProducers.bind, handler: ({ inputs }) => {
      const draft = validateAiAppRequest(inline(inputs.draft), { draft: true });
      const key = inline(inputs.key), blob = inputs.file?.value;
      if (blob?.kind !== 'blob' || typeof key !== 'string') fail('INVALID_FILE_REFERENCE');
      draft.files.push({ key, blob });
      return { outputs: { draft: { kind: 'inline', value: canonicalize(validateAiAppRequest(draft, { draft: true })) } }, needs: {} };
    } },
    { producer: aiAppProducers.finalize, handler: ({ inputs }) => ({ outputs: { request: { kind: 'inline', value: canonicalize(validateAiAppRequest(inline(inputs.draft))) } }, needs: {} }) },
  ],
};
export const aiAppFragment = sealGraphFragment({
  inputs: [{ name: 'request', type: aiAppTypes.request }],
  operations: [{ id: 'run', producer: aiAppProducers.run, inputs: { request: { kind: 'fragment-input', name: 'request' } }, result: { kind: 'need', name: 'aiApp' } }],
  exports: [{ name: 'result', type: workflowTypes.result, root: { kind: 'fragment-operation', operation: 'run' } }],
});
