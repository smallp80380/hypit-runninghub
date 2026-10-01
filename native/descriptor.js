import { createHash } from 'node:crypto';
import { fail } from '../core/errors.js';
import { relativePath } from '../core/config.js';
import { validateGraph, safeJSON } from '../workflow/revision.js';

// Serialize keys ourselves: JSON.stringify reorders integer-like object keys.
export function sortedJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean'
    || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (!value || typeof value !== 'object') fail('NON_JSON_VALUE');
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${sortedJson(value[k])}`).join(',')}}`;
}
export const digest = value => createHash('sha256').update(sortedJson(value)).digest('hex');
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(k => !keys.includes(k))) fail('INVALID_WORKFLOW_DESCRIPTOR');
}
function label(value) { if (typeof value !== 'string' || !value || value.length > 200) fail('INVALID_WORKFLOW_DESCRIPTOR'); }

export function validateDescriptor(value, graph, verifyTable) {
  const versionField = value && Object.getOwnPropertyDescriptor(value, 'schemaVersion');
  if (versionField && !Object.hasOwn(versionField, 'value')) fail('INVALID_WORKFLOW_DESCRIPTOR');
  const v2 = versionField?.value === 'hypit-runninghub.workflow@2';
  if (v2) { safeJSON(value); validateGraph(graph); }
  exact(value, ['schemaVersion', 'fixtureOnly', 'workflowId', 'graphFile', 'graphDigest', 'capability', 'portTable', 'bindings', ...(v2 ? ['sourceMode', 'resultSelection'] : [])]);
  if ((!v2 && value.schemaVersion !== 'hypit-runninghub.workflow@1') || typeof value.fixtureOnly !== 'boolean'
    || !/^[0-9]{1,40}$/.test(value.workflowId)) fail('INVALID_WORKFLOW_DESCRIPTOR');
  if (v2 && !['saved-id', 'inline-json'].includes(value.sourceMode)) fail('INVALID_WORKFLOW_DESCRIPTOR');
  if (v2 && value.resultSelection !== undefined) validateResultSelection(value.resultSelection, value.portTable?.result);
  relativePath(value.graphFile);
  exact(value.graphDigest, ['algorithm', 'canonicalization', 'value']);
  if (value.graphDigest.algorithm !== 'sha256' || value.graphDigest.canonicalization !== 'json-sorted-keys@1'
    || !/^[a-f0-9]{64}$/.test(value.graphDigest.value) || digest(graph) !== value.graphDigest.value) fail('WORKFLOW_REVISION_MISMATCH');
  if (!graph || typeof graph !== 'object' || Array.isArray(graph) || Object.keys(graph).length > 10_000) fail('INVALID_NATIVE_GRAPH');
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) fail('GRAPH_CYCLE');
    if (visited.has(id)) return;
    const node = graph[id];
    if (!node || typeof node.class_type !== 'string' || !node.inputs || typeof node.inputs !== 'object' || Array.isArray(node.inputs)) fail('INVALID_NATIVE_GRAPH');
    visiting.add(id);
    for (const input of Object.values(node.inputs)) {
      if (!Array.isArray(input)) continue;
      // API-format arrays are node/output-index connections for this adapter.
      // Literal array inputs are outside initial supported graph coverage.
      if (input.length !== 2 || typeof input[0] !== 'string' || !Number.isSafeInteger(input[1]) || input[1] < 0
        || !Object.hasOwn(graph, input[0])) fail('GRAPH_REFERENCE_INVALID');
      visit(input[0]);
    }
    visiting.delete(id); visited.add(id);
  }
  if (!v2) Object.keys(graph).forEach(visit);
  exact(value.capability, ['module', 'name']); exact(value.capability.module, ['name', 'version']);
  [value.capability.module.name, value.capability.module.version, value.capability.name].forEach(label);
  exact(value.portTable, ['model', 'result', 'ports', 'requires']);
  if (!['image', 'video'].includes(value.portTable.result) || !Array.isArray(value.portTable.ports)
    || value.portTable.ports.length < 1 || value.portTable.ports.length > 100
    || !Array.isArray(value.portTable.requires) || value.portTable.requires.length) fail('UNSUPPORTED_PORT_TABLE');
  if (typeof verifyTable !== 'function') fail('PUBLIC_SDK_VERIFIER_REQUIRED');
  verifyTable(value.portTable);
  const ports = new Map(value.portTable.ports.map(port => [port.name, port]));
  if (ports.size !== value.portTable.ports.length || !Array.isArray(value.bindings)
    || value.bindings.length !== ports.size) fail('INCOMPLETE_PORT_MAPPING');
  const mapped = new Set(), targets = new Set();
  for (const binding of value.bindings) {
    exact(binding, ['port', 'transport', 'targets']);
    const port = ports.get(binding.port);
    if (!port || mapped.has(binding.port) || !Array.isArray(binding.targets)
      || !Number.isInteger(port.maxItems) || port.maxItems < 1 || port.maxItems > 9
      || binding.targets.length < port.maxItems || binding.targets.length > 100) fail('INCOMPLETE_PORT_MAPPING');
    mapped.add(binding.port);
    exact(port, ['name', 'minItems', 'maxItems', 'value']);
    if (port.value.kind === 'media') {
      exact(port.value, ['kind', 'accepts']);
      if (![ '["image"]', ...(v2 ? ['["audio"]'] : []) ].includes(sortedJson(port.value.accepts)) || binding.transport !== 'legacy-filename') fail('UNSUPPORTED_MEDIA_PORT');
    } else {
      if (!['text', 'enum', 'number', 'boolean'].includes(port.value.kind) || binding.transport !== 'scalar') fail('UNSUPPORTED_SCALAR_PORT');
      exact(port.value, { text: ['kind', 'maxChars'], enum: ['kind', 'values'], number: ['kind', 'integer', 'minimum', 'maximum'], boolean: ['kind'] }[port.value.kind]);
    }
    const indexes = new Set();
    for (const target of binding.targets) {
      exact(target, ['itemIndex', 'nodeId', 'fieldName', 'expectedClassType']);
      [target.nodeId, target.fieldName, target.expectedClassType].forEach(label);
      const node = graph?.[target.nodeId];
      const key = sortedJson([target.nodeId, target.fieldName]);
      if (!Number.isInteger(target.itemIndex) || target.itemIndex < 0 || target.itemIndex >= port.maxItems
        || targets.has(key) || node?.class_type !== target.expectedClassType
        || !Object.hasOwn(node.inputs ?? {}, target.fieldName) || Array.isArray(node.inputs[target.fieldName])) fail('INVALID_NODE_MAPPING');
      const wireType = binding.transport === 'legacy-filename' || ['text', 'enum'].includes(port.value.kind)
        ? port.value.kind === 'enum' ? new Set(port.value.values.map(v => typeof v)) : new Set(['string'])
        : new Set([port.value.kind]);
      if (!wireType.has(typeof node.inputs[target.fieldName])) fail('NODE_FIELD_TYPE_MISMATCH');
      if (port.value.kind === 'enum' && port.value.values.some(v => typeof v !== typeof node.inputs[target.fieldName])) fail('NODE_FIELD_TYPE_MISMATCH');
      indexes.add(target.itemIndex); targets.add(key);
    }
    if (indexes.size !== port.maxItems) fail('INCOMPLETE_PORT_MAPPING');
  }
  return structuredClone(value);
}

