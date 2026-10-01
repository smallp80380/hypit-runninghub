import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod, symlink, link, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@hypit/hypit/generation';
import { createNativeProvider } from '../native/provider.js';
import { loadReviewedMemberAuthority, MEMBER_CONTRACT_SHA256, credentialSha256 } from '../native/member-binding.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { digest } from '../native/descriptor.js';
import { openJournal } from '../core/journal.js';
const load = async name => JSON.parse(await readFile(new URL('../examples/' + name, import.meta.url)));
const config = await load('native-config.json');
const descriptor = await load('native-workflow.json'); descriptor.fixtureOnly = false;
const graph = await load('mock-native-graph.json');
const inertSecret = 'offline-never-live-membership-fixture';
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function testClock() { let time = 1000; return { now: () => time, advance: ms => { time += ms; }, sleep: async ms => { time += ms; },
  timeout: () => ({ signal: new AbortController().signal, cancel() {} }) }; }
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hypit-rh-member-')); t.after(() => rm(root, { recursive: true, force: true }));
  const hostStateRoot = join(root, 'host'), dataRoot = join(root, 'data');
  await mkdir(hostStateRoot, { mode: 0o755 }); await mkdir(dataRoot, { mode: 0o700 });
  await mkdir(join(dataRoot, 'evidence'), { mode: 0o700 });
  const c = structuredClone(config); c.submissionEnabled = true; c.keyType = 'Consumer-Member';
  c.liveBillingEvidence = { kind: 'private-file', path: 'evidence/member-binding.json' };
  const record = { format: 'REVIEWED_MEMBER_BINDING@1', family: 'native-workflow', baseUrl: c.baseUrl,
    credential: { reference: c.apiKey, sha256: credentialSha256(inertSecret) },
    workflow: { workflowId: descriptor.workflowId, graphDigest: descriptor.graphDigest.value, descriptorDigest: digest(descriptor), scope: 'reviewed-native-only-no-external-money' },
    source: { url: MEMBERSHIP_SOURCE, noteSha256: MEMBER_CONTRACT_SHA256 },
    humanReview: { kind: 'project-owner-reviewed-membership-key-and-native-workflow', reviewer: 'offline-test-owner', recordId: 'test-review-only', reviewedAt: new Date(0).toISOString() },
    expiresAt: new Date(86_400_000).toISOString() };
  const file = join(dataRoot, c.liveBillingEvidence.path);
  const save = async () => writeFile(file, JSON.stringify(record), { mode: 0o600 }); await save();
  const calls = []; let creates = 0, uploads = 0;
  const clock = testClock();
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/accountStatus')) {
      if (options.account) return options.account({ url, init, calls, clock });
      return json({ code: 0, data: { apiType: 'NORMAL', remainCoins: '30000' } });
    }
    if (url.endsWith('/getJsonApiFormat')) {
      if (options.graph) return options.graph({ calls, clock });
      return json({ code: 0, data: { prompt: JSON.stringify(graph) } });
    }
    if (url.endsWith('/upload')) return json({ code: 0, data: { fileName: `input/mock-${++uploads}.png`, fileType: 'input' } });
    if (url.endsWith('/create')) {
      creates++;
      if (options.create) return options.create({ creates, clock });
      return json({ code: 0, data: { taskId: 'offline-member-task' } });
    }
    throw new Error('Unexpected offline request');
  };
  const artifact = id => ({ kind: 'blob', resource: 'res_' + id, mediaType: 'image/png', size: 3 });
  const ctx = { operation: 'offline-member-op', credentials: { apiKey: { secret: inertSecret } },
    need: { capability: descriptor.capability, returns: sdk.generationTypes.videoSet,
      constraints: { ports: { prompt: ['fixture'], referenceImage: [{ role: 'image', artifact: artifact('a') }, { role: 'image', artifact: artifact('b') }] } } },
    resources: { get: async () => new Uint8Array([1, 2, 3]) } };
  const base = { config: c, descriptor, graph, dataRoot, hostStateRoot, instance: 'member.fixture', pool: 'member.offline', fetch, clock };
  const activate = async () => {
    const memberAuthority = await loadReviewedMemberAuthority(base);
    const provider = createNativeProvider({ ...base, memberAuthority }); let endpoint, registration;
    provider.install({ registerAsyncEndpoint(instance, capability, returns, value, options) { endpoint = value; registration = options; } });
    return { endpoint, registration, provider, memberAuthority };
  };
  return { ...base, root, calls, record, file, save, ctx, activate };
}
const uploads = calls => calls.filter(c => c.url.endsWith('/upload'));
const creates = calls => calls.filter(c => c.url.endsWith('/create'));

