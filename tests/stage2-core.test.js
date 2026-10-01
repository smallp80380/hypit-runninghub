import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, mkdir, symlink, writeFile, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ProviderError } from '../core/errors.js';
import { serviceBase, accountObservation, validateCoreConfig } from '../core/config.js';
import { createExecutionCore } from '../core/index.js';
import { openJournal } from '../core/journal.js';
import { runJournaledAction } from '../core/submission-machine.js';
import { createJsonTransport, classifyResponse } from '../core/transport.js';
import { updatePollBudget } from '../core/poll-budget.js';

const config = JSON.parse(readFileSync(new URL('../examples/native-config.json', import.meta.url)));
const fingerprint = 'a'.repeat(64);
const policy = { maxAttempts: 3, initialDelayMs: 2000, maxDelayMs: 15000 };
const transient = () => new ProviderError('NETWORK_TRANSIENT', { category: 'transient', retryable: true });
function fakeClock() {
  let time = 0; const sleeps = [];
  return { now: () => time, sleeps, sleep: async ms => { sleeps.push(ms); time += ms; },
    timeout: () => ({ signal: new AbortController().signal, cancel() {} }) };
}
async function journalFixture(t, operation = 'op-1') {
  const root = await mkdtemp(join(tmpdir(), 'hypit-rh-core-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = await openJournal({ dataRoot: root, journalDirectory: 'provider/operations', instance: 'endpoint-1', operation });
  return { root, journal };
}
const run = (journal, invoke, options = {}) => runJournaledAction({ journal, invoke, fingerprint, policy, clock: fakeClock(), ...options });

test('Coins-only public core blocks true flag and every currently available account/evidence observation', async () => {
  for (const actualAccountApiType of [undefined, 'NORMAL', 'SHARED', 'MEMBER', 'invented']) {
    const c = structuredClone(config); c.submissionEnabled = true;
    c.liveBillingEvidence = { kind: 'private-file', path: 'evidence/claimed-guarantee.json' };
    let externalCalls = 0;
    const core = createExecutionCore({ config: c, fetch: () => { externalCalls++; } });
    await assert.rejects(core.start({ accountObservation: { actualAccountApiType, verified: true, coinsBalance: 9999 } }),
      { code: actualAccountApiType === 'SHARED' ? 'BILLING_MISMATCH' : 'COINS_ONLY_UNVERIFIED', retryable: false });
    assert.equal(externalCalls, 0);
  }
  await assert.rejects(createExecutionCore({ config }).start(), { code: 'SUBMISSION_DISABLED' });
});

test('actual apiType remains a bounded string, never declared Member from NORMAL', () => {
  assert.deepEqual(accountObservation({ code: 0, data: { apiType: 'NORMAL' } }), { actualAccountApiType: 'NORMAL', interpretation: 'unverified' });
  assert.equal(accountObservation({ code: 0, data: { apiType: 'SHARED' } }).interpretation, 'known-denial');
  for (const value of [7, '', 'secret https://signed.invalid/?token=private', 'X'.repeat(65)])
    assert.throws(() => accountObservation({ code: 0, data: { apiType: value } }), { code: 'ACCOUNT_TYPE_UNKNOWN' });
});

test('credentials only reach official exact origins; arbitrary HTTPS, credentials in URL and redirects fail', async () => {
  assert.equal(serviceBase('https://www.runninghub.ai', 'native-workflow'), 'https://www.runninghub.ai');
  assert.equal(serviceBase('https://www.runninghub.cn/openapi/v2', 'standard-model'), 'https://www.runninghub.cn/openapi/v2');
  for (const url of ['https://evil.invalid', 'https://www.runninghub.ai.evil.invalid', 'https://user:pass@www.runninghub.ai',
    'http://www.runninghub.ai', 'https://www.runninghub.ai:444', 'https://www.runninghub.ai/?foo=bar'])
    assert.throws(() => serviceBase(url, 'native-workflow'), { code: 'UNTRUSTED_SERVICE_BASE' });
  let observed;
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: config.family, fetch: async (url, init) => {
    observed = init; return new Response('{}', { status: 302 });
  }, clock: fakeClock(), timeoutMs: 1000, maxResponseBytes: 1024 });
  await assert.rejects(transport.request({ path: '/query', secret: 'mock-key', body: {} }), { code: 'HTTP_UNSUPPORTED_STATUS' });
  assert.equal(observed.redirect, 'error');
});

