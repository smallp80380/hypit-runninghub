import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { parseJson, jsonValue, validateApiGraph, validateRequest, exact, identifier, DEFAULT_JSON_BYTES } from './request.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function seal(content) { return freeze({ ...content, revisionDigest: digest(content) }); }
export async function readBoundedFile(path, maxBytes = DEFAULT_JSON_BYTES) {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat(); if (!stat.isFile() || stat.size > maxBytes) fail('JSON_SIZE_LIMIT');
    const chunks = []; let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead; if (size > maxBytes) fail('JSON_SIZE_LIMIT'); chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}
export function importWorkflowDocument(sourceText) {
  const source = parseJson(sourceText);
  const ui = source && typeof source === 'object' && Array.isArray(source.nodes) && Array.isArray(source.links);
  if (!ui) validateApiGraph(source);
  return seal({ format: 'hypit-runninghub.document@1', sourceFormat: ui ? 'comfyui-ui' : 'api-json',
    sourceText, sourceSha256: sha(Buffer.from(sourceText)), parentDigest: null,
    executionReady: !ui, ...(ui ? { conversion: 'API_EXPORT_OR_VERIFIED_NODE_CONTRACTS_REQUIRED' } : { graph: structuredClone(source), graphDigest: digest(source) }),
    semanticValidation: 'UNVERIFIED' });
}
export async function importWorkflowFile(path) {
  const bytes = await readBoundedFile(path);
  const text = bytes.toString('utf8'); if (!Buffer.from(text).equals(bytes)) fail('INVALID_JSON_ENCODING');
  return importWorkflowDocument(text);
}
export function validateWorkflowDocument(document) {
  jsonValue(document, 32 * 1024 * 1024);
  exact(document, ['format', 'sourceFormat', 'sourceText', 'sourceSha256', 'parentDigest', 'executionReady', 'conversion', 'graph', 'graphDigest', 'semanticValidation', 'revisionDigest'], 'INVALID_WORKFLOW_DOCUMENT');
  if (document.format !== 'hypit-runninghub.document@1' || document.semanticValidation !== 'UNVERIFIED'
    || document.sourceSha256 !== sha(Buffer.from(document.sourceText ?? ''))
    || document.parentDigest !== null && !/^[a-f0-9]{64}$/.test(document.parentDigest)) fail('INVALID_WORKFLOW_DOCUMENT');
  const original = importWorkflowDocument(document.sourceText);
  if (document.sourceFormat !== original.sourceFormat || document.executionReady !== original.executionReady) fail('INVALID_WORKFLOW_DOCUMENT');
  if (document.executionReady) {
    validateApiGraph(document.graph); if (document.graphDigest !== digest(document.graph) || document.conversion !== undefined) fail('REVISION_DIGEST_MISMATCH');
  } else if (document.graph !== undefined || document.graphDigest !== undefined || document.conversion !== original.conversion) fail('INVALID_WORKFLOW_DOCUMENT');
  const { revisionDigest, ...content } = document;
  if (revisionDigest !== digest(content)) fail('REVISION_DIGEST_MISMATCH');
  return freeze(structuredClone(document));
}
export function editWorkflowDocument(document, operations, expectedDigest) {
  const original = validateWorkflowDocument(document);
  if (!original.executionReady) fail('API_EXPORT_REQUIRED');
  if (expectedDigest !== original.revisionDigest) fail('REVISION_CONFLICT');
  jsonValue(operations); if (!Array.isArray(operations) || !operations.length) fail('INVALID_OPERATIONS');
  const graph = structuredClone(original.graph);
  for (const op of operations) {
    exact(op, ['op', 'nodeId', 'node', 'fieldName', 'value', 'source', 'outputIndex'], 'INVALID_OPERATION');
    identifier(op.nodeId);
    if (['add', 'replace'].includes(op.op)) {
      if (['__proto__', 'constructor', 'prototype'].includes(op.nodeId)) fail('UNSAFE_JSON_KEY');
      if (Object.hasOwn(graph, op.nodeId) !== (op.op === 'replace')) fail('NODE_ID_CONFLICT');
      validateApiGraph({ [op.nodeId]: op.node }); graph[op.nodeId] = structuredClone(op.node); continue;
    }
    if (!Object.hasOwn(graph, op.nodeId)) fail('NODE_NOT_FOUND');
    if (op.op === 'remove') { delete graph[op.nodeId]; continue; }
    identifier(op.fieldName); if (['__proto__', 'constructor', 'prototype'].includes(op.fieldName)) fail('UNSAFE_JSON_KEY');
    if (op.op === 'setInput') {
      if (!Object.hasOwn(op, 'value')) fail('INVALID_OPERATION'); graph[op.nodeId].inputs[op.fieldName] = structuredClone(op.value);
    } else if (op.op === 'connect') {
      if (typeof op.source !== 'string' || !Object.hasOwn(graph, op.source) || !Number.isSafeInteger(op.outputIndex) || op.outputIndex < 0) fail('INVALID_CONNECTION');
      graph[op.nodeId].inputs[op.fieldName] = [op.source, op.outputIndex];
    } else if (op.op === 'disconnect') {
      if (Object.hasOwn(op, 'value')) graph[op.nodeId].inputs[op.fieldName] = structuredClone(op.value);
      else delete graph[op.nodeId].inputs[op.fieldName];
    } else fail('INVALID_OPERATION');
  }
  validateApiGraph(graph);
  const { revisionDigest, ...content } = original;
  // Backend/custom-node semantics remain unverified. Array-like literals are
  // never rewritten as links, even when a node is removed.
  return seal({ ...content, parentDigest: revisionDigest, graph, graphDigest: digest(graph) });
}
export function requestFromDocument(document, { workflowId, nodeInfoList = [], files = [], bindings = [], review, draft = false } = {}) {
  const source = validateWorkflowDocument(document);
  if (!source.executionReady) fail('API_EXPORT_REQUIRED');
  return validateRequest({ format: 'hypit-runninghub.request@1', workflowId, workflowJson: JSON.stringify(source.graph), nodeInfoList, files, bindings,
    ...(review === undefined ? {} : { review }) }, { draft });
}
export async function requestFromFile(path, options) { return requestFromDocument(await importWorkflowFile(path), options); }
export async function writeNewWorkflowFile(path, value) {
  jsonValue(value, 32 * 1024 * 1024);
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
