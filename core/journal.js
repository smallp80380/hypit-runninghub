import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, chmod, open, rename, unlink, rmdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fail } from './errors.js';
import { relativePath } from './config.js';

async function stat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
const digest = value => createHash('sha256').update(value).digest('hex');

export async function openJournal({ dataRoot, journalDirectory, instance, operation, maxBytes = 65_536 }) {
  if (typeof instance !== 'string' || !instance || instance.length > 200
    || typeof operation !== 'string' || !operation || operation.length > 200) fail('INVALID_OPERATION_ID');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 67_108_864) fail('INVALID_JOURNAL_LIMIT');
  const root = resolve(dataRoot);
  if ((await realpath(root)) !== root || (await lstat(root)).isSymbolicLink()) fail('UNSAFE_DATA_ROOT');
  const parts = relativePath(journalDirectory).split('/');
  let dir = root;
  for (const part of parts) {
    dir = join(dir, part);
    let s = await stat(dir);
    if (!s) { try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } s = await lstat(dir); }
    if (!s.isDirectory() || s.isSymbolicLink() || (await realpath(dir)) !== dir) fail('UNSAFE_JOURNAL_DIRECTORY');
    await chmod(dir, 0o700);
  }
  const identity = digest(JSON.stringify([instance, operation]));
  const file = join(dir, `${identity}.json`), lock = join(dir, `${identity}.lock`);
  async function checkFile() {
    const s = await stat(file);
    if (s && (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > maxBytes)) fail('UNSAFE_JOURNAL_FILE');
    return s;
  }
  return {
    file, lock, identity,
    async read() {
      const s = await checkFile(); if (!s) return undefined;
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const current = await handle.stat();
        if (current.ino !== s.ino || current.dev !== s.dev || current.size > maxBytes) fail('JOURNAL_CHANGED');
        await handle.chmod(0o600);
        const bytes = await handle.readFile(); if (bytes.length > maxBytes) fail('JOURNAL_TOO_LARGE');
        try { return JSON.parse(bytes.toString('utf8')); } catch { fail('JOURNAL_CORRUPT'); }
      } finally { await handle.close(); }
    },
    async write(record) {
      await checkFile();
      const bytes = Buffer.from(JSON.stringify(record)); if (bytes.length > maxBytes) fail('JOURNAL_TOO_LARGE');
      const temporary = join(dir, `${identity}.${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); }
      finally { await handle.close(); }
      try { await checkFile(); await rename(temporary, file); }
      finally { try { await unlink(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      const directoryHandle = await open(dir, 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    },
    async acquire() {
      try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') fail('OPERATION_LOCKED'); throw error;
      }
      let released = false;
      return async () => { if (!released) { await rmdir(lock); released = true; } };
    },
  };
}