test('core validation refuses plaintext secrets, Coins-only bypass, mixed routes and unsafe paths', () => {
  assert.equal(validateCoreConfig(config).keyType, 'unknown');
  for (const mutate of [c => { c.apiKey = 'plaintext'; }, c => { c.billingExpectation.ledger = 'money'; },
    c => { c.actualAccountApiType = 'NORMAL'; }, c => { c.paths.journalDirectory = '../outside'; },
    c => { c.standard = {}; }, c => { c.retry.submit.maxAttempts = 4; }]) {
    const c = structuredClone(config); mutate(c); assert.throws(() => validateCoreConfig(c));
  }
});

test('submit transient retries exactly 3 total attempts with exponential backoff, then unknown is durable', async t => {
  const { journal } = await journalFixture(t); const clock = fakeClock(); let calls = 0;
  await assert.rejects(run(journal, async () => { calls++; throw transient(); }, { clock }), { code: 'NETWORK_TRANSIENT' });
  assert.equal(calls, 3); assert.deepEqual(clock.sleeps, [2000, 4000]);
  const state = await journal.read(); assert.equal(state.state, 'unknown'); assert.equal(state.attempts.length, 3);
  await assert.rejects(run(journal, async () => { calls++; }), { code: 'OUTCOME_UNKNOWN_NO_NEW_SERIES' }); assert.equal(calls, 3);
});

test('upload uses same 3-total policy and resume preserves uploaded result without new IO', async t => {
  const { journal } = await journalFixture(t); let calls = 0;
  const invoke = async () => { calls++; if (calls < 3) throw transient(); return { uploadResult: 'api/mock.png' }; };
  assert.equal((await run(journal, invoke, { action: 'upload' })).uploadResult, 'api/mock.png');
  assert.equal((await run(journal, invoke, { action: 'upload' })).resumed, true); assert.equal(calls, 3);
});

test('known deterministic and unknown business errors override HTTP 5xx transient classification', async t => {
  const { journal } = await journalFixture(t); let calls = 0;
  assert.equal(classifyResponse(500, { code: 416, msg: 'private upstream message' }).retryable, false);
  assert.equal(classifyResponse(503, { code: 98765 }).code, 'UPSTREAM_BUSINESS_UNKNOWN');
  assert.equal(classifyResponse(200, { code: 1005 }).retryable, true);
  assert.equal(classifyResponse(401, { code: 1005 }).retryable, false);
  assert.equal(classifyResponse(400, { code: 1005 }).retryable, false);
  await assert.rejects(run(journal, async () => { calls++; throw classifyResponse(500, { code: 416 }); }), { code: 'UPSTREAM_BUSINESS_ERROR' });
  assert.equal(calls, 1); assert.equal((await journal.read()).state, 'failed');
});

test('checkpoint failure resumes received taskId without another submit', async t => {
  const { journal } = await journalFixture(t); let calls = 0, receipts = [];
  await assert.rejects(run(journal, async () => { calls++; return { taskId: 'task-1' }; },
    { checkpoint: async () => { throw new Error('checkpoint disk failure'); } }), { code: 'CHECKPOINT_FAILED_RESUME' });
  assert.deepEqual((await journal.read()).taskIds, ['task-1']);
  const result = await run(journal, async () => { calls++; }, { checkpoint: async value => { receipts.push(value); } });
  assert.equal(calls, 1); assert.equal(result.resumed, true); assert.equal(receipts[0].receipt.taskId, 'task-1');
});

test('two parallel starters cannot submit the same operation twice', async t => {
  const { journal } = await journalFixture(t); let calls = 0, releaseCall, ready;
  const reached = new Promise(resolve => { ready = resolve; });
  const first = run(journal, async () => { calls++; ready(); return new Promise(resolve => { releaseCall = () => resolve({ taskId: 'task-1' }); }); });
  await reached;
  await assert.rejects(run(journal, async () => { calls++; return { taskId: 'task-2' }; }), { code: 'OPERATION_LOCKED' });
  releaseCall(); await first; assert.equal(calls, 1);
});

test('crash in-flight marker stops resume, and orphaned lock is never auto-cleared', async t => {
  const { journal } = await journalFixture(t);
  await journal.write({ version: 1, action: 'submit', fingerprint, state: 'in-flight', attempts: [{ attempt: 1, outcome: 'in-flight' }], taskIds: [] });
  let calls = 0;
  await assert.rejects(run(journal, async () => { calls++; }), { code: 'OUTCOME_UNKNOWN_NO_NEW_SERIES' });
  const release = await journal.acquire();
  await assert.rejects(run(journal, async () => { calls++; }), { code: 'OPERATION_LOCKED' });
  assert.equal(calls, 0); await release();
});

