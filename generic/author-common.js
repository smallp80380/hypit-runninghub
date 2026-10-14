import { canonicalize, sealGraphFragment } from '@hypit/hypit/author-kit';
import { artifactTypes } from '@hypit/hypit/artifact';
import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { parseJson, exact } from './request.js';
import { workflowTypes, workflowProducers } from './references.js';

export function createOperationInputFragment(spec, files = [], outputs = []) {
  const names = new Set(['draft', 'result']);
  for (const entry of outputs) {
    if (typeof entry.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(entry.name) || names.has(entry.name)) fail('INVALID_AUTHOR_INPUT');
    names.add(entry.name);
  }
  const inputs = [{ name: 'draft', type: spec.types.draft }], operations = [], exports = [];
  const input = name => ({ kind: 'fragment-input', name }), operation = name => ({ kind: 'fragment-operation', operation: name });
  let draft = input('draft');
  for (const [index, file] of files.entries()) {
    const fileName = `file${index}`, keyName = `key${index}`, id = `bind${index}`;
    inputs.push({ name: fileName, type: artifactTypes.blob }, { name: keyName, type: workflowTypes.fileKey });
    operations.push({ id, producer: spec.producers.bind, inputs: { draft, key: input(keyName), file: input(fileName) }, result: { kind: 'output', name: 'draft' } });
    draft = operation(id);
  }
  operations.push({ id: 'finalize', producer: spec.producers.finalize, inputs: { draft }, result: { kind: 'output', name: 'request' } },
    { id: 'run', producer: spec.producers.run, inputs: { request: operation('finalize') }, result: { kind: 'need', name: spec.needPort } });
  exports.push({ name: 'result', type: workflowTypes.result, root: operation('run') });
  for (const [index, selected] of outputs.entries()) {
    const name = `outputIndex${index}`, id = `select${index}`;
    inputs.push({ name, type: workflowTypes.outputIndex });
    operations.push({ id, producer: workflowProducers.output, inputs: { result: operation('run'), index: input(name) }, result: { kind: 'output', name: 'file' } });
    exports.push({ name: selected.name, type: artifactTypes.blob, root: operation(id) });
  }
  return sealGraphFragment({ inputs, operations, exports });
}
export function planOperationNeed(spec, { state, step, port }) {
  const run = state.plan.steps.find(item => item.id === step);
  if (!run || digest(run.producer) !== digest(spec.producers.run)) return;
  const knownNeed = state.needs.find(item => item.id === run.needs[port]?.id);
  if (knownNeed) return { constraints: spec.validator(knownNeed.constraints), pendingInputs: [] };
  const records = new Map(state.records.map(record => [record.id, record]));
  const byOutput = new Map(state.plan.steps.flatMap(item => Object.values(item.outputs).map(id => [id, item])));
  const direct = records.get(run.inputs.request);
  if (direct?.value.kind === 'inline') return { constraints: spec.validator(direct.value.value), pendingInputs: [] };
  const finalize = byOutput.get(run.inputs.request);
  if (!finalize || digest(finalize.producer) !== digest(spec.producers.finalize)) return;
  const chain = [], seen = new Set(); let cursor = finalize.inputs.draft;
  while (!records.has(cursor)) {
    if (seen.has(cursor)) fail('REQUEST_ASSEMBLY_CYCLE'); seen.add(cursor);
    const binding = byOutput.get(cursor);
    if (!binding || digest(binding.producer) !== digest(spec.producers.bind)) fail('REQUEST_ASSEMBLY_UNKNOWN');
    chain.push(binding); cursor = binding.inputs.draft;
  }
  const base = records.get(cursor); if (base.value.kind !== 'inline') fail('WORKFLOW_INLINE_REQUIRED');
  const request = spec.validator(base.value.value, { draft: true }), pendingInputs = [];
  for (const binding of chain.reverse()) {
    const key = records.get(binding.inputs.key)?.value; if (key?.kind !== 'inline' || typeof key.value !== 'string') fail('INVALID_FILE_KEY');
    const file = records.get(binding.inputs.file);
    if (file?.value.kind === 'blob') request.files.push({ key: key.value, blob: file.value });
    else pendingInputs.push({ input: key.value, record: binding.inputs.file, ...(byOutput.get(binding.inputs.file) ? { sourceStep: byOutput.get(binding.inputs.file).id } : {}) });
  }
  return { constraints: spec.validator(request, { draft: pendingInputs.length > 0 }), pendingInputs };
}

