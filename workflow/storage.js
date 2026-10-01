import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, rename, unlink, rmdir, link } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from '../core/errors.js';
import { digest } from '../native/descriptor.js';
import { parseDocument, validateRevision, limits } from './revision.js';
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
async function stat(path) { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } }
async function rootDirectory(projectDirectory) {
  const root = resolve(projectDirectory);
  if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) fail('UNSAFE_WORKFLOW_DIRECTORY');
  const store = join(root, '.rh-workflows');
  try { await mkdir(store, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const s = await lstat(store);
  if (!s.isDirectory() || s.isSymbolicLink() || await realpath(store) !== store
    || s.uid !== process.getuid() || (s.mode & 0o777) !== 0o700) fail('UNSAFE_WORKFLOW_DIRECTORY');
  return store;
}
export async function readDocument(file) {
  const path = resolve(file);
  if (await realpath(path) !== path) fail('UNSAFE_WORKFLOW_FILE');
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > limits.bytes) fail('UNSAFE_WORKFLOW_FILE');
  const h = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await h.stat();
    if (current.ino !== before.ino || current.dev !== before.dev || current.size > limits.bytes) fail('WORKFLOW_FILE_CHANGED');
    const buffer = Buffer.alloc(limits.bytes + 1); let size = 0;
    while (size < buffer.length) { const { bytesRead } = await h.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
    if (size > limits.bytes) fail('JSON_SIZE_LIMIT');
    return parseDocument(buffer.subarray(0, size).toString('utf8'));
  } finally { await h.close(); }
}
async function syncDirectory(dir) { const h = await open(dir, 'r'); try { await h.sync(); } finally { await h.close(); } }
async function immutableFile(path, value) {
  const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > limits.bytes) fail('JSON_SIZE_LIMIT');
  if (await stat(path)) return false;
  const temp = join(resolve(path, '..'), `.incoming-${randomUUID()}`);
  const h = await open(temp, 'wx', 0o600);
  try {
    try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
    // link is atomic and refuses an existing target, unlike overwrite rename.
    try { await link(temp, path); }
    catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  } finally { await unlink(temp); }
  return true;
}
export async function readHead(projectDirectory) {
  const store = await rootDirectory(projectDirectory), head = join(store, 'head.json');
  if (!await stat(head)) return null;
  const value = await readDocument(head);
  if (!value || Object.keys(value).length !== 3 || value.format !== 'hypit-runninghub.head@1' || !hex(value.revisionDigest) || !hex(value.graphDigest)) fail('INVALID_WORKFLOW_HEAD');
  const revision = validateRevision(await readDocument(join(store, `${value.revisionDigest}.revision.json`)));
  if (revision.revisionDigest !== value.revisionDigest || revision.graphDigest.value !== value.graphDigest
    || digest(await readDocument(join(store, `${value.graphDigest}.graph.json`))) !== value.graphDigest) fail('INVALID_WORKFLOW_HEAD');
  return value.revisionDigest;
}
export async function persistRevision(projectDirectory, revision, expectedHeadDigest) {
  const checked = validateRevision(revision);
  if (expectedHeadDigest !== null && !hex(expectedHeadDigest)) fail('EXPECTED_HEAD_REQUIRED');
  const store = await rootDirectory(projectDirectory), lock = join(store, 'write.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) { if (error.code === 'EEXIST') fail('WORKFLOW_STORE_LOCKED'); throw error; }
  try {
    const current = await readHead(projectDirectory);
    if (current !== expectedHeadDigest) fail('REVISION_CAS_CONFLICT');
    if (checked.parentDigest !== current) fail('REVISION_PARENT_MISMATCH');
    const revisionFile = join(store, `${checked.revisionDigest}.revision.json`), graphFile = join(store, `${checked.graphDigest.value}.graph.json`);
    if (!await immutableFile(revisionFile, checked)) {
      const existing = validateRevision(await readDocument(revisionFile));
      if (existing.revisionDigest !== checked.revisionDigest) fail('IMMUTABLE_REVISION_CONFLICT');
    }
    if (!await immutableFile(graphFile, checked.graph)) {
      const existing = await readDocument(graphFile);
      if (digest(existing) !== checked.graphDigest.value) fail('IMMUTABLE_REVISION_CONFLICT');
    }
    const temp = join(store, `head.${randomUUID()}.tmp`), head = join(store, 'head.json');
    if (!await immutableFile(temp, { format: 'hypit-runninghub.head@1', revisionDigest: checked.revisionDigest, graphDigest: checked.graphDigest.value })) fail('OUTPUT_EXISTS');
    try {
      if (await stat(head)) await readDocument(head);
      await rename(temp, head); await syncDirectory(store);
    } finally { try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return { digest: checked.revisionDigest, graphDigest: checked.graphDigest.value, revisionFile, graphFile, semanticValidation: 'UNVERIFIED' };
  } finally { await rmdir(lock); }
}
export async function writeNewDocument(file, value) {
  const path = resolve(file), dir = resolve(path, '..');
  if (await realpath(dir) !== dir) fail('UNSAFE_WORKFLOW_DIRECTORY');
  if (await stat(path)) fail('OUTPUT_EXISTS');
  if (!await immutableFile(path, value)) fail('OUTPUT_EXISTS'); await syncDirectory(dir);
}