test('crash between attempts keeps spent budget and scheduled delay', async t => {
  const { journal } = await journalFixture(t); let calls = 0;
  const clock = fakeClock(); clock.sleep = async () => { throw new Error('simulated process shutdown'); };
  await assert.rejects(run(journal, async () => { calls++; throw transient(); }, { clock }), /simulated process shutdown/);
  assert.equal((await journal.read()).attempts.length, 1);
  const resumedClock = fakeClock();
  await assert.rejects(run(journal, async () => { calls++; throw transient(); }, { clock: resumedClock }), { code: 'NETWORK_TRANSIENT' });
  assert.equal(calls, 3); assert.equal((await journal.read()).attempts.length, 3); assert.deepEqual(resumedClock.sleeps, [2000, 4000]);
});

test('task IDs received with error are checkpointed, raw messages and signed URLs never journaled', async t => {
  const { journal } = await journalFixture(t); let calls = 0;
  const error = new ProviderError('UPSTREAM_TRANSIENT_ERROR', { category: 'transient', retryable: true, taskIds: ['task-123'] });
  error.message = 'mock-api-secret https://signed.invalid/output?token=secret';
  const result = await run(journal, async () => { calls++; throw error; });
  assert.equal(result.taskId, 'task-123'); assert.equal(calls, 1);
  const raw = JSON.stringify(await journal.read()); assert.equal(raw.includes('mock-api-secret'), false); assert.equal(raw.includes('signed.invalid'), false);
});

test('private journal rejects symlinks, hardlinks/oversize and writes restricted permissions', async t => {
  const { root, journal } = await journalFixture(t);
  await journal.write({ safe: true });
  assert.equal((await stat(journal.file)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'provider/operations'))).mode & 0o777, 0o700);
  await assert.rejects(journal.write({ oversized: 'x'.repeat(70_000) }), { code: 'JOURNAL_TOO_LARGE' });
  const outside = join(root, 'outside'); await mkdir(outside); await symlink(outside, join(root, 'linked'));
  await assert.rejects(openJournal({ dataRoot: root, journalDirectory: 'linked/child', instance: 'a', operation: 'b' }), { code: 'UNSAFE_JOURNAL_DIRECTORY' });
  const symlinkJournal = await openJournal({ dataRoot: root, journalDirectory: 'safe', instance: 'a', operation: 'b' });
  await writeFile(join(root, 'data'), '{}'); await symlink(join(root, 'data'), symlinkJournal.file);
  await assert.rejects(symlinkJournal.read(), { code: 'UNSAFE_JOURNAL_FILE' });
  const hardlinkJournal = await openJournal({ dataRoot: root, journalDirectory: 'other', instance: 'a', operation: 'b' });
  await link(join(root, 'data'), hardlinkJournal.file);
  await assert.rejects(hardlinkJournal.read(), { code: 'UNSAFE_JOURNAL_FILE' });
});

test('transport refuses oversized replies; empty/invalid JSON transient, auth and unknown business nonretry', async () => {
  const make = response => createJsonTransport({ baseUrl: config.baseUrl, family: config.family, fetch: async () => response,
    clock: fakeClock(), timeoutMs: 1000, maxResponseBytes: 100 });
  const request = transport => transport.request({ path: '/task/openapi/create', secret: 'inert-test-key', body: {} });
  await assert.rejects(request(make(new Response('x'.repeat(101)))), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(request(make(new Response(''))), { code: 'TRANSIENT_INVALID_JSON', retryable: true });
  await assert.rejects(request(make(new Response('bad'))), { code: 'TRANSIENT_INVALID_JSON', retryable: true });
  await assert.rejects(request(make(new Response('bad', { status: 401 }))), { code: 'HTTP_401', retryable: false });
  await assert.rejects(request(make(new Response('{"code":98765,"msg":"secret"}', { status: 503 }))), { code: 'UPSTREAM_BUSINESS_UNKNOWN', retryable: false });
});

test('request timeout remains bounded even when injected fetch ignores abort; timer is cancelled', async () => {
  const controller = new AbortController(); let cancelled = false;
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: config.family, fetch: () => new Promise(() => {}),
    clock: { timeout: () => ({ signal: controller.signal, cancel: () => { cancelled = true; } }) }, timeoutMs: 1, maxResponseBytes: 100 });
  const pending = transport.request({ path: '/query', secret: 'inert-key', body: {} }); controller.abort();
  await assert.rejects(pending, { code: 'NETWORK_TRANSIENT', retryable: true }); assert.equal(cancelled, true);
});

