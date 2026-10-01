import * as generation from '@hypit/hypit/generation';
import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { validateScalar, isPinnedRegistry } from './catalog.js';

export function createRegistryDescriptor(catalog, endpoint, capability, names = {}) {
  if (!isPinnedRegistry(catalog)) fail('PINNED_REGISTRY_REQUIRED');
  if (!capability || !capability.module || Object.keys(capability).some(k => !['module', 'name'].includes(k))
    || Object.keys(capability.module).some(k => !['name', 'version'].includes(k))
    || [capability.name, capability.module.name, capability.module.version].some(v => typeof v !== 'string' || !v || v.length > 200)) fail('REGISTRY_CAPABILITY_INVALID');
  const model = catalog.normalize(endpoint);
  const ports = model.parameters.map(p => {
    const value = p.type === 'IMAGE' ? { kind: 'media', accepts: ['image'] }
      : p.type === 'STRING' ? { kind: 'text', ...(p.maxLength === undefined ? {} : { maxChars: p.maxLength }) }
        : p.type === 'LIST' ? { kind: 'enum', values: [...p.options] }
          : p.type === 'BOOLEAN' ? { kind: 'boolean' }
            : { kind: 'number', integer: p.type === 'INT', ...(p.min === undefined ? {} : { minimum: p.min }), ...(p.max === undefined ? {} : { maximum: p.max }) };
    return { name: names[p.fieldKey] ?? p.fieldKey, minItems: p.required ? 1 : 0, maxItems: p.type === 'IMAGE' ? p.media.maxInputs : 1, value };
  });
  if (Object.keys(names).some(k => !model.parameters.some(p => p.fieldKey === k))) fail('REGISTRY_MAPPING_UNKNOWN');
  const descriptor = { schemaVersion: 'hypit-runninghub.model@1', execution: 'deferred-coins-only', registryEndpoint: endpoint,
    registrySha256: model.registrySha256, entrySha256: model.entrySha256, capability: structuredClone(capability),
    portTable: generation.sealGenerationPortTable({ model: capability.name, result: model.outputType, ports, requires: [] }),
    fieldMappings: model.parameters.map(p => ({ port: names[p.fieldKey] ?? p.fieldKey, fieldKey: p.fieldKey,
      mode: p.type === 'IMAGE' ? p.media.multipleInputs ? 'urlArray' : 'url' : 'scalar' })) };
  return descriptor;
}

export function validateRegistryDescriptor(catalog, descriptor) {
  const names = Object.fromEntries((descriptor.fieldMappings ?? []).map(mapping => [mapping.fieldKey, mapping.port]));
  const expected = createRegistryDescriptor(catalog, descriptor.registryEndpoint, descriptor.capability, names);
  if (digest(expected) !== digest(descriptor)) fail('REGISTRY_DESCRIPTOR_MISMATCH');
  return expected;
}

// Produces a transport-neutral offline mapping plan. It does not upload,
// resolve URLs, create tasks or claim that byte-size units are documented.
export function planRegistryRequest(catalog, descriptor, request, { applyDefaults = false } = {}) {
  validateRegistryDescriptor(catalog, descriptor);
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(k => k !== 'ports')
    || typeof applyDefaults !== 'boolean') fail('REGISTRY_REQUEST_INVALID');
  const model = catalog.normalize(descriptor.registryEndpoint);
  const ports = structuredClone(request?.ports ?? {});
  if (applyDefaults) for (const mapping of descriptor.fieldMappings) {
    const parameter = model.parameters.find(p => p.fieldKey === mapping.fieldKey);
    if (ports[mapping.port] === undefined && Object.hasOwn(parameter, 'defaultValue')) ports[mapping.port] = [parameter.defaultValue];
  }
  generation.verifyRequestAgainstPorts(descriptor.portTable, { ports });
  const scalars = {}, mediaSlots = [];
  const formats = { 'image/jpeg': ['JPG', 'JPEG'], 'image/png': ['PNG'], 'image/webp': ['WEBP'] };
  for (const mapping of descriptor.fieldMappings) {
    const parameter = model.parameters.find(p => p.fieldKey === mapping.fieldKey);
    const items = ports[mapping.port]; if (!items) continue;
    if (mapping.mode === 'scalar') { validateScalar(parameter, items[0]); scalars[mapping.fieldKey] = items[0]; }
    else for (const [index, item] of items.entries()) {
      if (!formats[item.artifact.mediaType]?.some(f => parameter.media.accepts.includes(f))) fail('REGISTRY_MEDIA_FORMAT_INVALID');
      mediaSlots.push({ fieldKey: mapping.fieldKey, port: mapping.port, index, mode: mapping.mode, artifact: item.artifact,
        maxSize: parameter.media.maxSize, maxSizeUnit: parameter.media.maxSizeUnit });
    }
  }
  return { endpoint: model.endpoint, execution: 'deferred-coins-only', scalars, mediaSlots,
    blockers: [...(mediaSlots.length ? ['MEDIA_SIZE_UNIT_REVIEW_REQUIRED', 'MEDIA_URL_RESOLUTION_NOT_IMPLEMENTED'] : []), 'MODEL_EXECUTION_DISABLED_COINS_ONLY'] };
}