test('reviewed private binding enables public mock start subject to same-secret account preflight', async t => {
  const f = await fixture(t); const { endpoint, registration } = await f.activate();
  assert.equal(registration.supports(f.ctx.need).status, 'supported'); assert.equal(f.calls.length, 0);
  const result = await endpoint.start(f.ctx); assert.equal(result.status, 'pending'); assert.equal(result.receipt.id, 'offline-member-task');
  const accounts = f.calls.filter(c => c.url.endsWith('/accountStatus')); assert.equal(accounts.length, 2);
  for (const account of accounts) { assert.deepEqual(JSON.parse(account.init.body), { apikey: inertSecret }); assert.equal(account.init.headers.authorization, 'Bearer ' + inertSecret); }
  assert.equal(uploads(f.calls).length, 2); assert.equal(creates(f.calls).length, 1);
  assert.ok(!JSON.stringify(result).includes(inertSecret)); assert.ok(!JSON.stringify(result).includes(f.record.credential.sha256));
});

test('disabled flag and forged authority block before credential resolution or IO', async t => {
  const f = await fixture(t); const { memberAuthority } = await f.activate();
  for (const [enabled, authority, code] of [[false, memberAuthority, 'SUBMISSION_DISABLED'], [true, { checkStatic() {}, preflight() {} }, 'COINS_ONLY_UNVERIFIED']]) {
    let endpoint; const c = structuredClone(f.config); c.submissionEnabled = enabled;
    createNativeProvider({ ...f, config: c, memberAuthority: authority }).install({ registerAsyncEndpoint(i, cap, ret, value) { endpoint = value; } });
    const result = await endpoint.start({ get credentials() { throw new Error('must not resolve'); } });
    assert.equal(result.failure.code, code); assert.equal(f.calls.length, 0);
  }
});

test('binding source, review, scope, refs, fixture and Model family cannot be replaced by verified flags', async t => {
  const edits = [r => { r.verified = true; }, r => { r.source.url = 'https://other.invalid'; }, r => { r.source.noteSha256 = 'a'.repeat(64); },
    r => { r.credential.reference = { store: 'other', key: 'other' }; }, r => { r.baseUrl = 'https://www.runninghub.cn'; },
    r => { r.family = 'standard-model'; }, r => { r.workflow.workflowId = '123'; }, r => { r.workflow.graphDigest = 'b'.repeat(64); },
    r => { r.workflow.descriptorDigest = 'b'.repeat(64); }, r => { r.workflow.scope = 'any-workflow'; }, r => { delete r.humanReview; }];
  for (const edit of edits) {
    const f = await fixture(t); edit(f.record); await f.save(); await assert.rejects(f.activate()); assert.equal(f.calls.length, 0);
  }
  const f = await fixture(t); const d = structuredClone(descriptor); d.fixtureOnly = true;
  f.record.workflow.descriptorDigest = digest(d); await f.save();
  await assert.rejects(loadReviewedMemberAuthority({ ...f, descriptor: d }), { code: 'MEMBER_BINDING_FIXTURE_FORBIDDEN' });
});

