import { readFileSync } from 'node:fs';
import { createNativeModel } from '@local/provider-runninghub';
import { createExactModelPrimaryGenerationFragment, exactModelMediaInputNames } from '@hypit/hypit/model-kit';
import { sealGenerationRequestDraft, sealGenerationMediaBinding } from '@hypit/hypit/generation';
import { createMarkupSurfaceHostFacet } from '@hypit/hypit/author-kit';
import { artifactTypes } from '@hypit/hypit/artifact';

// The consuming project owns this descriptor and Model ABI. Every author
// attribute maps to one declared named port; no workflow/node IDs live here.
const descriptor = JSON.parse(readFileSync(new URL('./descriptor.json', import.meta.url)));
const graph = JSON.parse(readFileSync(new URL('./graph.json', import.meta.url)));
const definition = createNativeModel(descriptor, graph), endpoint = definition.endpoints.generation;
const ports = descriptor.portTable.ports;
if (ports.some(port => port.maxItems !== 1 || port.minItems !== 1 || port.name === 'id'
  || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(port.name))) throw Error('Scaffold requires unique identifier-named single required ports.');
const declaration = { name: 'workflow', tag: 'Workflow', mode: 'structured', outputs: [endpoint.draftType, ...Object.values(endpoint.mediaBindings).map(binding => binding.type)],
  vocabulary: { summary: 'Project-owned workflow with named media and scalar inputs.',
    attributes: [{ name: 'id', kind: 'identifier', required: true, summary: 'Result identifier.' }, ...ports.map(port => ({ name: port.name,
      kind: port.value.kind === 'media' ? 'reference' : 'string', required: true, summary: `Input for declared ${port.name} port.` }))],
    ports: [{ name: descriptor.portTable.result, type: artifactTypes.blob, summary: 'Generated primary artifact.' }],
    example: '<workflow:Workflow id="demo" prompt="inert prompt" image={referenceImage} audio={referenceAudio} seed="42" audioStart="0" duration="2"/>' } };
function scalar(port, raw) {
  if (typeof raw !== 'string') throw Error(`${port.name} requires a literal value.`);
  if (port.value.kind === 'number' || port.value.kind === 'enum' && typeof port.value.values[0] === 'number') {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw) || !Number.isFinite(Number(raw))) throw Error(`${port.name} requires a finite number.`);
    return Number(raw);
  }
  if (port.value.kind === 'boolean') { if (!['true', 'false'].includes(raw)) throw Error(`${port.name} requires true or false.`); return raw === 'true'; }
  return raw;
}
function handler({ element, resolveReference }) {
  const id = element.attributes.id;
  if (typeof id !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(id)) throw Error('Workflow id is required.');
  if (Object.keys(element.attributes).some(name => name !== 'id' && !ports.some(port => port.name === name))
    || element.children.some(child => child.kind === 'element' || child.value.trim())) throw Error('Unexpected workflow attribute or child.');
  const records = [], inputs = {}, media = [], draftPorts = {};
  for (const port of ports) {
    const raw = element.attributes[port.name];
    if (port.value.kind !== 'media') { draftPorts[port.name] = [scalar(port, raw)]; continue; }
    if (!raw || typeof raw !== 'object' || raw.kind !== 'reference') throw Error(`${port.name} requires an authored Blob reference.`);
    const resolved = resolveReference(raw.path);
    if (!resolved || resolved.type.module.name !== artifactTypes.blob.module.name || resolved.type.module.version !== artifactTypes.blob.module.version
      || resolved.type.name !== artifactTypes.blob.name) throw Error(`${port.name} must reference a Blob Artifact.`);
    const bindingId = `${id}.binding.${port.name}`, names = exactModelMediaInputNames(port.name);
    records.push({ id: bindingId, type: endpoint.mediaBindings[port.name].type,
      value: { kind: 'inline', value: sealGenerationMediaBinding(port, { role: port.value.accepts[0] }) }, range: element.range });
    inputs[names.binding] = { kind: 'record', id: bindingId }; inputs[names.artifact] = resolved.ref;
    media.push({ name: port.name, port: port.name });
  }
  records.push({ id: `${id}.draft`, type: endpoint.draftType,
    value: { kind: 'inline', value: sealGenerationRequestDraft(descriptor.portTable, draftPorts) }, range: element.range });
  inputs.draft = { kind: 'record', id: `${id}.draft` };
  const fragment = createExactModelPrimaryGenerationFragment(endpoint, media);
  return { records, fragments: [fragment], components: [{ id, fragment: fragment.id, inputs,
    outputs: { [descriptor.portTable.result]: `${id}.${descriptor.portTable.result}` }, range: element.range }] };
}
export default { format: 'hypit.node-package@1', modules: [{ manifest: definition.manifest }], components: [definition.component],
  hostFacets: [definition.hostFacet, createMarkupSurfaceHostFacet({ module: descriptor.capability.module, declaration, handler })] };
