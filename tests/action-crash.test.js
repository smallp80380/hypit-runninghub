import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '../core/errors.js';
import { openJournal } from '../core/journal.js';
import { acknowledgedTaskId, acquirePreparation, runJournaledAction } from '../core/submission-machine.js';

const fingerprint = 'a'.repeat(64);
const policy = { maxAttempts: 3, initialDelayMs: 2, maxDelayMs: 10 };
const forbidden = async () => assert.fail('read-only recovery must not perform effects or preflight');
const clock = { now: () => 100, sleep: forbidden };
const run = (journal, options = {}) => runJournaledAction({ journal, fingerprint, policy, clock,
  invoke: forbidden, beforeAttempt: forbidden, ...options });
const ack = () => ({ version: 1, action: 'submit', fingerprint, state: 'acknowledged',
  taskIds: ['durable-task'], attempts: [{ attempt: 1, outcome: 'acknowledged' }] });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hypit-rh-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { dataRoot: root, instance: 'crash-endpoint', operation: 'crash-operation' };
  const preparation = await openJournal({ ...options, journalDirectory: 'preparation' });
  const submit = await openJournal({ ...options, journalDirectory: 'submit' });
  return { root, preparation, submit };
}
const withoutWrites = journal => ({ ...journal, write: forbidden });
const withoutLocks = journal => ({ ...withoutWrites(journal), acquire: forbidden });
async function snapshot(preparation, submit) {
  const files = await Promise.all([preparation.file, submit.file].map(file => readFile(file)));
  const locks = await Promise.all([preparation.lock, submit.lock].map(async lock => {
    const info = await stat(lock);
    assert.equal(info.isDirectory(), true);
    return { ino: info.ino, dev: info.dev, mode: info.mode, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs };
  }));
  return { files, locks };
}
function worker(mode, root) {
  const child = fork(new URL('./action-crash-worker.mjs', import.meta.url), [mode, root],
    { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const message = new Promise((resolve, reject) => {
    const prematureExit = (code, signal) => reject(new Error(`crash worker exited before IPC: ${code}/${signal}\n${stderr}`));
    child.once('exit', prematureExit);
    child.once('error', reject);
    child.once('message', value => { child.off('exit', prematureExit); resolve(value); });
  });
  return { child, exited, message, stderr: () => stderr };
}

// This leaf is imported by stage2-core.test.js; it also runs independently.
test('fresh-process SIGKILL after durable ACK recovers checkpoint without reclaiming either lock', { timeout: 20_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'hypit-rh-ack-crash-'));
  const children = [];
  t.after(async () => {
    for (const process of children) {
      if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGKILL');
      await process.exited;
    }
    await rm(root, { recursive: true, force: true });
  });
  const first = worker('first', root); children.push(first);
  assert.deepEqual(await first.message, { type: 'ready', taskId: 'durable-crash-task' });
  const options = { dataRoot: root, instance: 'crash-endpoint', operation: 'crash-operation' };
  const preparation = await openJournal({ ...options, journalDirectory: 'preparation' });
  const submit = await openJournal({ ...options, journalDirectory: 'submit' });
  const before = await snapshot(preparation, submit);
  assert.equal(acknowledgedTaskId(await submit.read(), fingerprint), 'durable-crash-task');
  assert.equal(first.child.kill('SIGKILL'), true);
  assert.deepEqual(await first.exited, { code: null, signal: 'SIGKILL' });
  const second = worker('second', root); children.push(second);
  const resumed = await second.message;
  assert.equal(resumed.type, 'resumed');
  const expected = { taskId: 'durable-crash-task', receipt: { taskId: 'durable-crash-task' }, resumed: true };
  assert.deepEqual(resumed.result, expected);
  assert.deepEqual(resumed.fallback, expected);
  assert.deepEqual(resumed.checkpoints, [
    { handle: { taskId: expected.taskId }, receipt: expected.receipt },
    { handle: { taskId: expected.taskId }, receipt: expected.receipt },
  ]);
  assert.deepEqual(await second.exited, { code: 0, signal: null }, second.stderr());
  assert.deepEqual(await snapshot(preparation, submit), before);
  await assert.rejects(preparation.acquire(), { code: 'OPERATION_LOCKED' });
  await assert.rejects(submit.acquire(), { code: 'OPERATION_LOCKED' });
});

