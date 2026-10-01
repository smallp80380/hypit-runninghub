import { digest } from '../native/descriptor.js';
import { fail } from '../core/errors.js';
import { validateRevision, importWorkflow, validateGraph, own, safeJSON, safeKey, connection } from './revision.js';
const same = (a, b) => digest(a) === digest(b);
function exact(object, keys) { if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(k => !keys.includes(k))) fail('INVALID_EDIT'); }
function inputKind(value) { return value === null ? 'null' : Array.isArray(value) ? 'connection' : typeof value; }
function contractFor(graph, id, contracts) { return contracts && own(contracts, graph[id].class_type) ? contracts[graph[id].class_type] : undefined; }
function validateContracts(graph, contracts) {
  if (!contracts) return;
  safeJSON(contracts);
  for (const [id, node] of Object.entries(graph)) {
    const contract = contractFor(graph, id, contracts); if (!contract) continue;
    exact(contract, ['inputs', 'outputs']);
    if (!contract.inputs || typeof contract.inputs !== 'object' || Array.isArray(contract.inputs) || !Array.isArray(contract.outputs) || contract.outputs.some(x => typeof x !== 'string' || !x)) fail('INVALID_NODE_CONTRACT');
    for (const [field, spec] of Object.entries(contract.inputs)) {
      exact(spec, ['kind', 'required', 'connectionType']);
      if (!['string', 'number', 'boolean', 'null', 'object', 'connection'].includes(spec.kind)
        || typeof spec.required !== 'boolean') fail('INVALID_NODE_CONTRACT');
      if (!own(node.inputs, field)) { if (spec.required) fail('NODE_REQUIRED_INPUT'); continue; }
      const value = node.inputs[field];
      if (connection(value)) {
        const source = contractFor(graph, value[0], contracts);
        if (source && (value[1] >= source.outputs.length || spec.connectionType !== undefined && source.outputs[value[1]] !== spec.connectionType)) fail('NODE_CONNECTION_TYPE_MISMATCH');
      } else if (inputKind(value) !== spec.kind) fail('NODE_INPUT_TYPE_MISMATCH');
    }
  }
}
export function editWorkflow(revision, operations, expectedDigest, nodeContracts) {
  const before = validateRevision(revision);
  if (expectedDigest !== before.revisionDigest) fail('REVISION_CAS_CONFLICT');
  safeJSON(operations);
  if (!Array.isArray(operations) || !operations.length || operations.length > 1000) fail('INVALID_EDIT_BATCH');
  const graph = structuredClone(before.graph);
  for (const op of operations) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) fail('INVALID_EDIT');
    const keys = { add: ['op', 'nodeId', 'node'], replace: ['op', 'nodeId', 'node'], remove: ['op', 'nodeId'],
      setInput: ['op', 'nodeId', 'fieldName', 'value'], connect: ['op', 'nodeId', 'fieldName', 'sourceNodeId', 'outputIndex'],
      disconnect: ['op', 'nodeId', 'fieldName', 'value', 'removeOptional'] };
    exact(op, keys[op.op] ?? []);
    safeKey(op.nodeId); if (!/^[A-Za-z0-9_-]{1,100}$/.test(op.nodeId)) fail('INVALID_NODE_ID');
    if (op.op === 'add') { if (own(graph, op.nodeId)) fail('NODE_ALREADY_EXISTS'); graph[op.nodeId] = structuredClone(op.node); continue; }
    if (!own(graph, op.nodeId)) fail('NODE_NOT_FOUND');
    if (op.op === 'remove') { delete graph[op.nodeId]; continue; }
    if (op.op === 'replace') { graph[op.nodeId] = structuredClone(op.node); continue; }
    safeKey(op.fieldName); const node = graph[op.nodeId];
    if (!own(node.inputs, op.fieldName)) fail('INPUT_NOT_FOUND');
    const previous = node.inputs[op.fieldName];
    if (op.op === 'setInput') {
      if (!own(op, 'value') || Array.isArray(op.value) || connection(previous) || inputKind(previous) !== inputKind(op.value)) fail('NODE_INPUT_TYPE_MISMATCH');
      node.inputs[op.fieldName] = structuredClone(op.value);
    } else if (op.op === 'connect') {
      if (!own(graph, op.sourceNodeId) || !connection([op.sourceNodeId, op.outputIndex])) fail('GRAPH_REFERENCE_INVALID');
      node.inputs[op.fieldName] = [op.sourceNodeId, op.outputIndex];
    } else if (op.op === 'disconnect') {
      if (!connection(previous)) fail('INPUT_NOT_CONNECTED');
      if (own(op, 'removeOptional') && typeof op.removeOptional !== 'boolean' || op.removeOptional === true && own(op, 'value')) fail('INVALID_EDIT');
      const spec = contractFor(graph, op.nodeId, nodeContracts)?.inputs?.[op.fieldName];
      if (op.removeOptional === true) { if (!spec || spec.required !== false) fail('OPTIONAL_INPUT_CONTRACT_REQUIRED'); delete node.inputs[op.fieldName]; }
      else { if (!own(op, 'value') || Array.isArray(op.value) || !spec || inputKind(op.value) !== spec.kind) fail('DISCONNECT_TYPE_CONTRACT_REQUIRED'); node.inputs[op.fieldName] = structuredClone(op.value); }
    } else fail('UNKNOWN_EDIT_OPERATION');
  }
  validateGraph(graph); validateContracts(graph, nodeContracts);
  if (same(graph, before.graph)) fail('NO_GRAPH_CHANGE');
  return importWorkflow(graph, { kind: 'local-edit', sourceDigest: before.graphDigest.value }, before.revisionDigest);
}
export function diffWorkflows(before, after) {
  const a = validateRevision(before), b = validateRevision(after); const changes = [];
  for (const id of [...new Set([...Object.keys(a.graph), ...Object.keys(b.graph)])].sort()) {
    if (!own(a.graph, id) || !own(b.graph, id)) { changes.push({ nodeId: id, kind: own(a.graph, id) ? 'removed' : 'added' }); continue; }
    const old = a.graph[id], current = b.graph[id];
    if (old.class_type !== current.class_type) changes.push({ nodeId: id, kind: 'class', before: old.class_type, after: current.class_type });
    for (const field of [...new Set([...Object.keys(old.inputs), ...Object.keys(current.inputs)])].sort()) {
      if (own(old.inputs, field) && own(current.inputs, field) && same(old.inputs[field], current.inputs[field])) continue;
      changes.push({ nodeId: id, fieldName: field, kind: 'input', ...(own(old.inputs, field) ? { beforeDigest: digest(old.inputs[field]) } : {}),
        ...(own(current.inputs, field) ? { afterDigest: digest(current.inputs[field]) } : {}) });
    }
    if (!same(old._meta ?? null, current._meta ?? null)) changes.push({ nodeId: id, kind: 'metadata' });
  }
  return { beforeDigest: a.revisionDigest, afterDigest: b.revisionDigest, beforeGraphDigest: a.graphDigest.value, afterGraphDigest: b.graphDigest.value, semanticValidation: 'UNVERIFIED', changes };
}