// Selection is explicit consumer policy over documented extension outputType
// values. It does not infer output node provenance from array order.
export function validateResultSelection(value, result) {
  exact(value, ['kind', 'selectedOutputTypes', 'ignoredOutputTypes', 'maxSelected', 'maxIgnored']);
  if (value.kind !== 'extensions' || !Array.isArray(value.selectedOutputTypes) || !value.selectedOutputTypes.length
    || !Array.isArray(value.ignoredOutputTypes) || !Number.isInteger(value.maxSelected) || value.maxSelected < 1 || value.maxSelected > 20
    || !Number.isInteger(value.maxIgnored) || value.maxIgnored < 0 || value.maxIgnored > 20) fail('INVALID_RESULT_SELECTION');
  const types = [...value.selectedOutputTypes, ...value.ignoredOutputTypes];
  if (new Set(types).size !== types.length || types.some(t => !['png', 'jpg', 'mp4', 'mp3', 'wav', 'flac', 'txt'].includes(t))
    || value.selectedOutputTypes.some(t => !(result === 'video' ? ['mp4'] : ['jpg', 'png']).includes(t))) fail('INVALID_RESULT_SELECTION');
}

export function selectNativeResults(results, descriptor) {
  if (!Array.isArray(results) || !results.length || results.length > 20
    || results.some(r => !r || typeof r.url !== 'string' || descriptor.schemaVersion === 'hypit-runninghub.workflow@2' && !r.url)) fail('RESULT_RESPONSE_UNKNOWN');
  const selection = descriptor.schemaVersion === 'hypit-runninghub.workflow@2' ? descriptor.resultSelection : undefined;
  const selectedTypes = selection?.selectedOutputTypes ?? (descriptor.portTable.result === 'video' ? ['mp4'] : ['jpg', 'png']);
  const ignoredTypes = selection?.ignoredOutputTypes ?? [];
  if (selection) validateResultSelection(selection, descriptor.portTable.result);
  if (results.some(r => ![...selectedTypes, ...ignoredTypes].includes(r.outputType))) fail('RESULT_RESPONSE_UNKNOWN');
  const selected = results.filter(r => selectedTypes.includes(r.outputType)), ignored = results.length - selected.length;
  if (!selected.length || selected.length > (selection?.maxSelected ?? 20) || ignored > (selection?.maxIgnored ?? 0)) fail('RESULT_RESPONSE_UNKNOWN');
  return selected;
}

export function verifyRemoteGraph(response, descriptor) {
  if (response?.code !== 0 || typeof response.data?.prompt !== 'string') fail('WORKFLOW_RESPONSE_UNKNOWN');
  let graph; try { graph = JSON.parse(response.data.prompt); } catch { fail('WORKFLOW_RESPONSE_UNKNOWN'); }
  if (digest(graph) !== descriptor.graphDigest.value) fail('WORKFLOW_REVISION_MISMATCH');
  return graph;
}

export function mapNodes(descriptor, ports, uploads) {
  return descriptor.bindings.flatMap(binding => binding.targets.flatMap(target => {
    const item = ports[binding.port]?.[target.itemIndex];
    if (item === undefined) return [];
    const fieldValue = binding.transport === 'scalar' ? item : uploads.get(`${binding.port}/${target.itemIndex}`);
    if (fieldValue === undefined) fail('UPLOAD_MAPPING_MISSING');
    return [{ nodeId: target.nodeId, fieldName: target.fieldName, fieldValue }];
  }));
}