test('rotation, expiry and revoked binding stop before account or media transfer', async t => {
  for (const mode of ['rotated', 'expired', 'revoked']) {
    const f = await fixture(t); const { endpoint, registration } = await f.activate();
    if (mode === 'rotated') f.ctx.credentials.apiKey.secret = 'another-inert-secret';
    if (mode === 'expired') f.clock.advance(86_400_000);
    if (mode === 'revoked') await rm(f.file);
    if (mode === 'expired') assert.equal(registration.supports(f.ctx.need).status, 'unsupported');
    const outcome = await endpoint.start(f.ctx); assert.equal(outcome.status, 'failed'); assert.equal(f.calls.length, 0);
  }
});

test('SHARED/unknown account types and unusable Coins block before graph/upload/create', async t => {
  for (const [apiType, remainCoins] of [['SHARED', '30000'], ['MEMBER', '30000'], ['unknown', '30000'], ['NORMAL', '0'], ['NORMAL', null], ['NORMAL', 'bad']]) {
    const f = await fixture(t, { account: () => json({ code: 0, data: { apiType, remainCoins } }) }); const { endpoint } = await f.activate();
    const result = await endpoint.start(f.ctx); assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1);
    assert.equal(uploads(f.calls).length, 0); assert.equal(creates(f.calls).length, 0);
  }
});

test('private evidence enforces file/leaf permissions, link safety and bounded size', async t => {
  for (const mode of ['file-mode', 'leaf-mode', 'symlink', 'hardlink', 'size']) {
    const f = await fixture(t);
    if (mode === 'file-mode') await chmod(f.file, 0o644);
    if (mode === 'leaf-mode') await chmod(join(f.dataRoot, 'evidence'), 0o755);
    if (mode === 'symlink') { const target = join(f.dataRoot, 'original.json'); await writeFile(target, JSON.stringify(f.record), { mode: 0o600 }); await rm(f.file); await symlink(target, f.file); }
    if (mode === 'hardlink') await link(f.file, join(f.dataRoot, 'linked.json'));
    if (mode === 'size') await writeFile(f.file, ' '.repeat(8193));
    await assert.rejects(f.activate()); assert.equal(f.calls.length, 0);
  }
});

test('paid transient retry gets fresh admission without resetting three-total budget', async t => {
  const f = await fixture(t, { create: ({ creates }) => creates < 3 ? new Response('', { status: 503 }) : json({ code: 0, data: { taskId: 'offline-member-task' } }) });
  const { endpoint } = await f.activate(); assert.equal((await endpoint.start(f.ctx)).status, 'pending');
  assert.equal(creates(f.calls).length, 3); assert.equal(uploads(f.calls).length, 2);
  assert.equal(f.calls.filter(c => c.url.endsWith('/accountStatus')).length, 4);
});

test('account error between paid attempts stops outside retry budget; acknowledged resume skips fresh calls', async t => {
  let accounts = 0;
  const f = await fixture(t, { account: () => ++accounts > 2 ? new Response('', { status: 503 }) : json({ code: 0, data: { apiType: 'NORMAL', remainCoins: '30000' } }),
    create: () => new Response('', { status: 503 }) });
  const { endpoint } = await f.activate(); assert.equal((await endpoint.start(f.ctx)).status, 'failed'); assert.equal(creates(f.calls).length, 1);
  const state = await (await openJournal({ dataRoot: f.dataRoot, instance: f.instance, operation: f.ctx.operation, journalDirectory: f.config.paths.journalDirectory })).read();
  assert.equal(state.attempts.length, 1); assert.equal(state.state, 'retryable'); assert.ok(state.preflightFailure);
  const success = await fixture(t); const good = await success.activate(); success.ctx.checkpoint = async () => { throw Error('offline checkpoint'); };
  const checkpointFailure = await good.endpoint.start(success.ctx);
  assert.equal(checkpointFailure.failure.code, 'CHECKPOINT_FAILED_RESUME'); assert.equal(checkpointFailure.receipt.id, 'offline-member-task');
  const count = success.calls.length; success.ctx.checkpoint = async () => {}; await rm(success.file);
  assert.equal((await good.endpoint.start(success.ctx)).status, 'pending'); assert.equal(success.calls.length, count);
});

