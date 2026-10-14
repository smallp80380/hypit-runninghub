import { fail } from '../core/errors.js';
import { createJsonTransport } from '../core/transport.js';
import { digest } from '../native/descriptor.js';
import { validateRequest, validateApiGraph, validateTargets, parseJson, mapRequest } from './request.js';
import { createNativeOperationLifecycle } from './operation-lifecycle.js';

export function createWorkflowLifecycle({ config, dataRoot, instance, fetch, clock, authority }) {
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: 'native-workflow', fetch, clock,
    timeoutMs: config.http.requestTimeoutMs, maxResponseBytes: config.http.maxResponseBytes });
  const protocol = {
    validateRequest,
    async fetchSource(request, key) {
      if (request.workflowJson !== undefined) return validateApiGraph(parseJson(request.workflowJson, config.budgets.maxRequestBytes), config.budgets.maxRequestBytes);
      const result = await transport.request({ path: '/api/openapi/getJsonApiFormat', secret: key, body: { apiKey: key, workflowId: request.workflowId } });
      if (result.code !== 0 || typeof result.data?.prompt !== 'string') fail('WORKFLOW_RESPONSE_UNKNOWN');
      return validateApiGraph(parseJson(result.data.prompt, config.budgets.maxRequestBytes), config.budgets.maxRequestBytes);
    },
    validateSource: graph => validateApiGraph(graph, config.budgets.maxRequestBytes),
    validateTargets(graph, request) {
      validateTargets(graph, request);
      if (request.workflowJson !== undefined && digest(parseJson(request.workflowJson, config.budgets.maxRequestBytes)) !== digest(graph)) fail('PREPARATION_IDENTITY_MISMATCH');
    },
    digestSource: digest,
    sourceField: 'graph',
    sourceDigestField: 'graphDigest',
    preparationFormat: 'workflow-preparation@1',
    handleContract: 'hypit.runninghub.workflow@1',
    submitPath: '/task/openapi/create',
    wire(request, graph, filenames) {
      const nodeInfoList = mapRequest(request, filenames);
      const body = { workflowId: request.workflowId, nodeInfoList };
      if (request.workflowJson !== undefined) {
        const effective = structuredClone(graph);
        for (const item of nodeInfoList) effective[item.nodeId].inputs[item.fieldName] = item.fieldValue;
        body.workflow = JSON.stringify(effective);
      }
      if (request.instanceType !== undefined) body.instanceType = request.instanceType;
      return body;
    },
    reviewArgs(request, graph, files, key, password) {
      return { config, request, graphDigest: digest(graph), fileDigests: files.map(file => ({ key: file.key, sha256: file.sha256 })), secret: key, password, fetch, clock };
    },
    revisionMismatchCode: 'WORKFLOW_REVISION_MISMATCH',
  };
  return createNativeOperationLifecycle({ config, dataRoot, instance, fetch, clock, authority, protocol });
}
