import { fail } from '../core/errors.js';
import { OFFICIAL_ORIGINS } from '../core/config.js';

export function parseRunningHubTarget(value, kind) {
  if (!['workflow', 'ai-app'].includes(kind) || typeof value !== 'string') fail('INVALID_SERVICE_TARGET');
  if (/^[0-9]{1,40}$/.test(value)) return { kind, id: value };
  // Check the authority literally too: URL normalizes explicit default ports.
  const authority = /^https:\/\/([^/?#]+)\//.exec(value)?.[1];
  if (!authority || authority.includes(':') || authority.includes('@') || value.includes('\\')) fail('INVALID_SERVICE_TARGET');
  let url;
  try { url = new URL(value); } catch { fail('INVALID_SERVICE_TARGET'); }
  if (!OFFICIAL_ORIGINS.includes(url.origin) || url.username || url.password || url.port) fail('INVALID_SERVICE_TARGET');
  const route = kind === 'workflow' ? 'post' : 'ai-detail';
  const rawPath = value.slice(value.indexOf('/', 8)).split(/[?#]/, 1)[0];
  const match = new RegExp(`^/${route}/([0-9]{1,40})/?$`).exec(rawPath);
  if (!match) fail('INVALID_SERVICE_TARGET');
  return { kind, id: match[1] };
}
