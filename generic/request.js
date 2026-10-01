import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';

export const DEFAULT_JSON_BYTES = 4 * 1024 * 1024;
export function jsonValue(value, maxBytes = DEFAULT_JSON_BYTES) {
  const active = new Set();
  function visit(v, depth) {
    if (depth > 64) fail('JSON_DEPTH_LIMIT');
    if (v === null || ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)) return;
    if (!v || typeof v !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(v)) || active.has(v)) fail('NON_JSON_VALUE');
    active.add(v);
    const fields = Object.getOwnPropertyDescriptors(v);
    if (Reflect.ownKeys(v).some(k => typeof k !== 'string')) fail('NON_JSON_VALUE');
    for (const [key, field] of Object.entries(fields)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!field.enumerable || !Object.hasOwn(field, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('NON_JSON_VALUE');
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) fail('NON_JSON_VALUE');
      visit(field.value, depth + 1);
    }
    if (Array.isArray(v) && Object.keys(v).length !== v.length) fail('NON_JSON_VALUE');
    active.delete(v);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) fail('JSON_SIZE_LIMIT');
  return value;
}
export function parseJson(text, maxBytes = DEFAULT_JSON_BYTES) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) fail('JSON_SIZE_LIMIT');
  let value; try { value = JSON.parse(text); } catch { fail('INVALID_JSON'); }
  // JSON.parse otherwise silently overwrites duplicate keys.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let index = 0;
  function walk(depth = 0) {
    if (depth > 64) fail('JSON_DEPTH_LIMIT');
    if (tokens[index] === '{') {
      index++; const keys = new Set();
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) fail('DUPLICATE_JSON_KEY'); keys.add(key); index++; walk(depth + 1);
        if (tokens[index] === ',') index++; else break;
      }
      index++;
    } else if (tokens[index] === '[') {
      index++; while (tokens[index] !== ']') { walk(depth + 1); if (tokens[index] === ',') index++; else break; } index++;
    } else index++;
  }
  walk(); return jsonValue(value, maxBytes);
}
export function exact(value, keys, code = 'INVALID_WORKFLOW_REQUEST') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail(code);
}
export function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/.test(value)) fail('INVALID_WORKFLOW_REQUEST');
}
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
  exact(request, ['format', 'workflowId', 'workflowJson', 'nodeInfoList', 'files', 'bindings', 'review']);
  if (request.format !== 'hypit-runninghub.request@1') fail('INVALID_WORKFLOW_REQUEST');
  identifier(request.workflowId);
  if (request.workflowJson !== undefined) validateApiGraph(parseJson(request.workflowJson, maxBytes), maxBytes);
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
