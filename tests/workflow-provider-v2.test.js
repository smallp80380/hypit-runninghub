import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as sdk from '@hypit/hypit/generation';
import { validateDescriptor, digest, selectNativeResults } from '../native/descriptor.js';
import { createNativeProvider, createNativeModel, nativeSupport } from '../native/provider.js';
import { createNativeLifecycle } from '../native/lifecycle.js';
import { loadReviewedMemberAuthority, validateMemberBinding, credentialSha256, MEMBER_CONTRACT_SHA256 } from '../native/member-binding.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { openJournal } from '../core/journal.js';
import { importWorkflow, editWorkflow, rebuildDescriptor, fetchWorkflow } from '../workflow/index.js';
const load = async path => JSON.parse(await readFile(new URL('../examples/' + path, import.meta.url)));
const originalDescriptor = await load('v0.0.3/mock-inline-descriptor.json');
const graph = await load('v0.0.3/mock-image-audio-graph.json');
const originalConfig = await load('native-config.json');
const secret = 'inert-offline-v3-never-a-real-key';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const wav = Buffer.from('RIFF\x04\x00\x00\x00WAVE', 'binary');
const mp3 = Buffer.from('ID3\x04\x00\x00', 'binary');
const mp4 = Buffer.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function clock() { let time = 1000; return { now: () => time, sleep: async ms => { time += ms; }, advance: ms => { time += ms; },
  timeout: () => ({ signal: new AbortController().signal, cancel() {} }) }; }
