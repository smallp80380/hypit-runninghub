import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadPinnedRegistry, REVIEWED_SCHEMA_ENDPOINTS, REGISTRY_SHA256, normalizeParameter, validateScalar } from '../registry/catalog.js';
import { createRegistryDescriptor, validateRegistryDescriptor, planRegistryRequest } from '../registry/descriptor.js';
const bytes = await readFile(new URL('../sources/developer-kit/model-registry.public.json', import.meta.url));
const catalog = loadPinnedRegistry(bytes);
const capability = endpoint => ({ module: { name: '@example/runninghub-models', version: '1' }, name: endpoint.replaceAll('/', '-') });
const media = (id, mediaType = 'image/png') => ({ role: 'image', artifact: { kind: 'blob', resource: 'res_' + id, size: 100, mediaType } });
const scalarRequest = { ports: { prompt: ['offline prompt'], aspectRatio: ['9:16'] } };

test('full383 discovery is immutable metadata, including deprecated/single-segment entries, no execution', () => {
  assert.equal(catalog.discover().length, 383); assert.equal(catalog.sha256, REGISTRY_SHA256);
  assert.equal(catalog.discover().filter(e => e.schemaReview === 'selected-schema-only').length, 4);
  assert.ok(catalog.discover().every(e => e.execution === 'deferred-coins-only'));
  assert.ok(catalog.discover().some(e => e.endpoint.includes('[Deprecated]')));
  assert.ok(catalog.discover().some(e => e.endpoint === 'kling-elements'));
  assert.throws(() => { catalog.entry(REVIEWED_SCHEMA_ENDPOINTS[0]).params[0].fieldKey = 'invented'; }, TypeError);
  assert.throws(() => catalog.normalize('kling-elements'), { code: 'REGISTRY_MODEL_UNREVIEWED' });
});
test('modified/sample registry pin and fabricated catalog are rejected', () => {
  assert.throws(() => loadPinnedRegistry(Buffer.from('{}')), { code: 'REGISTRY_PIN_MISMATCH' });
  const modified = Buffer.concat([bytes, Buffer.from('\n')]);
  assert.throws(() => loadPinnedRegistry(modified), { code: 'REGISTRY_PIN_MISMATCH' });
  assert.throws(() => createRegistryDescriptor({ normalize() { return {}; } }, 'fake', capability('fake')), { code: 'PINNED_REGISTRY_REQUIRED' });
});
test('all four selected descriptors exactly match registry types/options/mappings; stage1 descriptor remains valid', async () => {
  for (const endpoint of REVIEWED_SCHEMA_ENDPOINTS) {
    const descriptor = createRegistryDescriptor(catalog, endpoint, capability(endpoint));
    assert.deepEqual(validateRegistryDescriptor(catalog, descriptor), descriptor);
    assert.equal(descriptor.fieldMappings.length, catalog.entry(endpoint).params.length);
    assert.equal(descriptor.execution, 'deferred-coins-only');
  }
  const stage1 = JSON.parse(await readFile(new URL('../examples/registry-image-model.json', import.meta.url)));
  assert.deepEqual(validateRegistryDescriptor(catalog, stage1), stage1);
});
test('STRING/defaultValue/LIST preserve exact wire types and explicit default policy', () => {
  const endpoint = 'rhart-video-v3.1-fast/text-to-video'; const d = createRegistryDescriptor(catalog, endpoint, capability(endpoint));
  const plan = planRegistryRequest(catalog, d, scalarRequest, { applyDefaults: true });
  assert.equal(plan.scalars.duration, '8'); assert.equal(plan.scalars.resolution, '720p');
  assert.equal(plan.scalars.prompt, 'offline prompt'); assert.ok(plan.blockers.includes('MODEL_EXECUTION_DISABLED_COINS_ONLY'));
  assert.throws(() => planRegistryRequest(catalog, d, { ports: { ...scalarRequest.ports, resolution: ['720p'], duration: [8] } }));
  assert.throws(() => planRegistryRequest(catalog, d, scalarRequest));
  assert.throws(() => planRegistryRequest(catalog, d, { ports: { prompt: ['x'.repeat(8001)], aspectRatio: ['9:16'], resolution: ['720p'] } }));
});
test('edit multiple media retains every ordered slot and rawmaxSize; unit remains an explicit blocker', () => {
  const endpoint = 'rhart-image-v1/edit'; const d = createRegistryDescriptor(catalog, endpoint, capability(endpoint), { imageUrls: 'referenceImages' });
  const request = { ports: { ...scalarRequest.ports, referenceImages: [media('a'), media('b', 'image/jpeg'), media('c')] } };
  const plan = planRegistryRequest(catalog, d, request);
  assert.deepEqual(plan.mediaSlots.map(slot => slot.artifact.resource), ['res_a', 'res_b', 'res_c']);
  assert.ok(plan.mediaSlots.every(slot => slot.fieldKey === 'imageUrls' && slot.mode === 'urlArray' && slot.maxSize === 10));
  assert.ok(plan.blockers.includes('MEDIA_SIZE_UNIT_REVIEW_REQUIRED'));
  assert.throws(() => planRegistryRequest(catalog, d, { ports: { ...request.ports, referenceImages: Array.from({ length: 6 }, (_, i) => media(i)) } }));
  assert.throws(() => planRegistryRequest(catalog, d, { ports: { ...request.ports, referenceImages: [media('bad', 'image/webp')] } }), { code: 'REGISTRY_MEDIA_FORMAT_INVALID' });
});
test('image-to-video imageUrls count3 and duration string8 are exact, not invented frame roles', () => {
  const endpoint = 'rhart-video-v3.1-fast/image-to-video'; const d = createRegistryDescriptor(catalog, endpoint, capability(endpoint));
  assert.equal(d.portTable.ports.find(p => p.name === 'imageUrls').maxItems, 3);
  assert.deepEqual(d.portTable.ports.find(p => p.name === 'duration').value.values, ['8']);
  const plan = planRegistryRequest(catalog, d, { ports: { ...scalarRequest.ports, imageUrls: [media('a')], resolution: ['1080p'] } });
  assert.equal(plan.mediaSlots[0].maxSize, 30);
  assert.throws(() => planRegistryRequest(catalog, d, { ports: { ...scalarRequest.ports, firstFrame: [media('a')], resolution: ['1080p'] } }));
});
test('unknown condition/shape fields, malformed accept/options and mismatched defaults are rejected', () => {
  const scalar = catalog.entry('rhart-image-v1/text-to-image').params[0];
  for (const field of ['conditional', 'tail_insert', 'maxSizeMB']) assert.throws(() => normalizeParameter({ ...scalar, [field]: true }), { code: 'REGISTRY_SCHEMA_UNREVIEWED' });
  const image = catalog.entry('rhart-image-v1/edit').params.find(p => p.type === 'IMAGE');
  assert.throws(() => normalizeParameter({ ...image, accept: 'notjson' }), { code: 'REGISTRY_MEDIA_UNREVIEWED' });
  const list = catalog.entry('rhart-image-v1/text-to-image').params[1];
  assert.throws(() => normalizeParameter({ ...list, options: ['auto'] }), { code: 'REGISTRY_SCHEMA_UNREVIEWED' });
  assert.throws(() => normalizeParameter({ ...list, defaultValue: 'invented' }), { code: 'REGISTRY_ENUM_INVALID' });
});
test('actual registry BOOLEAN/INT/FLOAT fields validate without coercion and preserve numeric limits', () => {
  const raw = JSON.parse(bytes);
  for (const type of ['BOOLEAN', 'INT', 'FLOAT']) {
    const parameter = raw.models.flatMap(m => m.params).find(p => p.type === type && Object.hasOwn(p, 'defaultValue') && (p.step === undefined || p.min !== undefined));
    const normalized = normalizeParameter(parameter); validateScalar(normalized, parameter.defaultValue);
    assert.throws(() => validateScalar(normalized, String(parameter.defaultValue)));
    if (type === 'INT') assert.throws(() => validateScalar(normalized, 0.5));
  }
});
test('descriptor drift, missing/duplicate mappings and unknown ports cannot fabricate a request', () => {
  const endpoint = 'rhart-image-v1/text-to-image'; const d = createRegistryDescriptor(catalog, endpoint, capability(endpoint));
  for (const edit of [x => { x.entrySha256 = 'a'.repeat(64); }, x => { x.fieldMappings.pop(); }, x => { x.fieldMappings[1].fieldKey = 'prompt'; }, x => { x.portTable.ports[0].value.maxChars = 99999; }]) {
    const changed = structuredClone(d); edit(changed); assert.throws(() => validateRegistryDescriptor(catalog, changed));
  }
  assert.throws(() => planRegistryRequest(catalog, d, { ports: { ...scalarRequest.ports, invented: ['x'] } }));
});