test('changed graph and stale account observation cannot reach upload/create', async t => {
  for (const mode of ['changed', 'slow']) {
    const f = await fixture(t, { graph: ({ clock }) => { if (mode === 'slow') clock.advance(61_000);
      return json({ code: 0, data: { prompt: JSON.stringify(mode === 'changed' ? {} : graph) } }); } });
    const { endpoint } = await f.activate(); const result = await endpoint.start(f.ctx); assert.equal(result.status, 'failed');
    assert.equal(uploads(f.calls).length, 0); assert.equal(creates(f.calls).length, 0);
  }
});

test('project dataRoot owns evidence; machine hostStateRoot stays untouched and owner read-only file is accepted', async t => {
  const f = await fixture(t); const before = (await stat(f.hostStateRoot)).mode;
  await chmod(f.file, 0o400);
  const { endpoint } = await f.activate(); assert.equal((await endpoint.start(f.ctx)).status, 'pending');
  assert.deepEqual(await readdir(f.hostStateRoot), []); assert.equal((await stat(f.hostStateRoot)).mode, before);
});

test('crash after first upload preserves identity and rejects reviewed rotated key in the same operation', async t => {
  const f = await fixture(t); const { endpoint } = await f.activate(); let reads = 0;
  f.ctx.resources.get = async () => { if (++reads === 4) throw Error('offline simulated crash after first upload'); return new Uint8Array([1, 2, 3]); };
  assert.equal((await endpoint.start(f.ctx)).status, 'failed'); assert.equal(uploads(f.calls).length, 1); assert.equal(creates(f.calls).length, 0);
  const preparation = await (await openJournal({ dataRoot: f.dataRoot, instance: f.instance, operation: f.ctx.operation,
    journalDirectory: f.config.paths.journalDirectory + '/preparation' })).read();
  assert.equal(preparation.state, 'preparing'); assert.ok(preparation.fingerprint);
  const count = f.calls.length; const rotated = 'offline-reviewed-rotated-fixture';
  f.record.credential.sha256 = credentialSha256(rotated); f.record.humanReview.recordId = 'new-offline-key-review'; await f.save();
  f.ctx.credentials.apiKey.secret = rotated; f.ctx.resources.get = async () => new Uint8Array([1, 2, 3]);
  const next = await f.activate(); const result = await next.endpoint.start(f.ctx);
  assert.equal(result.failure.code, 'JOURNAL_IDENTITY_MISMATCH'); assert.equal(f.calls.length, count);
});

test('public start returns known receipt after ACK persistence failure and restart never creates again', async t => {
  let f, extra;
  f = await fixture(t, { create: async () => {
    const journal = await openJournal({ dataRoot: f.dataRoot, instance: f.instance, operation: f.ctx.operation,
      journalDirectory: f.config.paths.journalDirectory });
    extra = join(f.root, 'inert-journal-hardlink'); await link(journal.file, extra);
    return json({ code: 0, data: { taskId: 'offline-known-public-id' } });
  } });
  const { endpoint } = await f.activate(); const result = await endpoint.start(f.ctx);
  assert.equal(result.status, 'failed'); assert.equal(result.failure.code, 'ACK_PERSISTENCE_FAILED');
  assert.deepEqual(result.receipt, { id: 'offline-known-public-id' }); assert.equal(creates(f.calls).length, 1);
  await rm(extra);
  const restarted = await f.activate(); const again = await restarted.endpoint.start(f.ctx);
  assert.equal(again.failure.code, 'OUTCOME_UNKNOWN_NO_NEW_SERIES'); assert.equal(creates(f.calls).length, 1);
});
