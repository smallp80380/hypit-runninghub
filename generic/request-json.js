import { fail } from '../core/errors.js';

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
