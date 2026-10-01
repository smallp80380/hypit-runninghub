import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as sdk from '@hypit/hypit/generation';
import { validateDescriptor, digest, sortedJson, verifyRemoteGraph } from '../native/descriptor.js';
import { createNativeLifecycle } from '../native/lifecycle.js';
import { createNativeProvider, createNativeModel, nativeSupport } from '../native/provider.js';
import { readPrivateJson } from '../native/private-files.js';
import { assessMembershipCandidate, MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { openJournal } from '../core/journal.js';
const load = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const config = await load('../examples/native-config.json');
const descriptor = await load('../examples/native-workflow.json');
const graph = await load('../examples/mock-native-graph.json');
const blob = id => ({ kind: 'blob', resource: `res_${id}`, mediaType: 'image/png', size: 3 });
const constraints = { ports: { prompt: ['hello'], referenceImage: [{ role: 'image', artifact: blob('a') }, { role: 'image', artifact: blob('b') }] } };
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const mockMp4 = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
function clock() { let time = 100; return { now: () => time, sleep: async ms => { time += ms; },
  timeout: () => ({ signal: new AbortController().signal, cancel() {} }) }; }
async function fixture(t, extra = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'hypit-rh-native-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const calls = [], writes = [], checkpoints = []; let uploads = 0;
  const c = structuredClone(config); c.http.allowedDownloadHosts = ['cdn.example.invalid'];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (extra.fetch) return extra.fetch(url, init, calls);
    if (url.endsWith('/getJsonApiFormat')) return json({ code: 0, data: { prompt: JSON.stringify(graph) } });
    if (url.endsWith('/upload')) return json({ code: 0, data: { fileName: `input/ref-${++uploads}.png`, fileType: 'input' } });
    if (url.endsWith('/create')) return json({ code: 0, data: { taskId: 'offline-task-1', taskStatus: 'RUNNING' } });
    if (url.endsWith('/query')) return json({ taskId: 'offline-task-1', status: 'SUCCESS', errorCode: null, errorMessage: null,
      results: [{ url: 'https://cdn.example.invalid/video.mp4?private=signed', outputType: 'mp4' }] });
    return new Response(mockMp4, { headers: { 'content-type': 'video/mp4' } });
  };
  const ctx = { operation: 'offline-operation', need: { capability: descriptor.capability, returns: sdk.generationTypes.videoSet, constraints: structuredClone(constraints) },
    credentials: { apiKey: { secret: 'offline-inert-secret' } }, checkpoint: async value => { checkpoints.push(value); },
    resources: { get: async () => new Uint8Array([1, 2, 3]), put: async (bytes, mediaType) => {
      writes.push({ bytes, mediaType }); return { kind: 'blob', resource: 'res_result', size: bytes.length, mediaType };
    } }, ...extra.ctx };
  const options = { config: c, descriptor, graph, dataRoot, instance: 'native.offline', pool: 'offline', fetch, clock: clock(), sdk };
  return { ...options, calls, writes, checkpoints, ctx, endpoint: createNativeLifecycle(options) };
}