async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rh-workflow-v2-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const descriptor = structuredClone(originalDescriptor); descriptor.fixtureOnly = false;
  if (options.saved) descriptor.sourceMode = 'saved-id';
  if (options.selection) descriptor.resultSelection = { kind: 'extensions', selectedOutputTypes: ['mp4'], ignoredOutputTypes: ['png', 'mp3'], maxSelected: 1, maxIgnored: 2 };
  const config = structuredClone(originalConfig); config.submissionEnabled = true; config.keyType = 'Consumer-Member';
  config.liveBillingEvidence = { kind: 'private-file', path: 'evidence/member.json' }; config.http.allowedDownloadHosts = ['cdn.example.invalid'];
  const record = { format: 'REVIEWED_MEMBER_BINDING@2', family: 'native-workflow', baseUrl: config.baseUrl,
    credential: { reference: config.apiKey, sha256: credentialSha256(secret) },
    workflow: { workflowId: descriptor.workflowId, graphDigest: descriptor.graphDigest.value, descriptorDigest: digest(descriptor),
      sourceMode: descriptor.sourceMode, mappingPolicy: 'declared-port-inputs-only', scope: 'reviewed-native-only-no-external-money' },
    source: { url: MEMBERSHIP_SOURCE, noteSha256: MEMBER_CONTRACT_SHA256 },
    humanReview: { kind: 'project-owner-reviewed-membership-key-and-native-workflow', reviewer: 'offline-test', recordId: 'inert-v3', reviewedAt: new Date(0).toISOString() },
    expiresAt: new Date(86400000).toISOString() };
  await mkdir(join(dataRoot, 'evidence'), { mode: 0o700 });
  const save = () => writeFile(join(dataRoot, 'evidence/member.json'), JSON.stringify(record), { mode: 0o600 }); await save();
  const bytes = { image: Buffer.from(png), audio: Buffer.from(options.mp3 ? mp3 : wav) }, writes = [], calls = []; let uploads = 0, creates = 0;
  const artifact = role => ({ kind: 'blob', resource: `res_${role}`, size: bytes[role].length,
    mediaType: role === 'image' ? 'image/png' : options.mp3 ? 'audio/mpeg' : 'audio/wav' });
  const ctx = { operation: 'offline-v3', credentials: { apiKey: { secret } },
    need: { capability: descriptor.capability, returns: sdk.generationTypes.videoSet, constraints: { ports: {
      prompt: ['new inert prompt'], image: [{ role: 'image', artifact: artifact('image') }], audio: [{ role: 'audio', artifact: artifact('audio') }],
      seed: [42], duration: [2.5], audioStart: [0.25] } } },
    resources: { get: async resource => bytes[resource.slice(4)], put: async (value, mediaType) => {
      writes.push({ value, mediaType }); return { kind: 'blob', resource: 'res_output', size: value.length, mediaType };
    } } };
  const time = clock();
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/accountStatus')) return json({ code: 0, data: { apiType: options.accountType ?? 'NORMAL', remainCoins: '100' } });
    if (url.endsWith('/getJsonApiFormat')) return json({ code: 0, data: { prompt: JSON.stringify(options.remoteGraph ?? graph) } });
    if (url.endsWith('/upload')) {
      uploads++; if (options.upload) return options.upload(uploads, init);
      return json({ code: 0, data: { fileName: `api/exact-${uploads}.${uploads === 1 ? 'png' : options.mp3 ? 'mp3' : 'wav'}`, fileType: 'input' } });
    }
    if (url.endsWith('/create')) {
      creates++; if (options.create) return options.create(creates, init);
      return json({ code: 0, data: { taskId: 'offline-v3-task' } });
    }
    if (url.endsWith('/query')) return json({ taskId: 'offline-v3-task', status: 'SUCCESS', results: options.results ?? [{ url: 'https://cdn.example.invalid/result.mp4?private=signed', outputType: 'mp4' }] });
    return new Response(mp4, { headers: { 'content-type': 'video/mp4' } });
  };
  const base = { config, descriptor, graph, dataRoot, instance: 'offline.v3', pool: 'offline.v3', fetch, clock: time, sdk };
  const activate = async () => {
    const memberAuthority = await loadReviewedMemberAuthority(base); let endpoint, registration;
    createNativeProvider({ ...base, memberAuthority }).install({ registerAsyncEndpoint(i, cap, returns, value, settings) { endpoint = value; registration = settings; } });
    return { endpoint, registration };
  };
  const journal = suffix => openJournal({ dataRoot, instance: base.instance, operation: ctx.operation, journalDirectory: config.paths.journalDirectory + (suffix ?? '') });
  return { ...base, ctx, record, save, activate, journal, calls, bytes, writes };
}
test('@2 public SDK Model admits image/audio/scalars and strict descriptor static mappings', () => {
  assert.deepEqual(validateDescriptor(originalDescriptor, graph, sdk.assertGenerationPortTable), originalDescriptor);
  assert.deepEqual(createNativeModel(originalDescriptor, graph).endpoints.generation.capability, originalDescriptor.capability);
  const bad = structuredClone(graph); bad['11'].inputs.audio = ['absent', 0]; const descriptor = structuredClone(originalDescriptor); descriptor.graphDigest.value = digest(bad);
  assert.throws(() => validateDescriptor(descriptor, bad, sdk.assertGenerationPortTable), { code: 'GRAPH_REFERENCE_INVALID' });
  const dangerous = JSON.parse('{"__proto__": {}}'); assert.throws(() => validateDescriptor(originalDescriptor, dangerous, sdk.assertGenerationPortTable));
});
test('inline public start sends full graph string and identical scalar/media nodeInfoList; no ignored ID fetch', async t => {
  const f = await fixture(t); const { endpoint, registration } = await f.activate();
  assert.equal(registration.supports(f.ctx.need).status, 'supported'); assert.equal((await endpoint.start(f.ctx)).status, 'pending');
  assert.equal(f.calls.filter(c => c.url.endsWith('/getJsonApiFormat')).length, 0);
  const body = JSON.parse(f.calls.find(c => c.url.endsWith('/create')).init.body), effective = JSON.parse(body.workflow);
  assert.equal(body.workflowId, f.descriptor.workflowId); assert.equal(typeof body.workflow, 'string');
  for (const mapping of body.nodeInfoList) assert.equal(effective[mapping.nodeId].inputs[mapping.fieldName], mapping.fieldValue);
  assert.deepEqual(effective['30'].inputs.image, ['10', 0]); assert.equal(effective['30'].inputs.seed, 42);
  assert.equal(effective['11'].inputs.audio, 'api/exact-2.wav'); assert.equal(graph['11'].inputs.audio, '');
  const prepared = await (await f.journal('/preparation')).read();
  assert.equal(prepared.effectiveGraphDigest, digest(effective)); assert.equal(prepared.preparedBodyDigest, digest(prepared.preparedBody));
  assert.equal(f.calls.filter(c => c.url.endsWith('/accountStatus')).length, 2);
  assert.ok(!JSON.stringify(await endpoint.start(f.ctx)).includes(secret));
});
test('@2 saved-ID still preflights exact remote graph and uses nodeInfoList only', async t => {
  const f = await fixture(t, { saved: true }); const { endpoint } = await f.activate(); assert.equal((await endpoint.start(f.ctx)).status, 'pending');
  assert.equal(f.calls.filter(c => c.url.endsWith('/getJsonApiFormat')).length, 2);
  assert.equal(JSON.parse(f.calls.find(c => c.url.endsWith('/create')).init.body).workflow, undefined);
  const bad = await fixture(t, { saved: true, remoteGraph: {} }); const activated = await bad.activate();
  assert.equal((await activated.endpoint.start(bad.ctx)).failure.code, 'WORKFLOW_REVISION_MISMATCH'); assert.equal(bad.calls.filter(c => c.url.endsWith('/upload')).length, 0);
});
test('MP3 and WAV MIME/extension/bytes map exact returned fileName independently from image', async t => {
  for (const mp3 of [false, true]) {
    const f = await fixture(t, { mp3 }); const { endpoint } = await f.activate(); await endpoint.start(f.ctx);
    const forms = f.calls.filter(c => c.url.endsWith('/upload')).map(c => c.init.body);
    assert.equal(forms[1].get('file').type, mp3 ? 'audio/mpeg' : 'audio/wav'); assert.equal(forms[1].get('file').name, mp3 ? 'reference.mp3' : 'reference.wav');
    assert.equal(forms[0].get('file').type, 'image/png'); assert.equal(forms[1].get('apiKey'), secret); assert.equal(forms[1].get('fileType'), 'input');
  }
});
test('all @2 reference roles/signatures/MIME/sizes admitted before first upload', async t => {
  for (const mode of ['audio-signature', 'image-signature', 'audio-mime', 'size', 'role', 'oversize']) {
    const f = await fixture(t);
    if (mode === 'audio-signature') f.bytes.audio.fill(0);
    if (mode === 'image-signature') f.bytes.image.fill(0);
    if (mode === 'audio-mime') f.ctx.need.constraints.ports.audio[0].artifact.mediaType = 'audio/flac';
    if (mode === 'size') f.ctx.need.constraints.ports.audio[0].artifact.size++;
    if (mode === 'role') f.ctx.need.constraints.ports.audio[0].role = 'image';
    if (mode === 'oversize') { f.bytes.audio = Buffer.alloc(30 * 1024 * 1024 + 1); f.ctx.need.constraints.ports.audio[0].artifact.size = f.bytes.audio.length; }
    const { endpoint } = await f.activate(); assert.equal((await endpoint.start(f.ctx)).status, 'failed'); assert.equal(f.calls.filter(c => c.url.endsWith('/upload')).length, 0);
  }
});
test('@1 binding never approves @2; mode/mapping/static edits invalidate review', async t => {
  const f = await fixture(t);
  for (const change of [r => { r.format = 'REVIEWED_MEMBER_BINDING@1'; }, r => { r.workflow.sourceMode = 'saved-id'; }, r => { r.workflow.mappingPolicy = 'any-input'; }]) {
    const record = structuredClone(f.record); change(record); assert.throws(() => validateMemberBinding(record, f.config, f.descriptor, f.clock.now()));
  }
  const changed = structuredClone(f.descriptor); changed.portTable.ports[3].value.maximum = 99;
  assert.throws(() => validateMemberBinding(f.record, f.config, changed, f.clock.now()), { code: 'MEMBER_BINDING_WORKFLOW_MISMATCH' });
  for (const type of ['SHARED', 'MEMBER', 'unknown']) {
    const bad = await fixture(t, { accountType: type }); const { endpoint } = await bad.activate();
    assert.equal((await endpoint.start(bad.ctx)).status, 'failed'); assert.equal(bad.calls.filter(c => c.url.endsWith('/upload')).length, 0);
  }
});
test('dynamic reviewed scalar values accepted; edited template rebuild is candidate and stale bindings fail', async t => {
  const f = await fixture(t); f.ctx.need.constraints.ports.seed = [99]; const { endpoint } = await f.activate(); assert.equal((await endpoint.start(f.ctx)).status, 'pending');
  const revision = importWorkflow(graph), next = editWorkflow(revision, [{ op: 'setInput', nodeId: '30', fieldName: 'seed', value: 8 }], revision.revisionDigest);
  const candidate = rebuildDescriptor(f.descriptor, next, 'graphs/new.json', sdk.assertGenerationPortTable);
  assert.equal(candidate.reviewRequired, true); assert.equal(candidate.semanticValidation, 'UNVERIFIED');
  assert.throws(() => validateMemberBinding(f.record, f.config, candidate.descriptor, f.clock.now()));
  const removed = editWorkflow(revision, [{ op: 'remove', nodeId: '40' }], revision.revisionDigest);
  assert.equal(rebuildDescriptor(f.descriptor, removed, 'graphs/new.json').reviewRequired, true);
  const replacement = editWorkflow(revision, [{ op: 'replace', nodeId: '11', node: { class_type: 'Different', inputs: { audio: '' } } }], revision.revisionDigest);
  assert.throws(() => rebuildDescriptor(f.descriptor, replacement, 'graphs/new.json'), { code: 'INVALID_NODE_MAPPING' });
});
test('inline transient create/upload have durable 3 TOTAL budgets and preserve exact prepared wire', async t => {
  const f = await fixture(t, { create: attempt => attempt < 3 ? new Response('', { status: 503 }) : json({ code: 0, data: { taskId: 'offline-v3-task' } }),
    upload: (attempt, init) => attempt === 1 ? new Response('', { status: 503 }) : json({ code: 0, data: { fileName: 'api/exact-' + init.body.get('file').name, fileType: 'input' } }) });
  const { endpoint } = await f.activate(); assert.equal((await endpoint.start(f.ctx)).status, 'pending');
  const creates = f.calls.filter(c => c.url.endsWith('/create')); assert.equal(creates.length, 3); assert.ok(creates.every(c => c.init.body === creates[0].init.body));
  assert.equal(f.calls.filter(c => c.url.endsWith('/upload')).length, 3);
  const count = f.calls.length; assert.equal((await endpoint.start(f.ctx)).status, 'pending'); assert.equal(f.calls.length, count);
});
test('uncertain create outcome never starts a new series, rotated request/key cannot resume', async t => {
  const f = await fixture(t, { create: () => new Response('', { status: 503 }) }); const { endpoint } = await f.activate();
  assert.equal((await endpoint.start(f.ctx)).status, 'failed'); assert.equal(f.calls.filter(c => c.url.endsWith('/create')).length, 3);
  assert.equal((await endpoint.start(f.ctx)).status, 'failed'); assert.equal(f.calls.filter(c => c.url.endsWith('/create')).length, 3);
  const good = await fixture(t); const activated = await good.activate(); await activated.endpoint.start(good.ctx);
  good.ctx.need.constraints.ports.seed = [7]; assert.equal((await activated.endpoint.start(good.ctx)).failure.code, 'JOURNAL_IDENTITY_MISMATCH');
  good.ctx.need.constraints.ports.seed = [42]; good.ctx.credentials.apiKey.secret = 'another-inert-fixture';
  assert.equal((await activated.endpoint.start(good.ctx)).failure.code, 'JOURNAL_IDENTITY_MISMATCH');
  const uncertain = await fixture(t, { create: () => new Response('', { status: 503 }) }); const enabled = await uncertain.activate();
  await enabled.endpoint.start(uncertain.ctx);
  const journal = await uncertain.journal(), state = await journal.read(); state.state = 'in-flight'; state.attempts = state.attempts.slice(0, 1); await journal.write(state);
  const count = uncertain.calls.length;
  assert.equal((await enabled.endpoint.start(uncertain.ctx)).failure.code, 'OUTCOME_UNKNOWN_NO_NEW_SERIES'); assert.equal(uncertain.calls.length, count);
});
test('prepared checkpoint cannot adopt unrelated static edits or changed source metadata', async t => {
  for (const mode of ['static', 'mode', 'pin', 'filename']) {
    const f = await fixture(t, { create: () => new Response('', { status: 503 }) }); const { endpoint } = await f.activate(); await endpoint.start(f.ctx);
    const journal = await f.journal('/preparation'), state = await journal.read();
    if (mode === 'static') {
      const wire = JSON.parse(state.preparedBody.workflow); wire['30'].inputs.duration = 77;
      state.preparedBody.workflow = JSON.stringify(wire); state.preparedBodyDigest = digest(state.preparedBody); state.effectiveGraphDigest = digest(wire);
    } else if (mode === 'filename') {
      const mapping = state.preparedBody.nodeInfoList.find(m => m.nodeId === '11'); mapping.fieldValue = 'api/unrelated.wav';
      const wire = JSON.parse(state.preparedBody.workflow); wire['11'].inputs.audio = mapping.fieldValue;
      state.preparedBody.workflow = JSON.stringify(wire); state.preparedBodyDigest = digest(state.preparedBody); state.effectiveGraphDigest = digest(wire);
    } else if (mode === 'mode') state.sourceMode = 'saved-id'; else state.templateGraphDigest = '0'.repeat(64);
    await journal.write(state); assert.equal((await endpoint.start(f.ctx)).failure.code, 'PREPARATION_IDENTITY_MISMATCH');
  }
});
test('explicit mixed output selection keeps video and private bounded raw output/count evidence', async t => {
  const results = ['png', 'mp3', 'mp4'].map(outputType => ({ outputType, url: 'https://cdn.example.invalid/file.' + outputType + '?private=signed' }));
  const f = await fixture(t, { selection: true, results }); const { endpoint } = await f.activate(); const start = await endpoint.start(f.ctx);
  const ready = await endpoint.poll({ ...f.ctx, handle: start.handle }); assert.equal(ready.status, 'ready'); assert.ok(!JSON.stringify(ready).includes('signed'));
  const record = await (await f.journal('/results')).read(); assert.equal(record.results.length, 1); assert.equal(record.rawResults.length, 3); assert.equal(record.ignoredCount, 2);
  const output = await endpoint.collect({ ...f.ctx, handle: ready.handle }); assert.equal(output.status, 'completed'); assert.equal(f.writes.length, 1);
  assert.equal(f.calls.at(-1).init.headers, undefined);
  for (const bad of [results.slice(0, 2), [...results, { url: 'https://cdn.example.invalid/x', outputType: 'unknown' }], [...results, results[0]], [...results, results[2]]]) assert.throws(() => selectNativeResults(bad, f.descriptor));
  const strict = structuredClone(f.descriptor); delete strict.resultSelection; assert.throws(() => selectNativeResults(results, strict));
});
const fetchConfig = { format: 'hypit-runninghub.fetch@1', baseUrl: 'https://www.runninghub.ai', workflowId: '123',
  apiKey: { store: 'custom', key: 'explicit' }, requestTimeoutMs: 1000, maxResponseBytes: 1024 * 1024 };
