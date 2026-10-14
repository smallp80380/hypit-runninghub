import { createMarkupSurfaceHostFacet } from '@hypit/hypit/author-kit';
import { artifactTypes } from '@hypit/hypit/artifact';
import { workflowModule, workflowTypes } from '../generic/references.js';
import { createOperationInputFragment, decodeOperationSurface, planOperationNeed } from '../generic/author-common.js';
import { validateAiAppRequest } from './request.js';
import { aiAppTypes, aiAppProducers, aiAppCapability, aiAppComponent } from './model.js';

const aiAppSpec = { validator: validateAiAppRequest, types: aiAppTypes, producers: aiAppProducers, needPort: 'aiApp' };
export function createAiAppInputFragment(files = [], outputs = []) {
  return createOperationInputFragment(aiAppSpec, files, outputs);
}
export async function decodeAiAppSurface(args) {
  return decodeOperationSurface(aiAppSpec, args);
}
const plannedFacet = {
  producer: aiAppProducers.run, port: 'aiApp', capability: aiAppCapability,
  plan: args => planOperationNeed(aiAppSpec, args),
  present: specification => ({
    fields: { webappId: [specification.constraints.webappId], source: ['ai-app'] },
    references: { files: specification.constraints.files.length + specification.pendingInputs.length },
  }),
};
export const aiAppAuthorContribution = {
  format: 'hypit.node-package@1',
  components: [{ ...aiAppComponent, plannedNeeds: [plannedFacet] }],
  hostFacets: [createMarkupSurfaceHostFacet({
    module: workflowModule,
    declaration: {
      name: 'aiApp', tag: 'AiApp', mode: 'structured',
      outputs: [aiAppTypes.request, workflowTypes.result, aiAppTypes.draft, workflowTypes.fileKey, workflowTypes.outputIndex, artifactTypes.blob],
      vocabulary: {
        summary: 'Any native RunningHub AI App request with zero or many files and heterogeneous outputs.',
        attributes: [{ name: 'id', kind: 'identifier', required: true, summary: 'Result identifier.' }],
        children: [
          { tag: 'Request', cardinality: 'one', summary: 'Canonical request JSON, XML-escaped text.' },
          { tag: 'File', cardinality: 'many', summary: 'Real Blob reference or explicit src/media-type; key binds the request targets.' },
          { tag: 'Output', cardinality: 'many', summary: 'Explicit output index projected as an arbitrary Blob.' },
        ],
        ports: [{ name: 'result', type: workflowTypes.result, summary: 'All result resources and safe metadata.' }],
        example: '<workflow:AiApp id="app"><Request>{...}</Request></workflow:AiApp>',
      },
    },
    handler: decodeAiAppSurface,
  })],
};