test('durable ACK validation requires real contiguous attempts and permits transient ACKs without finish time', () => {
  const state = ack();
  assert.equal(acknowledgedTaskId(state, fingerprint), 'durable-task');
  state.taskIds.push('additional-task', 'third-task');
  state.attempts = [
    { attempt: 1, outcome: 'retryable', startedAt: 500, finishedAt: 1 },
    { attempt: 2, outcome: 'retryable' },
    { attempt: 3, outcome: 'acknowledged', startedAt: 0 },
  ];
  assert.equal(acknowledgedTaskId(state, fingerprint), 'durable-task');
  assert.equal(acknowledgedTaskId(state, 'b'.repeat(64)), undefined);
  state.attempts[2].finishedAt = Number.NaN;
  assert.equal(acknowledgedTaskId(state, fingerprint), undefined);
});

test('malformed, wrong-state, and upload ACKs cannot return a cached submit ID or start a new series', async t => {
  const { preparation, submit } = await fixture(t);
  await preparation.write({ version: 1, fingerprint, state: 'ready' });
  const malformed = [
    ['null', () => null], ['false', () => false], ['array', () => []],
    ['version', s => ({ ...s, version: 2 })], ['upload ACK', s => ({ ...s, action: 'upload' })],
    ...['prepared', 'retryable', 'in-flight', 'unknown', 'failed', 'completed'].map(state => [state, s => ({ ...s, state })]),
    ['identity', s => ({ ...s, fingerprint: 'b'.repeat(64) })],
    ['no IDs', s => ({ ...s, taskIds: [] })], ['duplicate IDs', s => ({ ...s, taskIds: ['durable-task', 'durable-task'] })],
    ['too many IDs', s => ({ ...s, taskIds: ['one', 'two', 'three', 'four'] })],
    ['invalid ID', s => ({ ...s, taskIds: ['https://private.invalid/task'] })],
    ['numeric ID', s => ({ ...s, taskIds: [1] })], ['missing IDs', s => { delete s.taskIds; return s; }],
    ['no attempts', s => ({ ...s, attempts: [] })], ['missing attempts', s => { delete s.attempts; return s; }],
    ['null attempt', s => ({ ...s, attempts: [null] })],
    ['missing actual attempt', s => ({ ...s, attempts: [{ outcome: 'acknowledged' }] })],
    ['first attempt is two', s => ({ ...s, attempts: [{ attempt: 2, outcome: 'acknowledged' }] })],
    ['last outcome retryable', s => ({ ...s, attempts: [{ attempt: 1, outcome: 'retryable' }] })],
    ['earlier ACK', s => ({ ...s, attempts: [{ attempt: 1, outcome: 'acknowledged' }, { attempt: 2, outcome: 'acknowledged' }] })],
    ['earlier unknown', s => ({ ...s, attempts: [{ attempt: 1, outcome: 'unknown' }, { attempt: 2, outcome: 'acknowledged' }] })],
    ['skipped attempt', s => ({ ...s, attempts: [{ attempt: 1, outcome: 'retryable' }, { attempt: 3, outcome: 'acknowledged' }] })],
    ['too many attempts', s => ({ ...s, attempts: [1, 2, 3, 4].map(attempt => ({ attempt, outcome: attempt === 4 ? 'acknowledged' : 'retryable' })) })],
    ['invalid start time', s => ({ ...s, attempts: [{ attempt: 1, outcome: 'acknowledged', startedAt: '100' }] })],
    ['invalid finish time', s => ({ ...s, attempts: [{ attempt: 1, outcome: 'acknowledged', finishedAt: null }] })],
    ['invalid retry time', s => ({ ...s, nextAttemptAt: '100' })],
  ];
  const preparationRelease = await preparation.acquire();
  try {
    for (const [name, mutate] of malformed) {
      const state = mutate(ack());
      assert.equal(acknowledgedTaskId(state, fingerprint), undefined, name);
      await submit.write(state);
      const before = await readFile(submit.file);
      await assert.rejects(run(withoutWrites(submit)), { code: 'JOURNAL_IDENTITY_MISMATCH' }, name);
      const submitRelease = await submit.acquire();
      try {
        await assert.rejects(acquirePreparation(preparation, submit, fingerprint), { code: 'OPERATION_LOCKED' }, name);
        await assert.rejects(run(withoutWrites(submit)), { code: 'OPERATION_LOCKED' }, name);
        await assert.rejects(run(withoutLocks(submit), { resumeOnly: true }), { code: 'JOURNAL_IDENTITY_MISMATCH' }, name);
        assert.deepEqual(await readFile(submit.file), before, name);
      } finally { await submitRelease(); }
    }
  } finally { await preparationRelease(); }
});

