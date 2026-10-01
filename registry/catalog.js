import { createHash } from 'node:crypto';
import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';

export const REGISTRY_SHA256 = '61b682b097fdf8766a70c774464b3682ca2494b0f2a0d8de105bd0a77c825a1a';
export const REVIEWED_SCHEMA_ENDPOINTS = Object.freeze(['rhart-image-v1/text-to-image', 'rhart-image-v1/edit',
  'rhart-video-v3.1-fast/text-to-video', 'rhart-video-v3.1-fast/image-to-video']);
const catalogs = new WeakSet();
export const isPinnedRegistry = value => value !== null && typeof value === 'object' && catalogs.has(value);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function exact(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) fail('REGISTRY_SCHEMA_UNREVIEWED');
}
function finite(value) { if (typeof value !== 'number' || !Number.isFinite(value)) fail('REGISTRY_SCHEMA_UNREVIEWED'); }

export function validateScalar(parameter, value) {
  if (parameter.type === 'STRING') {
    if (typeof value !== 'string' || !value || (parameter.maxLength !== undefined && value.length > parameter.maxLength)) fail('REGISTRY_SCALAR_INVALID');
  } else if (parameter.type === 'LIST') {
    if (!parameter.options.some(option => Object.is(option, value))) fail('REGISTRY_ENUM_INVALID');
  } else if (parameter.type === 'BOOLEAN') {
    if (typeof value !== 'boolean') fail('REGISTRY_SCALAR_INVALID');
  } else if (['INT', 'FLOAT'].includes(parameter.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || parameter.type === 'INT' && !Number.isSafeInteger(value)
      || parameter.min !== undefined && value < parameter.min || parameter.max !== undefined && value > parameter.max) fail('REGISTRY_NUMBER_INVALID');
    if (parameter.step !== undefined) {
      if (parameter.min === undefined) fail('REGISTRY_STEP_ORIGIN_UNREVIEWED');
      const n = (value - parameter.min) / parameter.step;
      if (Math.abs(n - Math.round(n)) > 1e-9) fail('REGISTRY_STEP_INVALID');
    }
  } else fail('REGISTRY_TYPE_UNREVIEWED');
}

export function normalizeParameter(raw) {
  const base = ['fieldKey', 'type', 'required', 'label', 'description', 'defaultValue'];
  const extras = { STRING: ['maxLength'], LIST: ['options'], BOOLEAN: [], INT: ['min', 'max', 'step'], FLOAT: ['min', 'max', 'step'], IMAGE: ['multipleInputs', 'maxInputNum', 'accept', 'maxSize'] }[raw?.type];
  if (!extras) fail('REGISTRY_TYPE_UNREVIEWED');
  exact(raw, [...base, ...extras]);
  if (typeof raw.fieldKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,199}$/.test(raw.fieldKey) || typeof raw.required !== 'boolean') fail('REGISTRY_SCHEMA_UNREVIEWED');
  const result = { fieldKey: raw.fieldKey, type: raw.type, required: raw.required };
  if (raw.type === 'STRING' && raw.maxLength !== undefined) {
    if (!Number.isSafeInteger(raw.maxLength) || raw.maxLength < 1) fail('REGISTRY_SCHEMA_UNREVIEWED'); result.maxLength = raw.maxLength;
  }
  if (raw.type === 'LIST') {
    if (!Array.isArray(raw.options) || !raw.options.length) fail('REGISTRY_SCHEMA_UNREVIEWED');
    result.options = raw.options.map(option => {
      exact(option, ['value', 'description', 'descriptionEn']);
      if (!['string', 'number'].includes(typeof option.value) || typeof option.value === 'number' && !Number.isFinite(option.value)) fail('REGISTRY_SCHEMA_UNREVIEWED');
      return option.value;
    });
    if (new Set(result.options).size !== result.options.length) fail('REGISTRY_SCHEMA_UNREVIEWED');
  }
  for (const field of ['min', 'max', 'step']) if (raw[field] !== undefined) { finite(raw[field]); result[field] = raw[field]; }
  if (result.min !== undefined && result.max !== undefined && result.min > result.max || result.step !== undefined && result.step <= 0) fail('REGISTRY_SCHEMA_UNREVIEWED');
  if (raw.type === 'IMAGE') {
    if (raw.defaultValue !== undefined || typeof raw.multipleInputs !== 'boolean' || !Number.isSafeInteger(raw.maxInputNum)
      || raw.maxInputNum < 1 || raw.maxInputNum > 9 || !raw.multipleInputs && raw.maxInputNum !== 1
      || typeof raw.maxSize !== 'number' || !Number.isFinite(raw.maxSize) || raw.maxSize <= 0) fail('REGISTRY_MEDIA_UNREVIEWED');
    let accept; try { accept = typeof raw.accept === 'string' ? JSON.parse(raw.accept) : raw.accept; } catch { fail('REGISTRY_MEDIA_UNREVIEWED'); }
    if (!Array.isArray(accept) || !accept.length || accept.some(v => !['JPG', 'JPEG', 'PNG', 'WEBP'].includes(v))) fail('REGISTRY_MEDIA_UNREVIEWED');
    result.media = { accepts: [...accept], maxInputs: raw.maxInputNum, multipleInputs: raw.multipleInputs,
      maxSize: raw.maxSize, maxSizeUnit: 'not-declared-by-pinned-registry' };
  } else if (Object.hasOwn(raw, 'defaultValue')) { validateScalar(result, raw.defaultValue); result.defaultValue = raw.defaultValue; }
  return freeze(result);
}

