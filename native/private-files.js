import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { relativePath } from '../core/config.js';
import { fail } from '../core/errors.js';

export async function readPrivateJson(rootPath, path, maximum = 1_048_576, { ownerOnly = false, parse = JSON.parse } = {}) {
  const root = resolve(rootPath);
  if (await realpath(root) !== root) fail('UNSAFE_DATA_ROOT');
  let file = root;
  const parts = relativePath(path).split('/');
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || await realpath(file) !== file
      || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > maximum)) fail('UNSAFE_PRIVATE_FILE');
    // The project root may be shared Runtime/Profile state. Only the evidence leaf directory
    // and evidence file must be private; never chmod a caller's shared root.
    if (ownerOnly && index >= parts.length - 2
      && (stat.uid !== process.getuid() || (index === parts.length - 1
        ? ![0o400, 0o600].includes(stat.mode & 0o777) : (stat.mode & 0o777) !== 0o700))) fail('BINDING_PERMISSIONS_INVALID');
  }
  if (ownerOnly && parts.length < 2) fail('PRIVATE_BINDING_DIRECTORY_REQUIRED');
  const before = await lstat(file), handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size > maximum) fail('PRIVATE_FILE_CHANGED');
    if (ownerOnly && (stat.uid !== process.getuid() || ![0o400, 0o600].includes(stat.mode & 0o777))) fail('BINDING_PERMISSIONS_INVALID');
    const bytes = await handle.readFile();
    if (bytes.length > maximum) fail('PRIVATE_FILE_TOO_LARGE');
    try { return parse(bytes.toString('utf8')); } catch { fail('PRIVATE_JSON_INVALID'); }
  } finally { await handle.close(); }
}
