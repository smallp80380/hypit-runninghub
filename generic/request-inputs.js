import { fail } from '../core/errors.js';
import { exact, identifier } from './request-json.js';

// Each operation validator checks its own JSON budget and top-level contract.
export function validateOperationInputs(request, { draft = false } = {}) {
  if (!Array.isArray(request.nodeInfoList) || !Array.isArray(request.files) || !Array.isArray(request.bindings)) fail('INVALID_WORKFLOW_REQUEST');
  const targets = new Set();
  function target(item) {
    identifier(item.nodeId); identifier(item.fieldName);
    if (['__proto__', 'constructor', 'prototype'].includes(item.fieldName)) fail('UNSAFE_JSON_KEY');
    const key = JSON.stringify([item.nodeId, item.fieldName]);
    if (targets.has(key)) fail('CONFLICTING_NODE_TARGET'); targets.add(key);
  }
  for (const item of request.nodeInfoList) {
    exact(item, ['nodeId', 'fieldName', 'fieldValue']); target(item);
    if (!Object.hasOwn(item, 'fieldValue')) fail('INVALID_WORKFLOW_REQUEST');
  }
  const keys = new Set();
  for (const file of request.files) {
    exact(file, ['key', 'blob']); identifier(file.key);
    if (keys.has(file.key)) fail('DUPLICATE_FILE_KEY'); keys.add(file.key);
    exact(file.blob, ['kind', 'resource', 'size', 'mediaType']);
    if (file.blob.kind !== 'blob' || typeof file.blob.resource !== 'string' || !/^res_.+$/.test(file.blob.resource)
      || !Number.isSafeInteger(file.blob.size) || file.blob.size < 0 || typeof file.blob.mediaType !== 'string' || !file.blob.mediaType) fail('INVALID_FILE_REFERENCE');
  }
  for (const item of request.bindings) {
    exact(item, ['fileKey', 'nodeId', 'fieldName']); identifier(item.fileKey); target(item);
    if (!draft && !keys.has(item.fileKey)) fail('FILE_BINDING_MISSING');
  }
  if (request.review !== undefined) identifier(request.review);
}
