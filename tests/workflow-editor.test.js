import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, symlink, link, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseDocument, importWorkflow, validateGraph, validateRevision, inspectWorkflow, editWorkflow, diffWorkflows,
  persistRevision, readHead, readDocument, writeNewDocument } from '../workflow/index.js';
const graph = { '1': { class_type: 'Text', inputs: { text: 'inert private text' } }, '2': { class_type: 'Sampler', inputs: { prompt: ['1', 0], seed: 1 } } };
const base = () => importWorkflow(graph), change = revision => editWorkflow(revision, [{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: 2 }], revision.revisionDigest);
const contracts = { Text: { inputs: { text: { kind: 'string', required: true } }, outputs: ['TEXT'] },
  Sampler: { inputs: { prompt: { kind: 'string', connectionType: 'TEXT', required: true }, seed: { kind: 'number', required: true } }, outputs: ['VIDEO'] } };
async function dir(t) { const p = await mkdtemp(join(tmpdir(), 'hypit-rh-editor-')); t.after(() => rm(p, { recursive: true, force: true })); return p; }

test('immutable import/edit/diff preserve original and redact literal contents', () => {
  const a = base(), b = change(a); assert.ok(Object.isFrozen(a.graph['2'].inputs)); assert.equal(a.graph['2'].inputs.seed, 1);
  assert.equal(b.graph['2'].inputs.seed, 2); assert.equal(b.parentDigest, a.revisionDigest);
  assert.equal(inspectWorkflow(a).links, 1); assert.equal(diffWorkflows(a, b).changes.length, 1);
  assert.ok(!JSON.stringify(inspectWorkflow(a)).includes('inert private text')); assert.equal(inspectWorkflow(b).semanticValidation, 'UNVERIFIED');
});
test('strict JSON refuses duplicate/dangerous keys, getters, sparse and non-JSON/deep data', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":{"__proto__":1}}', '{"a":{"constructor":2}}']) assert.throws(() => parseDocument(text));
  for (const value of [new Date(), Object.defineProperty({}, 'x', { get() { throw Error('must never run'); }, enumerable: true }), [ , 1], { a: Infinity }]) assert.throws(() => importWorkflow(value));
  assert.throws(() => parseDocument('['.repeat(70) + '0' + ']'.repeat(70)), { code: 'JSON_DEPTH_LIMIT' });
  assert.throws(() => parseDocument('"' + 'x'.repeat(4 * 1024 * 1024) + '"'), { code: 'JSON_SIZE_LIMIT' });
});
test('graph rejects malformed/missing references/cycles/literal arrays', () => {
  for (const link of [['missing', 0], ['1', -1], ['1', 1.5], [1, 2, 3]]) {
    const g = structuredClone(graph); g['2'].inputs.prompt = link; assert.throws(() => validateGraph(g), { code: 'GRAPH_REFERENCE_INVALID' });
  }
  const g = structuredClone(graph); g['1'].inputs.text = ['2', 0]; assert.throws(() => validateGraph(g), { code: 'GRAPH_CYCLE' });
});
test('typed literal edit, expected revision and unknown edit refusals are atomic', () => {
  const a = base();
  assert.throws(() => editWorkflow(a, [{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: '2' }], a.revisionDigest), { code: 'NODE_INPUT_TYPE_MISMATCH' });
  assert.throws(() => editWorkflow(a, [{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: 2 }], '0'.repeat(64)), { code: 'REVISION_CAS_CONFLICT' });
  assert.throws(() => editWorkflow(a, [{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: 2, ignored: true }], a.revisionDigest), { code: 'INVALID_EDIT' });
  assert.throws(() => editWorkflow(a, [null], a.revisionDigest), { code: 'INVALID_EDIT' }); assert.equal(a.graph['2'].inputs.seed, 1);
});
test('add/replace/remove/connect use complete atomic graph, referenced removals refused', () => {
  const a = base(); assert.throws(() => editWorkflow(a, [{ op: 'remove', nodeId: '1' }], a.revisionDigest), { code: 'GRAPH_REFERENCE_INVALID' });
  const b = editWorkflow(a, [{ op: 'add', nodeId: '3', node: { class_type: 'Text', inputs: { text: 'new' } } },
    { op: 'connect', nodeId: '2', fieldName: 'prompt', sourceNodeId: '3', outputIndex: 0 }, { op: 'remove', nodeId: '1' },
    { op: 'replace', nodeId: '3', node: { class_type: 'Text', inputs: { text: 'replacement' } } }], a.revisionDigest, contracts);
  assert.deepEqual(b.graph['2'].inputs.prompt, ['3', 0]); assert.equal(b.graph['1'], undefined); assert.equal(b.semanticValidation, 'UNVERIFIED');
});
test('explicit node contracts check required inputs/output bounds/types; unknowns stay UNVERIFIED', () => {
  const a = base();
  assert.throws(() => editWorkflow(a, [{ op: 'connect', nodeId: '2', fieldName: 'prompt', sourceNodeId: '1', outputIndex: 9 }], a.revisionDigest, contracts), { code: 'NODE_CONNECTION_TYPE_MISMATCH' });
  const wrong = structuredClone(contracts); wrong.Text.outputs = ['IMAGE'];
  assert.throws(() => editWorkflow(a, [{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: 2 }], a.revisionDigest, wrong), { code: 'NODE_CONNECTION_TYPE_MISMATCH' });
  const b = editWorkflow(a, [{ op: 'connect', nodeId: '2', fieldName: 'prompt', sourceNodeId: '1', outputIndex: 9 }], a.revisionDigest); assert.equal(b.semanticValidation, 'UNVERIFIED');
});
test('disconnect requires explicit contract/literal or declared optional removal; no defaults', () => {
  const a = base(); const op = { op: 'disconnect', nodeId: '2', fieldName: 'prompt', value: 'literal' };
  assert.throws(() => editWorkflow(a, [op], a.revisionDigest), { code: 'DISCONNECT_TYPE_CONTRACT_REQUIRED' });
  assert.equal(editWorkflow(a, [op], a.revisionDigest, contracts).graph['2'].inputs.prompt, 'literal');
  assert.throws(() => editWorkflow(a, [{ op: 'disconnect', nodeId: '2', fieldName: 'prompt', removeOptional: true }], a.revisionDigest, contracts), { code: 'OPTIONAL_INPUT_CONTRACT_REQUIRED' });
  const optional = structuredClone(contracts); optional.Sampler.inputs.prompt.required = false;
  assert.equal(editWorkflow(a, [{ op: 'disconnect', nodeId: '2', fieldName: 'prompt', removeOptional: true }], a.revisionDigest, optional).graph['2'].inputs.prompt, undefined);
});
test('revision content-addressed digest cannot be forged', () => {
  const a = structuredClone(base()); a.graph['2'].inputs.seed = 3; assert.throws(() => validateRevision(a), { code: 'REVISION_DIGEST_MISMATCH' });
});
test('CAS storage commits complete immutable revision; stale head cannot replace it', async t => {
  const p = await dir(t), a = base(), b = change(a); const first = await persistRevision(p, a, null);
  assert.equal(await readHead(p), a.revisionDigest); const before = await readFile(first.revisionFile);
  const second = await persistRevision(p, b, a.revisionDigest); assert.equal(await readHead(p), b.revisionDigest);
  assert.deepEqual(await readFile(first.revisionFile), before); assert.equal(validateRevision(await readDocument(second.revisionFile)).revisionDigest, b.revisionDigest);
  await assert.rejects(persistRevision(p, b, a.revisionDigest), { code: 'REVISION_CAS_CONFLICT' });
  assert.equal((await stat(first.revisionFile)).mode & 0o777, 0o600); assert.equal((await stat(join(p, '.rh-workflows'))).mode & 0o777, 0o700);
  assert.ok(!(await readdir(join(p, '.rh-workflows'))).some(n => n.startsWith('.incoming') || n.endsWith('.tmp')));
});
test('parallel starters have one CAS commit, crash lock is never force-cleared', async t => {
  const p = await dir(t), a = base(); const r = await Promise.allSettled([persistRevision(p, a, null), persistRevision(p, a, null)]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length, 1); assert.equal(await readHead(p), a.revisionDigest);
  await mkdir(join(p, '.rh-workflows/write.lock')); await assert.rejects(persistRevision(p, change(a), a.revisionDigest), { code: 'WORKFLOW_STORE_LOCKED' });
});
test('storage refuses symlinks/hardlinks and never overwrites explicit output', async t => {
  const p = await dir(t), file = join(p, 'original.json'); await writeNewDocument(file, base());
  await assert.rejects(writeNewDocument(file, change(base())), { code: 'OUTPUT_EXISTS' });
  await symlink(file, join(p, 'link.json')); await assert.rejects(readDocument(join(p, 'link.json')), { code: 'UNSAFE_WORKFLOW_FILE' });
  await link(file, join(p, 'hard.json')); await assert.rejects(readDocument(file), { code: 'UNSAFE_WORKFLOW_FILE' });
  const other = await dir(t); await symlink(other, join(p, '.rh-workflows')); await assert.rejects(persistRevision(p, base(), null), { code: 'UNSAFE_WORKFLOW_DIRECTORY' });
});
test('actual standalone Node CLI imports/applies/diffs/exports offline; fetch requires explicit config and output', async t => {
  const p = await dir(t), input = join(p, 'graph.json'), rev = join(p, 'revision.json'), out = join(p, 'changed.json'), ops = join(p, 'ops.json');
  await writeFile(input, JSON.stringify(graph)); await writeFile(ops, JSON.stringify([{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: 2 }]));
  let serial = 0;
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const run = async args => {
    const stdout = join(p, `stdout-${++serial}`), stderr = join(p, `stderr-${serial}`);
    try { await promisify(execFile)('/bin/sh', ['-c', [process.execPath, new URL('../bin/rh-workflow.js', import.meta.url).pathname, ...args].map(quote).join(' ') + ` >${quote(stdout)} 2>${quote(stderr)}`]); }
    catch (error) { error.stderr = await readFile(stderr, 'utf8'); throw error; }
    return { stdout: await readFile(stdout, 'utf8'), stderr: await readFile(stderr, 'utf8') };
  };
  await run(['import', '--input', input, '--output', rev]); const a = await readDocument(rev);
  await run(['apply', '--input', rev, '--operations', ops, '--expected-digest', a.revisionDigest, '--output', out]);
  const captured = await run(['inspect', '--input', out]); assert.notEqual(captured.stdout, '', JSON.stringify(captured)); const inspected = JSON.parse(captured.stdout); assert.equal(inspected.semanticValidation, 'UNVERIFIED');
  assert.equal(JSON.parse((await run(['diff', '--before', rev, '--after', out])).stdout).changes.length, 1);
  const exported = join(p, 'export.json'); await run(['export', '--input', out, '--output', exported]); assert.equal((await readDocument(exported))['2'].inputs.seed, 2);
  await assert.rejects(run(['fetch']), e => { assert.ok(e.stderr.includes('EXPLICIT_OUTPUT_REQUIRED')); return true; });
});

