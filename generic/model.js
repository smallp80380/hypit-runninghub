import { canonicalize, sealGraphFragment } from '@hypit/hypit/author-kit';
import { artifactTypes } from '@hypit/hypit/artifact';
import { validateRequest, jsonValue, exact } from './request.js';
import { fail } from '../core/errors.js';

import { workflowModule, workflowTypes, workflowCapability, workflowProducers } from './references.js';
import { aiAppDeclarations } from '../ai-app/model.js';
export { workflowModule, workflowTypes, workflowCapability, workflowProducers } from './references.js';
const inline = record => {
  if (record?.value.kind !== 'inline') fail('WORKFLOW_INLINE_REQUIRED');
  return record.value.value;
};
export function validateWorkflowResult(value) {
  jsonValue(value); exact(value, ['format', 'taskId', 'outputs', 'usage']);
  if (value.format !== 'hypit-runninghub.result@1' || typeof value.taskId !== 'string' || !Array.isArray(value.outputs)) fail('INVALID_WORKFLOW_RESULT');
  for (const item of value.outputs) {
    exact(item, ['blob', 'outputType', 'metadata']);
    exact(item.blob, ['kind', 'resource', 'size', 'mediaType']);
    if (item.blob.kind !== 'blob' || typeof item.blob.resource !== 'string' || !/^res_.+$/.test(item.blob.resource)
      || !Number.isSafeInteger(item.blob.size) || item.blob.size < 0 || typeof item.blob.mediaType !== 'string') fail('INVALID_WORKFLOW_RESULT');
    if (typeof item.outputType !== 'string') fail('INVALID_WORKFLOW_RESULT');
  }
  return value;
}
export const workflowManifest = {
  format: 'hypit.module@1', name: workflowModule.name, version: workflowModule.version,
  dependencies: [{ module: artifactTypes.blob.module }],
  types: [...Object.values(workflowTypes).map(type => ({ name: type.name })), ...aiAppDeclarations.types],
  capabilities: [{ name: workflowCapability.name, returns: workflowTypes.result }, ...aiAppDeclarations.capabilities],
  producers: [
    { name: workflowProducers.run.name, inputs: [{ name: 'request', type: workflowTypes.request }], outputs: [],
      needs: [{ name: 'workflow', capability: workflowCapability, returns: workflowTypes.result }] },
    { name: workflowProducers.bind.name, inputs: [{ name: 'draft', type: workflowTypes.draft }, { name: 'key', type: workflowTypes.fileKey }, { name: 'file', type: artifactTypes.blob }],
      outputs: [{ name: 'draft', type: workflowTypes.draft }], needs: [] },
    { name: workflowProducers.finalize.name, inputs: [{ name: 'draft', type: workflowTypes.draft }], outputs: [{ name: 'request', type: workflowTypes.request }], needs: [] },
    { name: workflowProducers.output.name, inputs: [{ name: 'result', type: workflowTypes.result }, { name: 'index', type: workflowTypes.outputIndex }], outputs: [{ name: 'file', type: artifactTypes.blob }], needs: [] },
    ...aiAppDeclarations.producers,
  ],
};
export const workflowComponent = {
  validators: [
    { type: workflowTypes.request, handler: ({ value }) => validateRequest(inline({ value })) },
    { type: workflowTypes.draft, handler: ({ value }) => validateRequest(inline({ value }), { draft: true }) },
    { type: workflowTypes.fileKey, handler: ({ value }) => { if (typeof inline({ value }) !== 'string' || !inline({ value })) fail('INVALID_FILE_KEY'); } },
    { type: workflowTypes.result, handler: ({ value }) => validateWorkflowResult(inline({ value })) },
    { type: workflowTypes.outputIndex, handler: ({ value }) => { const index = inline({ value }); if (!Number.isSafeInteger(index) || index < 0) fail('INVALID_OUTPUT_INDEX'); } },
  ],
  producers: [
    { producer: workflowProducers.run, handler: ({ inputs }) => ({ outputs: {}, needs: { workflow: canonicalize(validateRequest(inline(inputs.request))) } }) },
    { producer: workflowProducers.bind, handler: ({ inputs }) => {
      const draft = validateRequest(inline(inputs.draft), { draft: true });
      const key = inline(inputs.key), blob = inputs.file?.value;
      if (blob?.kind !== 'blob' || typeof key !== 'string') fail('INVALID_FILE_REFERENCE');
      draft.files.push({ key, blob });
      return { outputs: { draft: { kind: 'inline', value: canonicalize(validateRequest(draft, { draft: true })) } }, needs: {} };
    } },
    { producer: workflowProducers.finalize, handler: ({ inputs }) => ({ outputs: { request: { kind: 'inline', value: canonicalize(validateRequest(inline(inputs.draft))) } }, needs: {} }) },
    { producer: workflowProducers.output, handler: ({ inputs }) => {
      const result = validateWorkflowResult(inline(inputs.result)), index = inline(inputs.index);
      if (!Number.isSafeInteger(index) || index < 0 || !result.outputs[index]) fail('OUTPUT_INDEX_UNAVAILABLE');
      return { outputs: { file: result.outputs[index].blob }, needs: {} };
    } },
  ],
};
export const workflowFragment = sealGraphFragment({
  inputs: [{ name: 'request', type: workflowTypes.request }],
  operations: [{ id: 'run', producer: workflowProducers.run, inputs: { request: { kind: 'fragment-input', name: 'request' } }, result: { kind: 'need', name: 'workflow' } }],
  exports: [{ name: 'result', type: workflowTypes.result, root: { kind: 'fragment-operation', operation: 'run' } }],
});