test('public free fetch uses exact configured resolver/origin/request and immutable sanitized provenance', async () => {
  const calls = [];
  const revision = await fetchWorkflow(fetchConfig, { resolveCredential: ref => { assert.deepEqual(ref, fetchConfig.apiKey); return { secret }; },
    fetch: async (url, init) => { calls.push({ url, init }); return json({ code: 0, data: { prompt: JSON.stringify(graph) } }); } });
  assert.equal(revision.graphDigest.value, digest(graph)); assert.ok(Object.isFrozen(revision.graph)); assert.ok(!JSON.stringify(revision).includes(secret));
  assert.equal(calls[0].url, 'https://www.runninghub.ai/api/openapi/getJsonApiFormat');
  assert.deepEqual(JSON.parse(calls[0].init.body), { apiKey: secret, workflowId: '123' }); assert.equal(calls[0].init.headers.authorization, 'Bearer ' + secret);
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls.length, 1);
});
test('fetch rejects guessed credentials, evil origins, malformed/oversized graphs and secret-bearing failures', async () => {
  let calls = 0; const dependencies = { resolveCredential: () => secret, fetch: async () => { calls++; return json({ code: 0, data: { prompt: JSON.stringify(graph) } }); } };
  for (const config of [{ ...fetchConfig, apiKey: secret }, { ...fetchConfig, baseUrl: 'https://evil.example' }, { ...fetchConfig, guess: true }]) await assert.rejects(fetchWorkflow(config, dependencies));
  assert.equal(calls, 0); await assert.rejects(fetchWorkflow(fetchConfig));
  await assert.rejects(fetchWorkflow(fetchConfig, { ...dependencies, resolveCredential: () => { throw Error(secret); } }), e => { assert.equal(e.code, 'CREDENTIAL_RESOLUTION_FAILED'); assert.ok(!e.message.includes(secret)); return true; });
  await assert.rejects(fetchWorkflow(fetchConfig, { ...dependencies, fetch: () => { throw Error(secret); } }), e => !e.message.includes(secret));
  await assert.rejects(fetchWorkflow({ ...fetchConfig, maxResponseBytes: 1024 }, { ...dependencies, fetch: async () => json({ code: 0, data: { prompt: 'x'.repeat(2000) } }) }), { code: 'RESPONSE_TOO_LARGE' });
  await assert.rejects(fetchWorkflow(fetchConfig, { ...dependencies, fetch: async () => json({ code: 0, data: { prompt: '{"a":1,"a":2}' } }) }), { code: 'DUPLICATE_JSON_KEY' });
});
test('fetch bounded network/resolver timeouts never hang or retry/create tasks', async () => {
  const fastClock = { timeout: () => { const controller = new AbortController(); setTimeout(() => controller.abort(), 5); return { signal: controller.signal, cancel() {} }; } };
  await assert.rejects(fetchWorkflow(fetchConfig, { clock: fastClock, resolveCredential: () => new Promise(() => {}), fetch: () => new Promise(() => {}) }), { code: 'NETWORK_TRANSIENT' });
  await assert.rejects(fetchWorkflow(fetchConfig, { clock: fastClock, resolveCredential: () => secret, fetch: () => new Promise(() => {}) }), { code: 'NETWORK_TRANSIENT' });
});
