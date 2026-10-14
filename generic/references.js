export const workflowModule = Object.freeze({ name: '@local/provider-runninghub', version: '1' });
export const workflowTypes = Object.freeze({ request: { module: workflowModule, name: 'WorkflowRequest' },
  draft: { module: workflowModule, name: 'WorkflowDraft' }, result: { module: workflowModule, name: 'WorkflowResult' },
  fileKey: { module: workflowModule, name: 'WorkflowFileKey' }, outputIndex: { module: workflowModule, name: 'WorkflowOutputIndex' } });
export const workflowCapability = Object.freeze({ module: workflowModule, name: 'run-workflow' });
export const workflowProducers = Object.freeze({ run: { module: workflowModule, name: 'run-workflow' },
  bind: { module: workflowModule, name: 'bind-workflow-file' }, finalize: { module: workflowModule, name: 'finalize-workflow' }, output: { module: workflowModule, name: 'select-workflow-output' } });