test('locked absent, in-flight, unknown, failed, and retryable records never authorize ACK recovery', async t => {
  const { preparation, submit } = await fixture(t);
  const preparationRelease = await preparation.acquire();
  const submitRelease = await submit.acquire();
  try {
    for (const state of [undefined, 'prepared', 'in-flight', 'unknown', 'failed', 'retryable']) {
      if (state !== undefined) await submit.write({ version: 1, action: 'submit', fingerprint, state, taskIds: [],
        attempts: state === 'prepared' ? [] : [{ attempt: 1, outcome: state }] });
      await assert.rejects(acquirePreparation(preparation, submit, fingerprint), { code: 'OPERATION_LOCKED' });
      await assert.rejects(run(withoutWrites(submit)), { code: 'OPERATION_LOCKED' });
      await assert.rejects(run(withoutLocks(submit), { resumeOnly: true }), { code: 'JOURNAL_IDENTITY_MISMATCH' });
    }
  } finally { await submitRelease(); await preparationRelease(); }
  for (const state of ['in-flight', 'unknown', 'failed']) {
    await submit.write({ version: 1, action: 'submit', fingerprint, state, taskIds: [], attempts: [{ attempt: 1, outcome: state }] });
    const before = await readFile(submit.file);
    await assert.rejects(run(withoutWrites(submit)), { code: 'OUTCOME_UNKNOWN_NO_NEW_SERIES' });
    assert.deepEqual(await readFile(submit.file), before);
  }
});


test('an active writer remains exclusive before ACK and permits read-only checkpoint recovery after durable ACK', async t => {
  const { preparation, submit } = await fixture(t);
  await preparation.write({ version: 1, fingerprint, state: 'ready' });
  const preparationRelease = await acquirePreparation(preparation, submit, fingerprint);
  let resolveInvoke, resolveCheckpoint, enteredInvoke, enteredCheckpoint;
  const invokeGate = new Promise(resolve => { resolveInvoke = resolve; });
  const checkpointGate = new Promise(resolve => { resolveCheckpoint = resolve; });
  const invoking = new Promise(resolve => { enteredInvoke = resolve; });
  const checkpointing = new Promise(resolve => { enteredCheckpoint = resolve; });
  const first = run(submit, {
    beforeAttempt: undefined,
    invoke: async () => { enteredInvoke(); await invokeGate; return { taskId: 'live-writer-task' }; },
    checkpoint: async () => { enteredCheckpoint(); await checkpointGate; },
  });
  try {
    await invoking;
    await assert.rejects(acquirePreparation(preparation, submit, fingerprint), { code: 'OPERATION_LOCKED' });
    await assert.rejects(run(withoutWrites(submit)), { code: 'OPERATION_LOCKED' });
    resolveInvoke();
    await checkpointing;
    const before = await snapshot(preparation, submit);
    assert.equal(await acquirePreparation(preparation, submit, fingerprint), undefined);
    const checkpoints = [];
    const checkpoint = async value => { checkpoints.push(value); };
    const resumed = await run(withoutWrites(submit), { checkpoint });
    assert.deepEqual(resumed, { taskId: 'live-writer-task', receipt: { taskId: 'live-writer-task' }, resumed: true });
    assert.deepEqual(await run(withoutLocks(submit), { checkpoint, resumeOnly: true }), resumed);
    assert.equal(checkpoints.length, 2);
    assert.deepEqual(await snapshot(preparation, submit), before);
  } finally {
    resolveInvoke(); resolveCheckpoint();
    assert.equal((await first).resumed, false);
    await preparationRelease();
  }
});

