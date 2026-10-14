import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { DEFAULT_JSON_BYTES, jsonValue, parseJson, exact, identifier } from './request-json.js';
import { validateOperationInputs } from './request-inputs.js';

export { DEFAULT_JSON_BYTES, jsonValue, parseJson, exact, identifier } from './request-json.js';

export function validateApiGraph(graph, maxBytes = DEFAULT_JSON_BYTES) {
  jsonValue(graph, maxBytes);
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.keys(graph).length) fail('INVALID_GRAPH');
  for (const [id, node] of Object.entries(graph)) {
    identifier(id);
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.class_type !== 'string' || !node.class_type
      || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) fail('INVALID_NODE');
    // Input arrays/objects may be literals. Only the backend knows custom node
    // semantics; do not reinterpret every array as a Comfy connection.
  }
  return graph;
}
export function validateRequest(request, { maxBytes = DEFAULT_JSON_BYTES, draft = false } = {}) {
  jsonValue(request, maxBytes);
  exact(request, ['format', 'workflowId', 'workflowJson', 'nodeInfoList', 'files', 'bindings', 'review', 'instanceType']);
  if (request.format !== 'hypit-runninghub.request@1') fail('INVALID_WORKFLOW_REQUEST');
  identifier(request.workflowId);
  if (request.instanceType !== undefined && !['default', 'plus', 'ultra'].includes(request.instanceType)) fail('INVALID_WORKFLOW_REQUEST');
  if (request.workflowJson !== undefined) validateApiGraph(parseJson(request.workflowJson, maxBytes), maxBytes);
  validateOperationInputs(request, { draft });
  return structuredClone(request);
}
export function requestDigest(request) {
  const { review, ...content } = validateRequest(request);
  return digest({ ...content, files: content.files.map(({ key, blob }) => ({ key, mediaType: blob.mediaType, size: blob.size })) });
}
export function mapRequest(request, filenames) {
  return [...request.nodeInfoList, ...request.bindings.map(binding => {
    const value = filenames.get(binding.fileKey);
    if (typeof value !== 'string' || !value) fail('UPLOAD_RESULT_INVALID');
    return { nodeId: binding.nodeId, fieldName: binding.fieldName, fieldValue: value };
  })];
}
export function validateTargets(graph, request) {
  for (const target of [...request.nodeInfoList, ...request.bindings]) {
    if (!Object.hasOwn(graph, target.nodeId)) fail('INVALID_NODE_MAPPING');
  }
}