test('polling deadline and consecutive transient budget survive restart and preserve taskId', async t => {
  const { root } = await journalFixture(t);
  const journal = await openJournal({ dataRoot: root, journalDirectory: 'poll', instance: 'endpoint-1', operation: 'op-1' });
  const limits = { intervalMs: 5000, maxElapsedMs: 10000, maxConsecutiveTransientFailures: 2 };
  assert.equal((await updatePollBudget({ journal, taskId: 'task-1', now: 1000, limits })).wakeAt, 6000);
  await updatePollBudget({ journal, taskId: 'task-1', now: 2000, limits, event: 'transient-failure' });
  await assert.rejects(updatePollBudget({ journal, taskId: 'task-1', now: 3000, limits, event: 'transient-failure' }),
    error => error.code === 'POLL_FAILURE_LIMIT' && error.taskIds[0] === 'task-1');
  await updatePollBudget({ journal, taskId: 'task-1', now: 4000, limits, event: 'observed' });
  const restarted = await openJournal({ dataRoot: root, journalDirectory: 'poll', instance: 'endpoint-1', operation: 'op-1' });
  await assert.rejects(updatePollBudget({ journal: restarted, taskId: 'task-1', now: 11000, limits }),
    error => error.code === 'POLL_DEADLINE_EXCEEDED' && error.taskIds[0] === 'task-1');
  assert.equal((await restarted.read()).startedAt, 1000);
});

test('response stream reset retries at most3TOTAL and exhaustion cannot start another series', async t => {
  const { journal } = await journalFixture(t); let calls = 0;
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: config.family, clock: fakeClock(), timeoutMs: 1000,
    maxResponseBytes: 1024, fetch: async () => { calls++; return new Response(new ReadableStream({ start(c) { c.error(new TypeError('inert stream reset')); } })); } });
  const invoke = () => transport.request({ path: '/task/openapi/create', secret: 'inert', body: {} });
  await assert.rejects(run(journal, invoke), { code: 'NETWORK_TRANSIENT', retryable: true });
  assert.equal(calls, 3); assert.equal((await journal.read()).state, 'unknown');
  await assert.rejects(run(journal, invoke), { code: 'OUTCOME_UNKNOWN_NO_NEW_SERIES' }); assert.equal(calls, 3);
});

test('stream reset on deterministic HTTP and response size limits remain nonretry', async () => {
  for (const [response, code] of [[new Response(new ReadableStream({ start(c) { c.error(new TypeError('reset')); } }), { status: 401 }), 'HTTP_401'],
    [new Response('x'.repeat(101), { status: 503, headers: { 'content-length': '101' } }), 'RESPONSE_TOO_LARGE']]) {
    const transport = createJsonTransport({ baseUrl: config.baseUrl, family: config.family, clock: fakeClock(), timeoutMs: 1000,
      maxResponseBytes: 100, fetch: async () => response });
    await assert.rejects(transport.request({ path: '/task/openapi/create', secret: 'inert', body: {} }), { code, retryable: false });
  }
});

test('every ACK persistence failure retains known taskIDs and restart blocks submit', async t => {
  for (const branch of ['success', 'error-with-id']) {
    const { journal } = await journalFixture(t, branch); let writes = 0, calls = 0;
    const faulty = { ...journal, write: async state => { if (++writes === 2) throw new Error('inert private disk failure'); return journal.write(state); } };
    const invoke = async () => { calls++; if (branch === 'error-with-id') throw new ProviderError('UPSTREAM_TRANSIENT_ERROR',
      { retryable: true, category: 'transient', taskIds: ['offline-known-id'] }); return { taskId: 'offline-known-id' }; };
    await assert.rejects(run(faulty, invoke), error => {
      assert.equal(error.code, 'ACK_PERSISTENCE_FAILED'); assert.deepEqual(error.taskIds, ['offline-known-id']);
      assert.equal(error.retryable, false); assert.ok(!JSON.stringify(error).includes('disk failure')); return true;
    });
    assert.equal(calls, 1); assert.equal((await journal.read()).state, 'in-flight');
    await assert.rejects(run(journal, invoke), { code: 'OUTCOME_UNKNOWN_NO_NEW_SERIES' }); assert.equal(calls, 1);
  }
});

test('oversized stream stays deterministic when cancel rejects or hangs without timeout cooperation', { timeout: 1000 }, async () => {
  for (const cancel of [() => Promise.reject(new TypeError('inert cancel reset')), () => new Promise(() => {})]) {
    const transport = createJsonTransport({ baseUrl: config.baseUrl, family: config.family, clock: fakeClock(), timeoutMs: 1000,
      maxResponseBytes: 100, fetch: async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(101)); }, cancel })) });
    await assert.rejects(transport.request({ path: '/task/openapi/create', secret: 'inert', body: {} }),
      { code: 'RESPONSE_TOO_LARGE', retryable: false });
  }
});