test('received transient ACKs preserve checkpoint failures, first-attempt resumed flags, and read-only receipts', async t => {
  const { preparation, submit } = await fixture(t);
  await preparation.write({ version: 1, fingerprint, state: 'ready' });
  let calls = 0;
  const invoke = async () => { calls++; throw new ProviderError('UPSTREAM_TRANSIENT_ERROR',
    { retryable: true, category: 'transient', taskIds: ['transient-ack', 'second-ack'] }); };
  const checkpoints = [];
  const first = await run(submit, { invoke, beforeAttempt: undefined, checkpoint: async value => { checkpoints.push(value); } });
  assert.deepEqual(first, { taskId: 'transient-ack', receipt: { taskId: 'transient-ack' }, resumed: false });
  assert.equal(calls, 1);
  const persisted = await submit.read();
  assert.equal(persisted.attempts[0].finishedAt, undefined);
  assert.equal(acknowledgedTaskId(persisted, fingerprint), 'transient-ack');
  const preparationRelease = await preparation.acquire();
  const submitRelease = await submit.acquire();
  try {
    const before = await snapshot(preparation, submit);
    for (const resumeOnly of [false, true]) {
      await assert.rejects(run(resumeOnly ? withoutLocks(submit) : withoutWrites(submit), { resumeOnly,
        checkpoint: async () => { throw new Error('inert checkpoint failure'); } }),
      error => error.code === 'CHECKPOINT_FAILED_RESUME' && error.taskIds.length === 1 && error.taskIds[0] === 'transient-ack');
      const recovered = await run(resumeOnly ? withoutLocks(submit) : withoutWrites(submit), { resumeOnly,
        checkpoint: async value => { checkpoints.push(value); } });
      assert.deepEqual(recovered, { ...first, resumed: true });
      assert.deepEqual(await snapshot(preparation, submit), before);
    }
    assert.equal(checkpoints.length, 3);
    assert.equal(calls, 1);
  } finally { await submitRelease(); await preparationRelease(); }
});

test('upload caches are schema-checked and resumeOnly never accepts an upload action', async t => {
  const { submit } = await fixture(t);
  await submit.write({ version: 1, action: 'upload', fingerprint, state: 'completed', taskIds: [],
    attempts: [{ attempt: 2, outcome: 'completed' }], uploadResult: 'inert/upload.png' });
  await assert.rejects(run(withoutWrites(submit), { action: 'upload' }), { code: 'JOURNAL_IDENTITY_MISMATCH' });
  await assert.rejects(run(withoutLocks(submit), { action: 'upload', resumeOnly: true }), { code: 'INVALID_ACTION' });
  const release = await submit.acquire();
  try {
    await submit.write({ ...ack(), action: 'upload' });
    await assert.rejects(run(withoutWrites(submit), { action: 'upload' }), { code: 'OPERATION_LOCKED' });
    await assert.rejects(run(withoutWrites(submit)), { code: 'OPERATION_LOCKED' });
  } finally { await release(); }
});

test('corrupt JSON cannot bypass a retained lock or fall back to a fresh submit series', async t => {
  const { preparation, submit } = await fixture(t);
  await writeFile(submit.file, '{"broken":', { mode: 0o600 });
  const before = await readFile(submit.file);
  await assert.rejects(run(withoutWrites(submit)), { code: 'JOURNAL_CORRUPT' });
  const preparationRelease = await preparation.acquire();
  const submitRelease = await submit.acquire();
  try {
    await assert.rejects(acquirePreparation(preparation, submit, fingerprint), { code: 'JOURNAL_CORRUPT' });
    await assert.rejects(run(withoutWrites(submit)), { code: 'JOURNAL_CORRUPT' });
    await assert.rejects(run(withoutLocks(submit), { resumeOnly: true }), { code: 'JOURNAL_CORRUPT' });
    assert.deepEqual(await readFile(submit.file), before);
  } finally { await submitRelease(); await preparationRelease(); }
});

test('preparation recovery does not grant effect permission and resumeOnly revalidates the current ACK', async t => {
  const { preparation, submit } = await fixture(t);
  await submit.write(ack());
  // An unlocked preparation still takes its normal lock, even with a saved ACK.
  const preparationRelease = await acquirePreparation(preparation, submit, fingerprint);
  assert.equal(typeof preparationRelease, 'function');
  const submitRelease = await submit.acquire();
  try {
    assert.equal(await acquirePreparation(preparation, submit, fingerprint), undefined);
    await submit.write({ ...ack(), state: 'unknown' });
    const before = await readFile(submit.file);
    await assert.rejects(run(withoutLocks(submit), { resumeOnly: true }), { code: 'JOURNAL_IDENTITY_MISMATCH' });
    await assert.rejects(run(withoutWrites(submit)), { code: 'OPERATION_LOCKED' });
    assert.deepEqual(await readFile(submit.file), before);
    await submit.write(ack());
    await assert.rejects(acquirePreparation({ ...preparation, acquire: async () => {
      throw new ProviderError('UNSAFE_JOURNAL_DIRECTORY');
    } }, { ...submit, read: forbidden }, fingerprint), { code: 'UNSAFE_JOURNAL_DIRECTORY' });
  } finally { await submitRelease(); await preparationRelease(); }
});