export async function decodeOperationSurface(spec, { element, resolveReference, resolveAsset }) {
  exact(element.attributes, ['id'], 'INVALID_AUTHOR_ATTRIBUTE');
  const id = element.attributes.id;
  if (typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id)) fail('INVALID_AUTHOR_ID');
  const children = element.children.filter(node => node.kind === 'element');
  if (element.children.some(node => node.kind !== 'element' && node.value.trim())) fail('INVALID_AUTHOR_CHILD');
  const local = node => node.name.split(':').at(-1);
  if (children.some(node => !['Request', 'File', 'Output'].includes(local(node)))) fail('INVALID_AUTHOR_CHILD');
  const requests = children.filter(node => local(node) === 'Request'); if (requests.length !== 1) fail('AUTHOR_REQUEST_REQUIRED');
  const source = requests[0]; exact(source.attributes, []); if (source.children.some(node => node.kind === 'element')) fail('INVALID_AUTHOR_CHILD');
  const request = spec.validator(parseJson(source.children.map(node => node.value).join('')), { draft: true });
  const reserved = new Set(['result', ...children.filter(node => local(node) === 'Output').map(node => node.attributes.name)].map(name => `${id}.${name}`));
  function recordId(suffix) { let name = `${id}.__rh.${suffix}`; while (reserved.has(name)) name += '_'; reserved.add(name); return name; }
  const draftId = recordId('draft');
  const files = [], outputs = [], records = [{ id: draftId, type: spec.types.draft, value: { kind: 'inline', value: canonicalize(request) }, range: element.range }];
  const inputs = { draft: { kind: 'record', id: draftId } };
  for (const child of children.filter(node => local(node) === 'File')) {
    exact(child.attributes, ['key', 'source', 'src', 'media-type']);
    if (child.children.some(node => node.kind === 'element' || node.value.trim())) fail('INVALID_AUTHOR_CHILD');
    const key = child.attributes.key; if (typeof key !== 'string' || !key) fail('INVALID_FILE_KEY');
    const index = files.length; files.push({ name: `input${index}` });
    const keyId = recordId(`key${index}`); records.push({ id: keyId, type: workflowTypes.fileKey, value: { kind: 'inline', value: key }, range: child.range }); inputs[`key${index}`] = { kind: 'record', id: keyId };
    if (child.attributes.source !== undefined) {
      if (child.attributes.src !== undefined || child.attributes['media-type'] !== undefined || child.attributes.source?.kind !== 'reference') fail('INVALID_AUTHOR_REFERENCE');
      const resolved = resolveReference(child.attributes.source.path);
      if (!resolved || digest(resolved.type) !== digest(artifactTypes.blob)) fail('INVALID_AUTHOR_REFERENCE'); inputs[`file${index}`] = resolved.ref;
    } else {
      if (typeof child.attributes.src !== 'string' || typeof child.attributes['media-type'] !== 'string') fail('INVALID_AUTHOR_REFERENCE');
      const resolved = await resolveAsset({ from: child.attributes.src, mediaType: child.attributes['media-type'], range: child.range });
      const fileId = recordId(`file${index}`); records.push({ id: fileId, type: artifactTypes.blob, value: resolved.artifact, range: child.range }); inputs[`file${index}`] = { kind: 'record', id: fileId };
    }
  }
  for (const child of children.filter(node => local(node) === 'Output')) {
    exact(child.attributes, ['name', 'index']); if (child.children.some(node => node.kind === 'element' || node.value.trim())) fail('INVALID_AUTHOR_CHILD');
    const name = child.attributes.name, raw = child.attributes.index;
    if (typeof name !== 'string' || typeof raw !== 'string' || !/^(0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) fail('INVALID_OUTPUT_INDEX');
    const index = outputs.length; outputs.push({ name }); const indexId = recordId(`outputIndex${index}`);
    records.push({ id: indexId, type: workflowTypes.outputIndex, value: { kind: 'inline', value: Number(raw) }, range: child.range }); inputs[`outputIndex${index}`] = { kind: 'record', id: indexId };
  }
  const fragment = createOperationInputFragment(spec, files, outputs);
  return { records, fragments: [fragment], components: [{ id, fragment: fragment.id, inputs,
    outputs: Object.fromEntries(['result', ...outputs.map(item => item.name)].map(name => [name, `${id}.${name}`])), range: element.range }] };
}
