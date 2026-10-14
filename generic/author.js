import { createMarkupSurfaceHostFacet } from '@hypit/hypit/author-kit';
import { artifactTypes } from '@hypit/hypit/artifact';
import { validateRequest } from './request.js';
import { workflowManifest, workflowComponent } from './model.js';
import { workflowModule, workflowProducers, workflowTypes, workflowCapability } from './references.js';
import { createOperationInputFragment, decodeOperationSurface, planOperationNeed } from './author-common.js';

const workflowSpec = { validator: validateRequest, types: workflowTypes, producers: workflowProducers, needPort: 'workflow' };
export function createWorkflowInputFragment(files = [], outputs = []) {
  return createOperationInputFragment(workflowSpec, files, outputs);
}
function planned(args) {
  return planOperationNeed(workflowSpec, args);
}
const plannedFacet = { producer: workflowProducers.run, port: 'workflow', capability: workflowCapability, plan: planned,
  present: specification => ({ fields: { workflowId: [specification.constraints.workflowId], source: [specification.constraints.workflowJson === undefined ? 'saved-id' : 'inline-json'] }, references: { files: specification.constraints.files.length + specification.pendingInputs.length } }) };

export async function decodeWorkflowSurface(args) {
  return decodeOperationSurface(workflowSpec, args);
}
export const workflowAuthorContribution = {
  format: 'hypit.node-package@1', modules: [{ manifest: workflowManifest }], components: [{ ...workflowComponent, plannedNeeds: [plannedFacet] }],
  hostFacets: [createMarkupSurfaceHostFacet({ module: workflowModule, declaration: { name: 'workflow', tag: 'Workflow', mode: 'structured', outputs: [workflowTypes.request, workflowTypes.result, workflowTypes.draft, workflowTypes.fileKey, workflowTypes.outputIndex, artifactTypes.blob],
    vocabulary: { summary: 'Any native RunningHub workflow request with zero or many files and heterogeneous outputs.', attributes: [{ name: 'id', kind: 'identifier', required: true, summary: 'Result identifier.' }],
      children: [{ tag: 'Request', cardinality: 'one', summary: 'Canonical request JSON, XML-escaped text.' }, { tag: 'File', cardinality: 'many', summary: 'Real Blob reference or explicit src/media-type; key binds the request targets.' }, { tag: 'Output', cardinality: 'many', summary: 'Explicit output index projected as an arbitrary Blob.' }],
      ports: [{ name: 'result', type: workflowTypes.result, summary: 'All result resources and safe metadata.' }], example: '<workflow:Workflow id="task"><Request>{...}</Request></workflow:Workflow>' } }, handler: decodeWorkflowSurface })],
};