test('A→B→A preserves new revision ancestry and rejects stale ABA snapshot CAS', async t => {
  const p = await dir(t), a = base(), b = change(a);
  const c = editWorkflow(b, [{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: 1 }], b.revisionDigest);
  assert.equal(c.graphDigest.value, a.graphDigest.value); assert.notEqual(c.revisionDigest, a.revisionDigest);
  await persistRevision(p, a, null); await persistRevision(p, b, a.revisionDigest); const third = await persistRevision(p, c, b.revisionDigest);
  const saved = await readDocument(third.revisionFile); assert.equal(saved.parentDigest, b.revisionDigest); assert.equal(saved.revisionDigest, c.revisionDigest);
  assert.equal(await readHead(p), c.revisionDigest);
  await assert.rejects(persistRevision(p, b, a.revisionDigest), { code: 'REVISION_CAS_CONFLICT' });
});
test('canonical-equivalent key order shares content identity without false immutable conflicts', async t => {
  const p = await dir(t), a = base();
  const reordered = importWorkflow({ '2': { inputs: { seed: 1, prompt: ['1', 0] }, class_type: 'Sampler' }, '1': { inputs: { text: 'inert private text' }, class_type: 'Text' } });
  assert.equal(a.graphDigest.value, reordered.graphDigest.value); assert.equal(a.revisionDigest, reordered.revisionDigest);
  await persistRevision(p, a, null); const b = change(a); await persistRevision(p, b, a.revisionDigest);
  const c = importWorkflow(reordered.graph, { kind: 'local-edit', sourceDigest: b.graphDigest.value }, b.revisionDigest);
  const saved = await persistRevision(p, c, b.revisionDigest); assert.equal((await readDocument(saved.graphFile))['2'].inputs.seed, 1);
});

test('corrupted head/ancestry cannot commit or return a partial history', async t => {
  const p = await dir(t), a = base(), b = change(a);
  await assert.rejects(persistRevision(p, b, null), { code: 'REVISION_PARENT_MISMATCH' });
  const saved = await persistRevision(p, a, null); await writeFile(saved.revisionFile, '{}');
  await assert.rejects(readHead(p)); await assert.rejects(persistRevision(p, b, a.revisionDigest));
  assert.ok(!(await readdir(join(p, '.rh-workflows'))).includes('write.lock'));
});
