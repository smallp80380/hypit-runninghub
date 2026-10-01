import { Buffer } from 'node:buffer';
import { digest } from '../native/descriptor.js';
import { fail } from '../core/errors.js';
export const limits = Object.freeze({ bytes: 4 * 1024 * 1024, depth: 64, nodes: 10000, inputsPerNode: 1000, links: 100000 });
export const own = (value, key) => Object.hasOwn(value, key);
export function safeKey(key) {
  if (typeof key !== 'string' || !key || key.length > 200 || /[\u0000-\u001f]/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('UNSAFE_JSON_KEY');
}
export function safeJSON(value, depth = 0) {
  if (depth > limits.depth) fail('JSON_DEPTH_LIMIT');
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) fail('NON_JSON_VALUE');
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string')) fail('NON_JSON_VALUE');
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || value.length > 10000) fail('NON_JSON_VALUE');
    for (let i = 0; i < value.length; i++) {
      const field = Object.getOwnPropertyDescriptor(value, String(i));
      if (!field || !field.enumerable || !own(field, 'value')) fail('NON_JSON_VALUE');
      safeJSON(field.value, depth + 1);
    }
  } else {
    for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      safeKey(key); if (!field.enumerable || !own(field, 'value')) fail('NON_JSON_VALUE');
      safeJSON(field.value, depth + 1);
    }
  }
}
export function parseDocument(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > limits.bytes) fail('JSON_SIZE_LIMIT');
  let value; try { value = JSON.parse(text); } catch { fail('INVALID_JSON'); }
  // JSON.parse accepts duplicate keys. Detect them before accepting any graph.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g) ?? [];
  let i = 0;
  function walk(depth = 0) {
    if (depth > limits.depth) fail('JSON_DEPTH_LIMIT');
    if (tokens[i] === '{') {
      i++; const keys = new Set();
      while (tokens[i] !== '}') {
        const key = JSON.parse(tokens[i++]); safeKey(key);
        if (keys.has(key)) fail('DUPLICATE_JSON_KEY'); keys.add(key); i++; walk(depth + 1);
        if (tokens[i] === ',') i++; else break;
      }
      i++;
    } else if (tokens[i] === '[') {
      i++; while (tokens[i] !== ']') { walk(depth + 1); if (tokens[i] === ',') i++; else break; } i++;
    } else i++;
  }
  walk(); safeJSON(value); return value;
}
function exact(value, keys, code = 'INVALID_REVISION') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) fail(code);
}
export function connection(value) { return Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isSafeInteger(value[1]) && value[1] >= 0 && value[1] <= 1000000; }
export function validateGraph(graph) {
  safeJSON(graph);
  if (Buffer.byteLength(JSON.stringify(graph)) > limits.bytes) fail('JSON_SIZE_LIMIT');
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || !Object.keys(graph).length || Object.keys(graph).length > limits.nodes) fail('INVALID_GRAPH');
  const ids = Object.keys(graph), indegree = new Map(ids.map(id => [id, 0])), dependents = new Map(ids.map(id => [id, []])); let links = 0;
  for (const id of ids) {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) fail('INVALID_NODE_ID');
    const node = graph[id]; exact(node, ['class_type', 'inputs', '_meta'], 'INVALID_NODE');
    if (typeof node.class_type !== 'string' || !node.class_type || node.class_type.length > 200
      || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs) || Object.keys(node.inputs).length > limits.inputsPerNode
      || own(node, '_meta') && (!node._meta || typeof node._meta !== 'object' || Array.isArray(node._meta))) fail('INVALID_NODE');
    for (const input of Object.values(node.inputs)) {
      if (!Array.isArray(input)) continue;
      if (!connection(input) || !own(graph, input[0])) fail('GRAPH_REFERENCE_INVALID');
      if (++links > limits.links) fail('GRAPH_LINK_LIMIT');
      indegree.set(id, indegree.get(id) + 1); dependents.get(input[0]).push(id);
    }
  }
  const queue = ids.filter(id => indegree.get(id) === 0); let seen = 0;
  for (let index = 0; index < queue.length; index++) {
    seen++; for (const target of dependents.get(queue[index])) { indegree.set(target, indegree.get(target) - 1); if (!indegree.get(target)) queue.push(target); }
  }
  if (seen !== ids.length) fail('GRAPH_CYCLE');
  return { nodes: ids.length, links };
}
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function importWorkflow(graph, provenance = { kind: 'import-file' }, parentDigest = null) {
  validateGraph(graph); safeJSON(provenance); exact(provenance, ['kind', 'sourceDigest', 'workflowId', 'baseUrl']);
  if (!['import-file', 'fetched-workflow', 'local-edit'].includes(provenance.kind)
    || provenance.sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(provenance.sourceDigest)
    || provenance.workflowId !== undefined && !/^[0-9]{1,40}$/.test(provenance.workflowId)
    || provenance.baseUrl !== undefined && !['https://www.runninghub.ai', 'https://www.runninghub.cn'].includes(provenance.baseUrl)
    || parentDigest !== null && !/^[a-f0-9]{64}$/.test(parentDigest)) fail('INVALID_REVISION');
  const envelope = { format: 'hypit-runninghub.revision@1', graphDigest: { algorithm: 'sha256', canonicalization: 'json-sorted-keys@1', value: digest(graph) },
    parentDigest, graph: structuredClone(graph), provenance: structuredClone(provenance), semanticValidation: 'UNVERIFIED' };
  return freeze({ ...envelope, revisionDigest: digest(envelope) });
}
export function validateRevision(value) {
  safeJSON(value); exact(value, ['format', 'graphDigest', 'parentDigest', 'graph', 'provenance', 'semanticValidation', 'revisionDigest']);
  exact(value.graphDigest, ['algorithm', 'canonicalization', 'value']);
  if (value.format !== 'hypit-runninghub.revision@1' || value.semanticValidation !== 'UNVERIFIED'
    || value.graphDigest.algorithm !== 'sha256' || value.graphDigest.canonicalization !== 'json-sorted-keys@1'
    || value.graphDigest.value !== digest(value.graph)) fail('REVISION_DIGEST_MISMATCH');
  const checked = importWorkflow(value.graph, value.provenance, value.parentDigest);
  if (value.revisionDigest !== checked.revisionDigest) fail('REVISION_IDENTITY_MISMATCH');
  return checked;
}
export function inspectWorkflow(revision) {
  const checked = validateRevision(revision), counts = validateGraph(checked.graph);
  return { digest: checked.revisionDigest, graphDigest: checked.graphDigest.value, nodeCount: counts.nodes, links: counts.links, semanticValidation: 'UNVERIFIED',
    nodes: Object.entries(checked.graph).map(([id, n]) => ({ id, classType: n.class_type,
      inputs: Object.entries(n.inputs).map(([name, v]) => ({ name, kind: Array.isArray(v) ? 'connection' : v === null ? 'null' : typeof v,
        ...(connection(v) ? { source: v[0], outputIndex: v[1] } : { valueDigest: digest(v) }) })) })) };
}