export function loadPinnedRegistry(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 10_485_760
    || createHash('sha256').update(bytes).digest('hex') !== REGISTRY_SHA256) fail('REGISTRY_PIN_MISMATCH');
  let registry; try { registry = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { fail('REGISTRY_JSON_INVALID'); }
  if (!Array.isArray(registry.models) || registry.model_count !== registry.models.length || registry.model_count !== 383) fail('REGISTRY_INDEX_INVALID');
  const models = new Map();
  for (const entry of registry.models) {
    // Discovery preserves literal registry entries, including single-segment
    // names and [Deprecated] labels. It never turns these into callable paths.
    if (typeof entry.endpoint !== 'string' || !entry.endpoint || entry.endpoint.length > 300
      || models.has(entry.endpoint) || !Array.isArray(entry.params)) fail('REGISTRY_INDEX_INVALID');
    models.set(entry.endpoint, freeze(entry));
  }
  const catalog = Object.freeze({ sha256: REGISTRY_SHA256, version: registry.version, modelCount: models.size,
    discover() { return [...models.values()].map(entry => ({ endpoint: entry.endpoint, outputType: entry.output_type,
      schemaReview: REVIEWED_SCHEMA_ENDPOINTS.includes(entry.endpoint) ? 'selected-schema-only' : 'unreviewed', execution: 'deferred-coins-only' })); },
    entry(endpoint) { const entry = models.get(endpoint); if (!entry) fail('REGISTRY_ENDPOINT_UNKNOWN'); return entry; },
    normalize(endpoint) {
      if (!REVIEWED_SCHEMA_ENDPOINTS.includes(endpoint)) fail('REGISTRY_MODEL_UNREVIEWED');
      const entry = models.get(endpoint); if (!entry) fail('REGISTRY_ENDPOINT_UNKNOWN');
      exact(entry, ['class_name', 'display_name', 'name_cn', 'name_en', 'endpoint', 'output_type', 'category', 'params']);
      if (!['image', 'video'].includes(entry.output_type)) fail('REGISTRY_RESULT_UNREVIEWED');
      const parameters = entry.params.map(normalizeParameter);
      if (new Set(parameters.map(p => p.fieldKey)).size !== parameters.length) fail('REGISTRY_FIELDS_DUPLICATED');
      return freeze({ endpoint, outputType: entry.output_type, entrySha256: digest(entry), registrySha256: REGISTRY_SHA256,
        parameters, execution: 'deferred-coins-only' });
    },
  });
  catalogs.add(catalog); return catalog;
}
