import { fail } from '../core/errors.js';
import { parseJson } from './request-json.js';

export function containsSecret(value, secrets) {
  // JSON primitives can carry the same credential text as strings. Use their
  // JSON spelling (including null and -0 -> 0), not coercion of whole records.
  const text = typeof value === 'string' ? value
    : value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
      ? JSON.stringify(value) : undefined;
  return text !== undefined
    && secrets.some(secret => typeof secret === 'string' && secret && text.includes(secret));
}

export function containsUrlSecret(value, secrets) {
  if (containsSecret(value, secrets)) return true;
  try { return containsSecret(decodeURIComponent(value), secrets); }
  catch { return true; }
}

function containsPayloadSecret(value, secrets) {
  if (containsSecret(value, secrets)) return true;
  // Array positions are structure, not upstream property names.
  if (Array.isArray(value)) return value.some(entry => containsPayloadSecret(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, entry]) => containsSecret(key, secrets) || containsPayloadSecret(entry, secrets));
  }
  return false;
}

export function secretFree(value, secrets, code) {
  if (containsPayloadSecret(value, secrets)) fail(code);
}

export function redactSecrets(value, secrets) {
  if (containsSecret(value, secrets)) return '[redacted]';
  if (Array.isArray(value)) return value.map(entry => redactSecrets(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !containsSecret(key, secrets))
      .map(([key, entry]) => [key, redactSecrets(entry, secrets)]));
  }
  return value;
}

export function metadata(value, secrets, depth = 0) {
  if (depth > 32) return undefined;
  if (containsSecret(value, secrets)) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return /https?:\/\//i.test(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(entry => metadata(entry, secrets, depth + 1)).filter(entry => entry !== undefined);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (containsSecret(key, secrets) || /https?:\/\//i.test(key)
        || /url|token|secret|credential|apikey|authorization|password/i.test(key)
        || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const safe = metadata(entry, secrets, depth + 1); if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
}

// Callers retain their exact validators and budgets. Only known structural
// property names and validated fixed protocol values are exempt here; an
// arbitrary payload object's keys are always inspected, even if named format.
function secretFreeInputs(nodes, secrets, code) {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (!['nodeId', 'fieldName', 'fieldValue'].includes(key)) secretFree(key, secrets, code);
      secretFree(value, secrets, code);
    }
  }
}

function secretFreeFiles(files, secrets, code) {
  for (const file of files) {
    for (const [key, value] of Object.entries(file)) {
      if (key === 'blob') {
        for (const [blobKey, blobValue] of Object.entries(value)) {
          if (!['kind', 'resource', 'size', 'mediaType'].includes(blobKey)) secretFree(blobKey, secrets, code);
          // SDK resource identity, byte length and nominal kind are structure,
          // not editable payload; resource contents are admitted before effects.
          if (!['kind', 'resource', 'size'].includes(blobKey)) secretFree(blobValue, secrets, code);
        }
      } else {
        if (key !== 'key') secretFree(key, secrets, code);
        secretFree(value, secrets, code);
      }
    }
  }
}

function secretFreeBindings(bindings, secrets, code) {
  for (const binding of bindings) {
    for (const [key, value] of Object.entries(binding)) {
      if (!['fileKey', 'nodeId', 'fieldName'].includes(key)) secretFree(key, secrets, code);
      secretFree(value, secrets, code);
    }
  }
}

function secretFreeGraph(graph, secrets, code) {
  for (const [nodeId, node] of Object.entries(graph)) {
    secretFree(nodeId, secrets, code);
    for (const [key, value] of Object.entries(node)) {
      if (key === '_meta' && value && typeof value === 'object' && !Array.isArray(value)) {
        for (const [metaKey, metaValue] of Object.entries(value)) {
          if (metaKey !== 'title') secretFree(metaKey, secrets, code);
          secretFree(metaValue, secrets, code);
        }
      } else {
        if (!['class_type', 'inputs'].includes(key)) secretFree(key, secrets, code);
        secretFree(value, secrets, code);
      }
    }
  }
}

function secretFreeInlineGraph(text, secrets, code) {
  // Already validated against the caller's budget. Do not impose the parser's
  // default budget a second time or scan serialized mandatory schema keys.
  secretFreeGraph(parseJson(text, Buffer.byteLength(text)), secrets, code);
}

export function secretFreeRequest(request, secrets, code) {
  for (const [key, value] of Object.entries(request)) {
    switch (key) {
      case 'format':
      case 'workflowId':
      case 'webappId':
      case 'instanceType':
        break;
      case 'workflowJson':
        if (value !== undefined) secretFreeInlineGraph(value, secrets, code);
        break;
      case 'nodeInfoList':
        secretFreeInputs(value, secrets, code);
        break;
      case 'files':
        secretFreeFiles(value, secrets, code);
        break;
      case 'bindings':
        secretFreeBindings(value, secrets, code);
        break;
      case 'review':
        secretFree(value, secrets, code);
        break;
      default:
        secretFree(key, secrets, code);
        secretFree(value, secrets, code);
    }
  }
}

// App origins, service IDs, digests and format are validated identity, not
// editable text. Node identifiers/type names are upstream-defined strings,
// unlike those fixed protocol literals: inspect their values along with all
// names, defaults, opaque fieldData and descriptions. Only record keys are
// exempt, so credential echoes in any retained literal field still fail.
export function appDocumentContainsSecret(document, secrets) {
  for (const [key, value] of Object.entries(document)) {
    switch (key) {
      case 'format':
      case 'baseUrl':
      case 'webappId':
      case 'appDigest':
      case 'accessEncrypted':
        break;
      case 'nodeInfoList':
        for (const node of value) {
          for (const [nodeKey, nodeValue] of Object.entries(node)) {
            if (!['nodeId', 'nodeName', 'fieldName', 'fieldValue', 'fieldData', 'fieldType', 'description', 'descriptionEn'].includes(nodeKey)
              && containsSecret(nodeKey, secrets)) return true;
            if (containsPayloadSecret(nodeValue, secrets)) return true;
          }
        }
        break;
      case 'webappName':
        if (containsPayloadSecret(value, secrets)) return true;
        break;
      default:
        if (containsSecret(key, secrets) || containsPayloadSecret(value, secrets)) return true;
    }
  }
  return false;
}

export function secretFreeSource(source, secrets, isApp, code) {
  if (isApp) {
    if (appDocumentContainsSecret(source, secrets)) fail(code);
  } else secretFreeGraph(source, secrets, code);
}

export function secretFreePreparedBody(body, secrets, isApp, code) {
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case 'workflowId':
        if (isApp) { secretFree(key, secrets, code); secretFree(value, secrets, code); }
        break;
      case 'webappId':
        if (!isApp) { secretFree(key, secrets, code); secretFree(value, secrets, code); }
        break;
      case 'instanceType':
        break;
      case 'nodeInfoList':
        secretFreeInputs(value, secrets, code);
        break;
      case 'workflow':
        if (isApp) { secretFree(key, secrets, code); secretFree(value, secrets, code); }
        else secretFreeInlineGraph(value, secrets, code);
        break;
      default:
        secretFree(key, secrets, code);
        secretFree(value, secrets, code);
    }
  }
}