test('lexicographic canonicalization matches pinned fixture including integer-like keys', () => {
  assert.equal(sortedJson({ '2': 'two', '10': 'ten' }), '{"10":"ten","2":"two"}');
  assert.equal(digest(graph), descriptor.graphDigest.value);
  assert.deepEqual(validateDescriptor(descriptor, graph, sdk.assertGenerationPortTable), descriptor);
});
test('descriptor mapping rejects wrong types, duplicate targets, missing refs and cycles', () => {
  const wrong = structuredClone(graph); wrong['20'].inputs.text = 7;
  const d = structuredClone(descriptor); d.graphDigest.value = digest(wrong);
  assert.throws(() => validateDescriptor(d, wrong, sdk.assertGenerationPortTable), { code: 'NODE_FIELD_TYPE_MISMATCH' });
  d.graphDigest.value = descriptor.graphDigest.value; d.bindings[1].targets[1] = d.bindings[1].targets[0];
  assert.throws(() => validateDescriptor(d, graph, sdk.assertGenerationPortTable), { code: 'INVALID_NODE_MAPPING' });
  for (const [ref, code] of [['missing', 'GRAPH_REFERENCE_INVALID'], ['30', 'GRAPH_CYCLE']]) {
    const g = structuredClone(graph); g['30'].inputs.prompt = [ref, 0]; const c = structuredClone(descriptor); c.graphDigest.value = digest(g);
    assert.throws(() => validateDescriptor(c, g, sdk.assertGenerationPortTable), { code });
  }
});
test('graph protocol only accepts documented JSON string and exact revision', () => {
  assert.throws(() => verifyRemoteGraph({ code: 0, data: { prompt: graph } }, descriptor), { code: 'WORKFLOW_RESPONSE_UNKNOWN' });
  assert.throws(() => verifyRemoteGraph({ code: 0, data: { prompt: '{}' } }, descriptor), { code: 'WORKFLOW_REVISION_MISMATCH' });
});
test('SDK exact model and planning support validate ports without reading bytes', () => {
  const model = createNativeModel(descriptor, graph);
  assert.deepEqual(model.endpoints.generation.capability, descriptor.capability);
  const request = { capability: descriptor.capability, returns: sdk.generationTypes.videoSet, constraints };
  assert.equal(nativeSupport(descriptor, request).status, 'supported');
  assert.equal(nativeSupport(descriptor, { ...request, constraints: { ports: { prompt: ['hello'] } }, pendingInputs: [{ input: 'references', role: 'image' }] }).status, 'supported');
  assert.equal(nativeSupport(descriptor, { ...request, constraints: { ports: { prompt: ['hello'] } } }).status, 'unsupported');
  assert.equal(nativeSupport(descriptor, { ...request, constraints: { ports: { ...constraints.ports, invented: [1] } } }).status, 'unsupported');
});
test('public provider start stays fail-closed with enabled flag and never touches credentials/network/resources', async t => {
  const f = await fixture(t); f.config.submissionEnabled = true;
  const provider = createNativeProvider(f); let endpoint;
  provider.install({ registerAsyncEndpoint(instance, capability, returns, value) { endpoint = value; } });
  const outcome = await endpoint.start({ get credentials() { throw new Error('credential read prohibited'); } });
  assert.equal(outcome.failure.code, 'COINS_ONLY_UNVERIFIED'); assert.equal(f.calls.length, 0);
});
test('internal offline lifecycle maps references independently and returns BlobResources through SDK', async t => {
  const f = await fixture(t); const start = await f.endpoint.start(f.ctx);
  assert.equal(start.status, 'pending'); assert.equal(f.checkpoints[0].receipt.id, 'offline-task-1');
  const submit = JSON.parse(f.calls.find(c => c.url.endsWith('/create')).init.body);
  assert.deepEqual(submit.nodeInfoList, [{ nodeId: '20', fieldName: 'text', fieldValue: 'hello' },
    { nodeId: '10', fieldName: 'image', fieldValue: 'input/ref-1.png' }, { nodeId: '11', fieldName: 'image', fieldValue: 'input/ref-2.png' }]);
  assert.equal(f.calls[1].init.body.get('fileType'), 'input');
  assert.equal(f.calls[1].init.headers['content-type'], undefined);
  const ready = await f.endpoint.poll({ ...f.ctx, handle: start.handle }); assert.equal(ready.status, 'ready');
  assert.ok(!JSON.stringify(ready).includes('signed'));
  const result = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
  assert.equal(result.result.value.value.videos[0].kind, 'blob'); assert.equal(f.writes.length, 1);
  assert.equal(f.calls.at(-1).init.headers, undefined); // no API key on CDN
});
test('acknowledged operation resumes checkpoint with no new graph/upload/submit calls', async t => {
  const f = await fixture(t); f.ctx.checkpoint = async () => { throw new Error('offline failure'); };
  await assert.rejects(f.endpoint.start(f.ctx), { code: 'CHECKPOINT_FAILED_RESUME' });
  const count = f.calls.length; f.ctx.checkpoint = async () => {};
  assert.equal((await f.endpoint.start(f.ctx)).handle.taskId, 'offline-task-1'); assert.equal(f.calls.length, count);
});
test('all input media admitted before any upload and remote revision mismatch stops', async t => {
  const f = await fixture(t); f.ctx.resources.get = async id => id === 'res_b' ? undefined : new Uint8Array([1, 2, 3]);
  await assert.rejects(f.endpoint.start(f.ctx), { code: 'UNSUPPORTED_REFERENCE_MEDIA' });
  assert.equal(f.calls.length, 1);
  const bad = await fixture(t, { fetch: async () => json({ code: 0, data: { prompt: '{}' } }) });
  await assert.rejects(bad.endpoint.start(bad.ctx), { code: 'WORKFLOW_REVISION_MISMATCH' }); assert.equal(bad.calls.length, 1);
});
test('durable submit budget applies only to create, never repeats upload preparation', async t => {
  let attempts = 0;
  const f = await fixture(t, { fetch: async (url, init) => {
    if (url.endsWith('/getJsonApiFormat')) return json({ code: 0, data: { prompt: JSON.stringify(graph) } });
    if (url.endsWith('/upload')) return json({ code: 0, data: { fileName: 'input/mock.png', fileType: 'input' } });
    if (++attempts < 3) return new Response('', { status: 503 });
    return json({ code: 0, data: { taskId: 'offline-task-1' } });
  } });
  await f.endpoint.start(f.ctx);
  assert.equal(attempts, 3); assert.equal(f.calls.filter(c => c.url.endsWith('/upload')).length, 2);
  assert.equal(f.calls.filter(c => c.url.endsWith('/getJsonApiFormat')).length, 4);
});
test('parallel starters share preparation lock, one submit; unknown acknowledgement never starts a new series', async t => {
  const f = await fixture(t); const results = await Promise.allSettled([f.endpoint.start(f.ctx), f.endpoint.start(f.ctx)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.calls.filter(c => c.url.endsWith('/create')).length, 1);
  const j = await openJournal({ dataRoot: f.dataRoot, instance: f.instance, operation: 'crashed', journalDirectory: f.config.paths.journalDirectory });
  await j.write({ version: 1, action: 'submit', fingerprint: digest({ descriptor, ports: constraints.ports, apiKeyReference: config.apiKey, baseUrl: config.baseUrl,
    credentialSha256: createHash('sha256').update('offline-inert-secret').digest('hex') }), state: 'in-flight', attempts: [{ attempt: 1 }], taskIds: [] });
  const count = f.calls.length; await assert.rejects(f.endpoint.start({ ...f.ctx, operation: 'crashed' }), { code: 'OUTCOME_UNKNOWN_NO_NEW_SERIES' });
  assert.equal(f.calls.length, count);
});
test('candidate Membership evidence never grants execution even with NORMAL and matching scope', () => {
  const c = structuredClone(config); c.keyType = 'Consumer-Member';
  const evidence = { source: { url: MEMBERSHIP_SOURCE, statement: 'Membership API KEY consumes RH coins' },
    credentialIdentification: { kind: 'user-identified-membership-key', reference: c.apiKey },
    workflowReview: { workflowId: descriptor.workflowId, graphDigest: descriptor.graphDigest.value, scope: 'native-only-no-external-api-charge' } };
  const observation = { actualAccountApiType: 'NORMAL', observedAt: 100, credentialReference: c.apiKey };
  const result = assessMembershipCandidate({ config: c, descriptor, evidence, observation, now: 110 });
  assert.equal(result.executionAuthorized, false); assert.equal(result.status, 'candidate-needs-authoritative-key-class-proof');
  assert.ok(assessMembershipCandidate({ config: c, descriptor, evidence, observation: { ...observation, actualAccountApiType: 'SHARED' }, now: 110 }).reasons.includes('KNOWN_SHARED_DENIAL'));
});
test('private descriptor paths reject symlinks and result handles cannot introduce task IDs', async t => {
  const f = await fixture(t); await mkdir(join(f.dataRoot, 'descriptors'));
  await writeFile(join(f.dataRoot, 'descriptors', 'good.json'), '{}');
  await symlink(join(f.dataRoot, 'descriptors', 'good.json'), join(f.dataRoot, 'descriptors', 'linked.json'));
  await assert.rejects(readPrivateJson(f.dataRoot, 'descriptors/linked.json'), { code: 'UNSAFE_PRIVATE_FILE' });
  await assert.rejects(f.endpoint.poll({ ...f.ctx, handle: { contract: 'hypit.runninghub.native@1', taskId: 'unowned', descriptorDigest: digest(descriptor) } }), { code: 'TASK_NOT_IN_OPERATION_JOURNAL' });
});

test('second independent native descriptor maps scalar number/boolean ports and image output', async t => {
  const f = await fixture(t);
  const g = { '1': { class_type: 'MockImage', inputs: { prompt: 'placeholder', seed: 0, enabled: true } } };
  const d = { schemaVersion: 'hypit-runninghub.workflow@1', fixtureOnly: true, workflowId: '2000000000000000002', graphFile: 'second.json',
    graphDigest: { algorithm: 'sha256', canonicalization: 'json-sorted-keys@1', value: digest(g) },
    capability: { module: { name: '@example/second-image', version: '2' }, name: 'second-image' },
    portTable: { model: 'second-image', result: 'image', requires: [], ports: [
      { name: 'instructions', minItems: 1, maxItems: 1, value: { kind: 'text' } },
      { name: 'seed', minItems: 1, maxItems: 1, value: { kind: 'number', integer: true, minimum: 0 } },
      { name: 'enabled', minItems: 1, maxItems: 1, value: { kind: 'boolean' } }] },
    bindings: ['instructions', 'seed', 'enabled'].map((port, i) => ({ port, transport: 'scalar', targets: [{ itemIndex: 0, nodeId: '1', fieldName: ['prompt', 'seed', 'enabled'][i], expectedClassType: 'MockImage' }] })) };
  validateDescriptor(d, g, sdk.assertGenerationPortTable);
  let submitted;
  const fetch = async (url, init) => {
    if (url.endsWith('/getJsonApiFormat')) return json({ code: 0, data: { prompt: JSON.stringify(g) } });
    submitted = JSON.parse(init.body); return json({ code: 0, data: { taskId: 'offline-image' } });
  };
  const endpoint = createNativeLifecycle({ ...f, descriptor: d, fetch });
  await endpoint.start({ ...f.ctx, need: { capability: d.capability, constraints: { ports: { instructions: ['new'], seed: [42], enabled: [false] } } } });
  assert.equal(submitted.workflowId, d.workflowId);
  assert.deepEqual(submitted.nodeInfoList.map(n => n.fieldValue), ['new', 42, false]);
});

test('bounded polling handles native pending/failure/transient states and rejects unimplemented states', async t => {
  for (const status of ['RUNNING', 'QUEUED', 'FAILED', 'UNRECOGNIZED']) {
    const f = await fixture(t); const start = await f.endpoint.start(f.ctx);
    const endpoint = createNativeLifecycle({ ...f, fetch: async () => json({ taskId: 'offline-task-1', status, errorCode: '', errorMessage: '' }) });
    if (status === 'UNRECOGNIZED') await assert.rejects(endpoint.poll({ ...f.ctx, handle: start.handle }), { code: 'QUERY_RESPONSE_UNKNOWN' });
    else assert.equal((await endpoint.poll({ ...f.ctx, handle: start.handle })).status, status === 'FAILED' ? 'failed' : 'pending');
  }
  const f = await fixture(t); const start = await f.endpoint.start(f.ctx);
  const endpoint = createNativeLifecycle({ ...f, fetch: async () => new Response('', { status: 503 }) });
  const ctx = { ...f.ctx, handle: start.handle };
  for (let i = 0; i < 4; i++) assert.equal((await endpoint.poll(ctx)).status, 'pending');
  await assert.rejects(endpoint.poll(ctx), { code: 'POLL_FAILURE_LIMIT' });
});

test('empty success, extension mismatch and observed Money usage fail closed', async t => {
  for (const fields of [{ results: [] }, { results: [{ url: 'https://cdn.example.invalid/x', outputType: 'video' }] },
    { results: [{ url: 'https://cdn.example.invalid/x', outputType: 'mp4' }], usage: { consumeMoney: '0.01', thirdPartyConsumeMoney: null } }]) {
    const f = await fixture(t); const start = await f.endpoint.start(f.ctx);
    const endpoint = createNativeLifecycle({ ...f, fetch: async () => json({ taskId: 'offline-task-1', status: 'SUCCESS', ...fields }) });
    await assert.rejects(endpoint.poll({ ...f.ctx, handle: start.handle }), { code: fields.usage ? 'BILLING_MISMATCH' : 'RESULT_RESPONSE_UNKNOWN' });
  }
});

test('collect refuses untrusted result origins, MIME mismatch and oversized body', async t => {
  for (const mode of ['origin', 'mime', 'size']) {
    const f = await fixture(t); const start = await f.endpoint.start(f.ctx); await f.endpoint.poll({ ...f.ctx, handle: start.handle });
    const c = structuredClone(f.config);
    if (mode === 'origin') c.http.allowedDownloadHosts = ['other.invalid'];
    if (mode === 'size') c.http.maxDownloadBytes = 2;
    let downloads = 0;
    const endpoint = createNativeLifecycle({ ...f, config: c, fetch: async () => { downloads++;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': mode === 'mime' ? 'text/plain' : 'video/mp4' } }); } });
    await assert.rejects(endpoint.collect({ ...f.ctx, handle: start.handle }), { code: { origin: 'UNSAFE_RESULT_URL', mime: 'DOWNLOAD_MEDIA_MISMATCH', size: 'RESPONSE_TOO_LARGE' }[mode] });
    if (mode === 'origin') assert.equal(downloads, 0);
    assert.equal(f.writes.length, 0);
  }
});

test('rotated credential or changed request cannot resume an existing submit series', async t => {
  const f = await fixture(t); await f.endpoint.start(f.ctx); const calls = f.calls.length;
  await assert.rejects(f.endpoint.start({ ...f.ctx, credentials: { apiKey: { secret: 'different-inert-secret' } } }), { code: 'JOURNAL_IDENTITY_MISMATCH' });
  const need = structuredClone(f.ctx.need); need.constraints.ports.prompt = ['changed'];
  await assert.rejects(f.endpoint.start({ ...f.ctx, need }), { code: 'JOURNAL_IDENTITY_MISMATCH' });
  assert.equal(f.calls.length, calls);
});

test('collect rejects empty/false media bytes; bounded private observations retain sanitized usage', async t => {
  for (const [bytes, code] of [[new Uint8Array(), 'DOWNLOAD_EMPTY'], [new Uint8Array([1, 2, 3]), 'DOWNLOAD_SIGNATURE_MISMATCH']]) {
    const f = await fixture(t); const start = await f.endpoint.start(f.ctx); await f.endpoint.poll({ ...f.ctx, handle: start.handle });
    const endpoint = createNativeLifecycle({ ...f, fetch: async () => new Response(bytes, { headers: { 'content-type': 'video/mp4' } }) });
    await assert.rejects(endpoint.collect({ ...f.ctx, handle: start.handle }), { code });
    assert.equal(f.writes.length, 0);
  }
  const f = await fixture(t); const start = await f.endpoint.start(f.ctx);
  const endpoint = createNativeLifecycle({ ...f, fetch: async () => json({ taskId: 'offline-task-1', status: 'SUCCESS',
    usage: { consumeMoney: null, consumeCoins: '255', thirdPartyConsumeMoney: null, taskCostTime: '20', untrusted: 'secret' },
    promptTips: 'private unsafe upstream message', results: [{ url: 'https://cdn.example.invalid/x?private=signed', outputType: 'mp4' }] }) });
  await endpoint.poll({ ...f.ctx, handle: start.handle });
  const record = await (await openJournal({ dataRoot: f.dataRoot, instance: f.instance, operation: f.ctx.operation,
    journalDirectory: f.config.paths.journalDirectory + '/observations' })).read();
  assert.equal(record.usage.consumeCoins, '255'); assert.ok(!JSON.stringify(record).includes('private'));
  assert.ok(!JSON.stringify(record).includes('untrusted'));
});
