import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { DEFAULT_JSON_BYTES, jsonValue, exact } from '../generic/request-json.js';
import { validateOperationInputs } from '../generic/request-inputs.js';

export function validateAiAppRequest(request, { maxBytes = DEFAULT_JSON_BYTES, draft = false } = {}) {
  jsonValue(request, maxBytes);
  exact(request, ['format', 'webappId', 'nodeInfoList', 'files', 'bindings', 'review', 'instanceType'], 'INVALID_AI_APP_REQUEST');
  if (request.format !== 'hypit-runninghub.ai-app-request@1'
    || typeof request.webappId !== 'string' || !/^[0-9]{1,40}$/.test(request.webappId)
    || request.instanceType !== undefined && !['default', 'plus', 'ultra'].includes(request.instanceType)) fail('INVALID_AI_APP_REQUEST');
  validateOperationInputs(request, { draft });
  return structuredClone(request);
}

export function aiAppRequestDigest(request) {
  const { review, ...content } = validateAiAppRequest(request);
  return digest({ ...content, files: content.files.map(({ key, blob }) => ({ key, mediaType: blob.mediaType, size: blob.size })) });
}

// The source document is validated by its loader; only its literal editable
// target pairs are known here, not the app's hidden graph or field semantics.
export function validateAiAppTargets(document, request) {
  if (document.webappId !== request.webappId) fail('INVALID_NODE_MAPPING');
  validateOperationInputs(request, { draft: true });
  const targets = new Set(document.nodeInfoList.map(node => JSON.stringify([node.nodeId, node.fieldName])));
  for (const target of [...request.nodeInfoList, ...request.bindings]) {
    if (!targets.has(JSON.stringify([target.nodeId, target.fieldName]))) fail('INVALID_NODE_MAPPING');
  }
}
