import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRunningHubTarget } from '../generic/service-target.js';
import { createJsonTransport } from '../core/transport.js';
import { workflowClock, fetchWorkflow } from '../workflow/fetch.js';
import { appFixture, failed, noEffects, publicSafe, KEY, PASSWORD, PNG, mixedOutputs } from './ai-app-fixture.js';
import { digest } from '../native/descriptor.js';
import { credentialSha256 } from '../native/member-binding.js';
import { ProviderError } from '../core/errors.js';
import './ai-app-origin.test.js';
import './credential-scalars.test.js';
import './ai-app-crash.test.js';
import './usage-credentials.test.js';
import './provider-credential-boundaries.test.js';

const id = '1937084629516193794';
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
test('service IDs stay exact and page URLs cannot change service kind or origin', () => {
  const expected = { kind: 'ai-app', id };
  assert.deepEqual(parseRunningHubTarget(id, 'ai-app'), expected);
  assert.deepEqual(parseRunningHubTarget(`https://www.runninghub.cn/ai-detail/${id}/?ignored=1#x`, 'ai-app'), expected);
  assert.deepEqual(parseRunningHubTarget('https://www.runninghub.ai/post/1979026379880697857', 'workflow'), { kind: 'workflow', id: '1979026379880697857' });
  for (const value of [Number(id), `https://evil.invalid/ai-detail/${id}`, `https://u@www.runninghub.ai/ai-detail/${id}`, `https://www.runninghub.ai:443/ai-detail/${id}`, `https://www.runninghub.ai/post/${id}`, `https://www.runninghub.ai/foo/../ai-detail/${id}`]) {
    assert.throws(() => parseRunningHubTarget(value, 'ai-app'), { code: 'INVALID_SERVICE_TARGET' });
  }
});
test('metadata GET admits only the documented exact query without body or redirects', async () => {
  const calls = [], secret = 'inert-metadata-key';
  const transport = createJsonTransport({ baseUrl: 'https://www.runninghub.ai', family: 'native-workflow', clock: workflowClock, timeoutMs: 1000, maxResponseBytes: 4096,
    fetch: async (url, init) => { calls.push({ url, init }); return json({ code: 0 }); } });
  const good = { path: '/api/webapp/apiCallDemo', method: 'GET', secret, query: { apiKey: secret, webappId: id } };
  await transport.request(good);
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get('webappId'), id); assert.equal(calls[0].init.body, undefined); assert.equal(calls[0].init.redirect, 'error');
  for (const change of [{ path: '/account' }, { method: 'PUT' }, { body: {} }, { query: { ...good.query, other: '1' } }, { query: { ...good.query, apiKey: 'wrong' } }, { query: { ...good.query, webappId: Number(id) } }, { method: 'POST' }]) {
    await assert.rejects(transport.request({ ...good, ...change }));
  }
  const standard = createJsonTransport({ baseUrl: 'https://www.runninghub.ai/openapi/v2', family: 'standard-model', clock: workflowClock, timeoutMs: 1000, maxResponseBytes: 4096,
    fetch: async (url, init) => { calls.push({ url, init }); return json({ code: 0 }); } });
  await assert.rejects(standard.request(good), { code: 'INVALID_API_PATH' });
  assert.equal(calls.length, 1);
});
test('workflow page fetch submits only the normalized decimal ID to its read API', async () => {
  let body;
  const config = { format: 'hypit-runninghub.fetch@1', baseUrl: 'https://www.runninghub.ai', workflowId: 'https://www.runninghub.cn/post/1979026379880697857', apiKey: { store: 'fixture', key: 'fixture' }, requestTimeoutMs: 1000, maxResponseBytes: 4096 };
  await fetchWorkflow(config, { resolveCredential: () => 'inert-key', fetch: async (url, init) => { assert.equal(url, 'https://www.runninghub.ai/api/openapi/getJsonApiFormat'); body = JSON.parse(init.body); return json({ code: 0, data: { prompt: JSON.stringify({ '1': { class_type: 'Literal', inputs: {} } }) } }); } });
  assert.equal(body.workflowId, '1979026379880697857');
});

test('app metadata snapshots retain only literal interface fields and reject captured secrets', async () => {
  const { fetchAiApp, validateAiAppDocument } = await import('../ai-app/document.js');
  const secret = 'inert-metadata-key';
  const config = { format: 'hypit-runninghub.ai-app-fetch@1', baseUrl: 'https://www.runninghub.ai', webappId: id, apiKey: { store: 'fixture', key: 'fixture' }, requestTimeoutMs: 1000, maxResponseBytes: 4096 };
  const node = { nodeId: '1', nodeName: 'Input', fieldName: 'text', fieldValue: 'literal', fieldData: 'not-a-schema', fieldType: 'STRING', description: '', descriptionEn: '' };
  let data = { webappName: 'App', accessEncrypted: false, nodeInfoList: [node], curl: secret, statisticsInfo: { count: 1 } };
  const calls = [];
  const deps = { resolveCredential: () => secret, fetch: async (url, init) => { calls.push({ url, init }); return json({ code: 0, data }); } };
  const first = await fetchAiApp(config, deps);
  assert.equal(first.webappId, id); assert.deepEqual(first.nodeInfoList, [node]); assert.ok(!JSON.stringify(first).includes(secret));
  assert.deepEqual(validateAiAppDocument(first), first);
  data = { ...data, webappName: 'Renamed', statisticsInfo: { count: 999 } };
  const second = await fetchAiApp({ ...config, webappId: `https://www.runninghub.cn/ai-detail/${id}` }, deps);
  assert.equal(first.appDigest, second.appDigest);
  for (const field of ['fieldData', 'fieldValue']) {
    data = { ...data, nodeInfoList: [{ ...node, [field]: 'changed' }] };
    assert.notEqual((await fetchAiApp(config, deps)).appDigest, first.appDigest);
  }
  data = { ...data, nodeInfoList: [], accessEncrypted: true };
  assert.notEqual((await fetchAiApp(config, deps)).appDigest, first.appDigest);
  data = { ...data, webappName: secret };
  await assert.rejects(fetchAiApp(config, deps), error => !error.message.includes(secret));
  for (const target of [Number(id), `https://evil.invalid/ai-detail/${id}`, `https://www.runninghub.ai/post/${id}`]) {
    const before = calls.length;
    await assert.rejects(fetchAiApp({ ...config, webappId: target }, deps), { code: 'INVALID_SERVICE_TARGET' });
    assert.equal(calls.length, before);
  }
});

test('app default overrides and file targets are disjoint and keep literal values', async () => {
  const { requestFromAiAppDocument } = await import('../ai-app/document.js');
  const { validateAiAppRequest, aiAppRequestDigest } = await import('../ai-app/request.js');
  const { digest } = await import('../native/descriptor.js');
  const node = (fieldName, fieldValue) => ({ nodeId: '1', nodeName: 'Input', fieldName, fieldValue, fieldData: '', fieldType: 'STRING', description: '', descriptionEn: '' });
  const content = { format: 'hypit-runninghub.ai-app-document@1', baseUrl: 'https://www.runninghub.ai', webappId: id, webappName: 'App', accessEncrypted: false, nodeInfoList: [node('text', 'default'), node('image', '')] };
  const document = { ...content, appDigest: digest({ baseUrl: content.baseUrl, webappId: id, accessEncrypted: false, nodeInfoList: content.nodeInfoList }) };
  const override = { nodeId: '1', fieldName: 'text', fieldValue: [false, null, { literal: 42 }] };
  const binding = { fileKey: 'image', nodeId: '1', fieldName: 'image' };
  const request = requestFromAiAppDocument(document, { nodeInfoList: [override], bindings: [binding], draft: true, instanceType: 'plus' });
  assert.deepEqual(request.nodeInfoList, [override]); assert.deepEqual(request.bindings, [binding]);
  assert.equal(request.instanceType, 'plus'); assert.equal(request.webappId, id);
  for (const options of [{ nodeInfoList: [override, override] }, { nodeInfoList: [{ ...override, fieldName: 'unknown' }] }, { nodeInfoList: [override], bindings: [{ ...binding, fieldName: 'text' }] }, { bindings: [binding, binding] }]) {
    assert.throws(() => requestFromAiAppDocument(document, { ...options, draft: true }));
  }
  const emptyContent = { ...content, nodeInfoList: [] };
  const empty = requestFromAiAppDocument({ ...emptyContent, appDigest: digest({ baseUrl: content.baseUrl, webappId: id, accessEncrypted: false, nodeInfoList: [] }) });
  assert.deepEqual(empty.nodeInfoList, []);
  const blob = { kind: 'blob', resource: 'res_A', size: 4, mediaType: 'image/png' };
  const full = validateAiAppRequest({ ...request, files: [{ key: 'image', blob }] });
  assert.equal(aiAppRequestDigest(full), aiAppRequestDigest({ ...full, review: 'reviews/new.json', files: [{ key: 'image', blob: { ...blob, resource: 'res_B' } }] }));
  assert.notEqual(aiAppRequestDigest(full), aiAppRequestDigest({ ...full, instanceType: 'ultra' }));
  assert.throws(() => validateAiAppRequest({ ...full, webappId: Number(id) }));
});

test('app authored surface preserves JSON values and shared output projection', async () => {
  const { renderAiAppAuthor } = await import('../ai-app/author-source.js');
  const { decodeAiAppSurface } = await import('../ai-app/author.js');
  const request = { format: 'hypit-runninghub.ai-app-request@1', webappId: id, nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: { list: [false, null], text: '<&' } }], files: [], bindings: [] };
  const source = renderAiAppAuthor(request, { outputs: [{ name: '__rh.draft', index: 0 }] });
  assert.ok(source.includes(':AiApp')); assert.ok(source.includes('&lt;&amp;'));
  const range = { source: 'fixture', start: 0, end: 1 };
  const element = (name, attributes, children = []) => ({ kind: 'element', name, attributes, children, range });
  const decoded = await decodeAiAppSurface({ element: element('AiApp', { id: 'app' }, [element('Request', {}, [{ kind: 'text', value: JSON.stringify(request), range }]), element('Output', { name: '__rh.draft', index: '0' })]), resolveReference: () => undefined, resolveAsset: async () => { throw Error('unexpected'); } });
  const record = decoded.records.find(record => record.type.name === 'AiAppDraft');
  assert.deepEqual(record.value.value.nodeInfoList, request.nodeInfoList);
  assert.notEqual(record.id, 'app.__rh.draft');
});

test('App owner review pins identity, selected values, time, files and both credentials', async () => {
  const { readFile } = await import('node:fs/promises');
  const { validateGenericConfig } = await import('../generic/config.js');
  const { validateAiAppReview } = await import('../ai-app/review.js');
  const { validateWorkflowReview } = await import('../generic/review.js');
  const { aiAppRequestDigest } = await import('../ai-app/request.js');
  const { credentialSha256, MEMBER_CONTRACT_SHA256 } = await import('../native/member-binding.js');
  const { MEMBERSHIP_SOURCE } = await import('../native/membership-assessment.js');
  const config = validateGenericConfig({ ...JSON.parse(await readFile(new URL('../examples/generic-config.json', import.meta.url))), keyType: 'Consumer-Member', accessPassword: { store: 'fixture', key: 'password' } });
  const secret = 'inert-key', password = 'inert-password', appDigest = 'a'.repeat(64);
  const request = { format: 'hypit-runninghub.ai-app-request@1', webappId: id, nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: 'chosen' }], files: [], bindings: [], instanceType: 'plus' };
  const review = { format: 'REVIEWED_AI_APP_OPERATION@1', credential: { reference: config.apiKey, sha256: credentialSha256(secret) }, accessPasswordCredential: { reference: config.accessPassword, sha256: credentialSha256(password) }, baseUrl: config.baseUrl, requestDigest: aiAppRequestDigest(request), appDigest, fileDigests: [], scope: 'reviewed-ai-app-only-no-external-money', source: { url: MEMBERSHIP_SOURCE, noteSha256: MEMBER_CONTRACT_SHA256 }, humanReview: { kind: 'project-owner-reviewed-membership-key-and-ai-app', recordId: 'INERT', reviewer: 'MOCK', reviewedAt: new Date(0).toISOString() }, expiresAt: new Date(10000).toISOString() };
  const args = { config, request, appDigest, fileDigests: [], secret, password, now: 1000 };
  assert.deepEqual(validateAiAppReview(review, args), review);
  for (const [change, code] of [[{ secret: 'rotated' }, 'MEMBER_BINDING_SECRET_MISMATCH'], [{ password: 'rotated' }, 'MEMBER_BINDING_SECRET_MISMATCH'], [{ now: 10000 }, 'MEMBER_BINDING_EXPIRED'], [{ appDigest: 'b'.repeat(64) }, 'MEMBER_BINDING_APP_MISMATCH'], [{ request: { ...request, instanceType: 'ultra' } }, 'MEMBER_BINDING_APP_MISMATCH'], [{ request: { ...request, nodeInfoList: [{ ...request.nodeInfoList[0], fieldValue: 'other' }] } }, 'MEMBER_BINDING_APP_MISMATCH']]) {
    assert.throws(() => validateAiAppReview(review, { ...args, ...change }), { code });
  }
  assert.throws(() => validateAiAppReview({ ...review, humanReview: { ...review.humanReview, kind: 'UNREVIEWED_OWNER_MUST_CHECK' } }, args));
  assert.throws(() => validateAiAppReview({ ...review, accessPasswordCredential: undefined }, args));
  assert.throws(() => validateWorkflowReview(review, { ...args, request: { format: 'hypit-runninghub.request@1', workflowId: '1', nodeInfoList: [], files: [], bindings: [] } }));
  const noPassword = { ...config }; delete noPassword.accessPassword;
  assert.throws(() => validateAiAppReview(review, { ...args, config: noPassword }));
});

test('App candidate remains non-executable and pins the fetched interface', async () => {
  const { readFile } = await import('node:fs/promises');
  const { digest } = await import('../native/descriptor.js');
  const { prepareAiAppReviewCandidate } = await import('../ai-app/review-candidate.js');
  const { validateAiAppReview } = await import('../ai-app/review.js');
  const config = { ...JSON.parse(await readFile(new URL('../examples/generic-config.json', import.meta.url))), keyType: 'Consumer-Member' };
  const request = { format: 'hypit-runninghub.ai-app-request@1', webappId: id, nodeInfoList: [], files: [], bindings: [] };
  const content = { baseUrl: config.baseUrl, webappId: id, accessEncrypted: false, nodeInfoList: [] };
  const app = { format: 'hypit-runninghub.ai-app-document@1', ...content, webappName: 'Parameterless', appDigest: digest(content) };
  const candidate = await prepareAiAppReviewCandidate({ config, request, app, credentialSha256: 'a'.repeat(64) });
  assert.equal(candidate.semanticValidation, 'UNVERIFIED'); assert.equal(candidate.reviewRequired, true);
  assert.equal(candidate.record.appDigest, app.appDigest); assert.equal(candidate.record.expiresAt, null);
  assert.throws(() => validateAiAppReview(candidate.record, { config, request, appDigest: app.appDigest, now: 1000 }));
  await assert.rejects(prepareAiAppReviewCandidate({ config, request, credentialSha256: 'a'.repeat(64) }));
  await assert.rejects(prepareAiAppReviewCandidate({ config, request: { ...request, webappId: '2' }, app, credentialSha256: 'a'.repeat(64) }));
});

for (const count of [0, 1]) {
  test(`App review candidate rejects extra files for a ${count}-file request`, async t => {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { prepareAiAppReviewCandidate } = await import('../ai-app/review-candidate.js');
    const f = await appFixture(t, { files: count });
    const path = join(f.dataRoot, 'input.png');
    await writeFile(path, f.state.inputs[0] ?? PNG);
    const files = f.request.files.map(file => ({ key: file.key, path, mediaType: file.blob.mediaType }));
    files.push({ key: 'extra', path, mediaType: 'image/png' });
    await assert.rejects(prepareAiAppReviewCandidate({ config: f.config, request: f.request, app: f.app,
      credentialSha256: credentialSha256(KEY), files }), { code: 'REVIEW_FILE_MISMATCH' });
    noEffects(f);
  });
}

test('App review candidate requires all files and yields a valid review after owner approval', async t => {
  const { writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { prepareAiAppReviewCandidate } = await import('../ai-app/review-candidate.js');
  const { validateAiAppReview } = await import('../ai-app/review.js');
  const f = await appFixture(t, { files: 1 });
  const path = join(f.dataRoot, 'input.png');
  await writeFile(path, f.state.inputs[0]);
  const options = { config: f.config, request: f.request, app: f.app, credentialSha256: credentialSha256(KEY) };
  await assert.rejects(prepareAiAppReviewCandidate({ ...options, files: [] }), { code: 'REVIEW_FILE_MISMATCH' });
  const candidate = await prepareAiAppReviewCandidate({ ...options,
    files: [{ key: 'file-0', path, mediaType: 'image/png' }] });
  const reviewed = { ...candidate.record, humanReview: f.review.humanReview, expiresAt: f.review.expiresAt };
  assert.deepEqual(validateAiAppReview(reviewed, { config: f.config, request: f.request,
    appDigest: f.app.appDigest, fileDigests: f.review.fileDigests, secret: KEY, now: f.state.now }), reviewed);
  noEffects(f);
});

test('reviewed App runs through the installed account endpoint and collects exact ordered heterogeneous files', async t => {
  const f = await appFixture(t, { files: 2, password: true, instanceType: 'plus' });
  assert.equal(f.settings.supports(f.ctx.need).status, 'supported');
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.deepEqual(started.receipt, { id: 'app-fixture-task' });
  assert.equal(started.handle.contract, 'hypit.runninghub.ai-app@1');
  assert.equal(f.state.appSubmits, 1); assert.equal(f.state.workflowSubmits, 0);
  const submit = f.calls.find(call => call.path === '/task/openapi/ai-app/run').body;
  assert.deepEqual(submit, { apiKey: KEY, webappId: id, nodeInfoList: [
    f.request.nodeInfoList[0],
    { nodeId: '1', fieldName: 'file-0', fieldValue: 'api/input-1.png' },
    { nodeId: '1', fieldName: 'file-1', fieldValue: 'api/input-2.png' },
  ], instanceType: 'plus' });
  for (const [index, call] of f.calls.filter(call => call.path === '/task/openapi/upload').entries()) {
    assert.deepEqual(Buffer.from(await call.init.body.get('file').arrayBuffer()), f.state.inputs[index]);
  }
  const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const value = completed.result.value.value;
  assert.equal(value.format, 'hypit-runninghub.result@1'); assert.equal(value.taskId, 'app-fixture-task');
  assert.equal(value.outputs.length, mixedOutputs.length);
  for (const [index, item] of mixedOutputs.entries()) {
    assert.deepEqual(f.writes[index].bytes, item.bytes);
    assert.equal(f.writes[index].mediaType, item.mime);
    assert.equal(value.outputs[index].blob.mediaType, item.mime);
    assert.equal(value.outputs[index].blob.size, item.bytes.length);
    assert.equal(value.outputs[index].outputType, item.outputType);
    assert.equal(value.outputs[index].metadata.order, index);
    assert.deepEqual(value.outputs[index].metadata.literal, [false, null]);
  }
  assert.equal(new Set(value.outputs.map(output => output.blob.resource)).size, mixedOutputs.length);
  publicSafe([started, ready, completed]);
  const preparation = await (await f.journal('/preparation')).read();
  assert.equal(preparation.format, 'ai-app-preparation@1');
  assert.equal(preparation.appDigest, f.app.appDigest);
  assert.equal(preparation.app.appDigest, f.app.appDigest);
  assert.ok(!Object.hasOwn(preparation.app, 'curl'));
  publicSafe([preparation, await (await f.journal()).read()]);
});

test('parameterless App and empty SUCCESS need neither uploads nor synthetic outputs', async t => {
  const f = await appFixture(t, { parameterless: true, items: [] });
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const submitted = f.calls.find(call => call.path === '/task/openapi/ai-app/run').body;
  assert.deepEqual(submitted, { apiKey: KEY, webappId: id, nodeInfoList: [] });
  const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
  assert.equal(ready.status, 'ready');
  const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result.value.value.outputs, []);
  assert.equal(f.state.uploads, 0); assert.equal(f.state.downloads, 0); assert.equal(f.writes.length, 0);
});

test('App admission rejects every changed owner binding before any upload or submit', async t => {
  const cases = [
    { name: 'missing owner review despite NORMAL positive coins', code: 'COINS_ONLY_UNVERIFIED', mutate: f => { delete f.request.review; } },
    { name: 'unknown review format', code: 'COINS_ONLY_UNVERIFIED', mutate: async f => { f.review.format = 'UNKNOWN_REVIEW@1'; await f.saveReview(); } },
    { name: 'workflow owner review cannot authorize an App', code: 'MEMBER_BINDING_APP_MISMATCH', mutate: async f => {
      const workflow = await f.workflowContext(); await f.saveReview(workflow.review);
    } },
    { name: 'unreviewed candidate', code: 'COINS_ONLY_UNVERIFIED', mutate: async f => {
      f.review.humanReview.kind = 'UNREVIEWED_OWNER_MUST_CHECK'; await f.saveReview();
    } },
    { name: 'expired review', code: 'MEMBER_BINDING_EXPIRED', mutate: async f => {
      f.review.expiresAt = new Date(1000).toISOString(); await f.saveReview();
    } },
    { name: 'selected values', code: 'MEMBER_BINDING_APP_MISMATCH', mutate: f => { f.request.nodeInfoList[0].fieldValue = 'changed'; } },
    { name: 'instance tier', code: 'MEMBER_BINDING_APP_MISMATCH', mutate: f => { f.request.instanceType = 'ultra'; } },
    { name: 'interface snapshot', code: 'MEMBER_BINDING_APP_MISMATCH', mutate: f => { f.state.metadata.nodeInfoList[0].fieldData = 'changed-literal-interface'; } },
    { name: 'ordered file bytes', code: 'MEMBER_BINDING_APP_MISMATCH', mutate: f => { f.state.inputs.reverse(); } },
    { name: 'ordered file declarations', code: 'MEMBER_BINDING_APP_MISMATCH', mutate: f => { f.request.files.reverse(); } },
    { name: 'rotated API key', code: 'MEMBER_BINDING_SECRET_MISMATCH', mutate: f => { f.ctx.credentials.apiKey.secret = 'rotated-inert-key'; } },
    { name: 'rotated password', code: 'MEMBER_BINDING_SECRET_MISMATCH', mutate: f => { f.ctx.credentials.accessPassword.secret = 'rotated-inert-password'; } },
    { name: 'password credential reference', code: 'MEMBER_BINDING_CREDENTIAL_MISMATCH', mutate: async f => {
      f.review.accessPasswordCredential.reference = { store: 'fixture', key: 'different-password' }; await f.saveReview();
    } },
    { name: 'SHARED account', code: 'BILLING_MISMATCH', mutate: f => { f.state.accountType = 'SHARED'; } },
    { name: 'review expires during account preflight', code: 'MEMBER_BINDING_EXPIRED', mutate: async f => {
      f.review.expiresAt = new Date(f.state.now + 1000).toISOString(); await f.saveReview();
      f.state.onAccount = () => { f.state.now = Date.parse(f.review.expiresAt); return { code: 0, data: { apiType: 'NORMAL', remainCoins: '100' } }; };
    } },
  ];
  for (const entry of cases) await t.test(entry.name, async child => {
    const f = await appFixture(child, { files: 2, password: true, instanceType: 'plus' });
    await entry.mutate(f);
    const result = await f.endpoint.start(f.ctx);
    failed(result, entry.code); noEffects(f); publicSafe(result, ['rotated-inert-key', 'rotated-inert-password']);
  });
});

test('invalid App mappings, unsafe metadata and unreadable input signatures never reach effects', async t => {
  const cases = [
    { name: 'unknown target', code: 'INVALID_NODE_MAPPING', mutate: f => { f.request.nodeInfoList[0].fieldName = 'unknown'; } },
    { name: 'duplicate override', code: 'CONFLICTING_NODE_TARGET', mutate: f => { f.request.nodeInfoList.push({ ...f.request.nodeInfoList[0] }); } },
    { name: 'override conflicts with bound target', code: 'CONFLICTING_NODE_TARGET', mutate: f => {
      f.request.nodeInfoList.push({ nodeId: '1', fieldName: 'file-0', fieldValue: 'not-an-upload' });
    } },
    { name: 'duplicate binding', code: 'CONFLICTING_NODE_TARGET', mutate: f => { f.request.bindings.push({ ...f.request.bindings[0] }); } },
    { name: 'missing file binding', code: 'FILE_BINDING_MISSING', mutate: f => { f.request.bindings[0].fileKey = 'missing-file'; } },
    { name: 'malformed metadata', code: 'AI_APP_RESPONSE_UNKNOWN', mutate: f => { f.state.metadata.nodeInfoList[0].fieldValue = false; } },
    { name: 'unsafe metadata target', code: 'AI_APP_RESPONSE_UNKNOWN', mutate: f => { f.state.metadata.nodeInfoList[0].fieldName = '__proto__'; } },
    { name: 'duplicate metadata target', code: 'AI_APP_RESPONSE_UNKNOWN', mutate: f => { f.state.metadata.nodeInfoList.push({ ...f.state.metadata.nodeInfoList[0] }); } },
    { name: 'API secret in persisted source field', code: 'AI_APP_RESPONSE_UNKNOWN', mutate: f => { f.state.metadata.nodeInfoList[0].description = KEY; } },
    { name: 'password in persisted source field', code: 'AI_APP_RESPONSE_UNKNOWN', mutate: f => { f.state.metadata.nodeInfoList[0].descriptionEn = PASSWORD; } },
    { name: 'invalid input signature', code: 'REFERENCE_SIGNATURE_MISMATCH', mutate: f => { f.state.inputs[0] = Buffer.alloc(f.state.inputs[0].length); } },
  ];
  for (const entry of cases) await t.test(entry.name, async child => {
    const f = await appFixture(child, { password: true });
    entry.mutate(f);
    const result = await f.endpoint.start(f.ctx);
    failed(result, entry.code); noEffects(f); publicSafe(result);
  });
});

test('encrypted App requires a resolved Endpoint password before upload or submit', async t => {
  for (const configured of [false, true]) await t.test(configured ? 'configured slot missing actual secret' : 'no configured password', async child => {
    const f = await appFixture(child, { encrypted: true, password: configured });
    if (configured) delete f.ctx.credentials.accessPassword;
    failed(await f.endpoint.start(f.ctx), 'ACCESS_PASSWORD_REQUIRED'); noEffects(f);
  });
  const f = await appFixture(t, { encrypted: true, password: true, instanceType: 'ultra' });
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const call = f.calls.find(call => call.path === '/task/openapi/ai-app/run');
  assert.equal(call.body.accessPassword, PASSWORD); assert.equal(call.body.instanceType, 'ultra');
  assert.equal(call.body.apiKey, KEY);
  const preparation = await (await f.journal('/preparation')).read();
  assert.equal(preparation.preparedBody.accessPassword, undefined);
  publicSafe([started, preparation, await (await f.journal()).read(),
    await (await f.journal(`/uploads/${digest('file-0')}`)).read()]);
});

test('configured password remains reviewed and identity-bound but is not sent for an unencrypted App', async t => {
  const f = await appFixture(t, { password: true });
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.ok(!Object.hasOwn(f.calls.find(call => call.path === '/task/openapi/ai-app/run').body, 'accessPassword'));
  const before = f.calls.length;
  f.ctx.credentials.accessPassword.secret = 'rotated-inert-password';
  failed(await f.endpoint.start(f.ctx), 'JOURNAL_IDENTITY_MISMATCH');
  failed(await f.endpoint.poll({ ...f.ctx, handle: started.handle }), 'TASK_NOT_IN_OPERATION_JOURNAL');
  assert.equal(f.calls.length, before);
});

test('key and password are captured immutably through one logical App attempt', async t => {
  const f = await appFixture(t, { encrypted: true, password: true });
  f.state.onAccount = () => {
    f.ctx.credentials.apiKey.secret = 'rotated-inert-key';
    f.ctx.credentials.accessPassword.secret = 'rotated-inert-password';
    return { code: 0, data: { apiType: 'NORMAL', remainCoins: '100' } };
  };
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  for (const call of f.calls.filter(call => call.path !== '/api/webapp/apiCallDemo')) {
    assert.equal(call.init.headers.authorization, `Bearer ${KEY}`);
  }
  const submit = f.calls.find(call => call.path === '/task/openapi/ai-app/run').body;
  assert.equal(submit.apiKey, KEY); assert.equal(submit.accessPassword, PASSWORD);
  const before = f.calls.length;
  failed(await f.endpoint.start(f.ctx), 'JOURNAL_IDENTITY_MISMATCH');
  assert.equal(f.calls.length, before);
  publicSafe(started);
});

test('App source drift after upload and before submit stops all further submissions', async t => {
  const f = await appFixture(t);
  f.state.onUpload = number => {
    f.state.metadata.nodeInfoList[0].fieldValue = 'changed-after-upload';
    return { code: 0, data: { fileName: `api/input-${number}.png`, fileType: 'input' } };
  };
  failed(await f.endpoint.start(f.ctx), 'AI_APP_REVISION_MISMATCH');
  assert.equal(f.state.uploads, 1); assert.equal(f.state.appSubmits, 0);
  const submit = await (await f.journal()).read();
  assert.equal(submit.attempts.length, 0);
  f.restart();
  failed(await f.endpoint.start(f.ctx), 'AI_APP_REVISION_MISMATCH');
  assert.equal(f.state.uploads, 1); assert.equal(f.state.appSubmits, 0);
});

test('App interface drift before transient retry spends no second submit attempt, including after restart', async t => {
  const f = await appFixture(t, { files: 0 });
  f.state.onSubmit = () => {
    f.state.metadata.nodeInfoList[0].fieldData = 'new-interface-after-transient';
    return new Response('{}', { status: 503 });
  };
  failed(await f.endpoint.start(f.ctx), 'AI_APP_REVISION_MISMATCH');
  assert.equal(f.state.appSubmits, 1);
  assert.equal((await (await f.journal()).read()).attempts.length, 1);
  f.restart();
  failed(await f.endpoint.start(f.ctx), 'AI_APP_REVISION_MISMATCH');
  assert.equal(f.state.appSubmits, 1);
  assert.equal((await (await f.journal()).read()).attempts.length, 1);
});

test('App name, curl and statistics drift are not an interface revision', async t => {
  const f = await appFixture(t, { files: 0 });
  f.state.onMetadata = number => ({ code: 0, data: { ...f.state.metadata, webappName: `Display-name-${number}`,
    statisticsInfo: { visits: number * 100 }, curl: `curl -- ${KEY} ${PASSWORD} ${number}` } });
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.equal((await (await f.journal('/preparation')).read()).appDigest, f.app.appDigest);
  assert.equal(f.state.appSubmits, 1);
});

test('admitted file bytes and private owner review are checked again before effects and retries', async t => {
  await t.test('all files admitted before first upload', async child => {
    const f = await appFixture(child, { files: 2 });
    f.state.inputs[1] = Buffer.alloc(f.state.inputs[1].length);
    failed(await f.endpoint.start(f.ctx), 'REFERENCE_SIGNATURE_MISMATCH'); noEffects(f);
  });
  await t.test('reread bytes cannot change between admission and upload', async child => {
    const f = await appFixture(child);
    f.state.onResource = number => number === 1 ? f.state.inputs[0] : Buffer.concat([PNG, Buffer.from([99])]);
    failed(await f.endpoint.start(f.ctx), 'REFERENCE_CHANGED'); noEffects(f);
  });
  await t.test('bytes cannot change after upload before submit', async child => {
    const f = await appFixture(child);
    f.state.onUpload = () => {
      f.state.inputs[0] = Buffer.concat([PNG, Buffer.from([99])]);
      return { code: 0, data: { fileName: 'api/input.png', fileType: 'input' } };
    };
    failed(await f.endpoint.start(f.ctx), 'REFERENCE_CHANGED');
    assert.equal(f.state.uploads, 1); assert.equal(f.state.appSubmits, 0);
  });
  await t.test('upload retry cannot bypass newly invalid private review', async child => {
    const f = await appFixture(child);
    f.state.onUpload = async () => {
      f.review.humanReview.kind = 'UNREVIEWED_OWNER_MUST_CHECK'; await f.saveReview();
      return new Response('{}', { status: 503 });
    };
    failed(await f.endpoint.start(f.ctx), 'COINS_ONLY_UNVERIFIED');
    assert.equal(f.state.uploads, 1); assert.equal(f.state.appSubmits, 0);
  });
  await t.test('submit retry cannot bypass newly invalid private review', async child => {
    const f = await appFixture(child, { files: 0 });
    f.state.onSubmit = async () => {
      f.review.requestDigest = '0'.repeat(64); await f.saveReview();
      return new Response('{}', { status: 503 });
    };
    failed(await f.endpoint.start(f.ctx), 'MEMBER_BINDING_APP_MISMATCH');
    assert.equal(f.state.appSubmits, 1);
  });
});

test('App ACK resumes offline after provider restart without metadata, account, uploads or another submit', async t => {
  const f = await appFixture(t, { password: true, encrypted: true });
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const preparation = await (await f.journal('/preparation')).read(), submit = await (await f.journal()).read();
  const before = f.calls.length;
  f.state.offline = true; f.state.inputs[0] = Buffer.alloc(f.state.inputs[0].length);
  f.review.humanReview.kind = 'UNREVIEWED_OWNER_MUST_CHECK'; await f.saveReview();
  f.restart();
  const resumed = await f.endpoint.start(f.ctx);
  assert.equal(resumed.status, 'pending', JSON.stringify(resumed));
  assert.deepEqual(resumed.handle, started.handle); assert.deepEqual(resumed.receipt, started.receipt);
  assert.equal(f.calls.length, before);
  assert.deepEqual(await (await f.journal('/preparation')).read(), preparation);
  assert.deepEqual(await (await f.journal()).read(), submit);
});

test('same journal operation cannot change an acknowledged workflow into an App, and handles cannot cross routes', async t => {
  const f = await appFixture(t);
  const workflow = await f.workflowContext();
  const started = await f.workflowEndpoint.start(workflow);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  f.state.onSubmit = () => ({ code: 0, data: { taskId: 'workflow-fixture-task' } });
  const before = f.calls.length;
  failed(await f.endpoint.start(f.ctx), 'JOURNAL_IDENTITY_MISMATCH');
  failed(await f.endpoint.poll({ ...f.ctx, handle: started.handle }), 'HANDLE_MISMATCH');
  failed(await f.endpoint.collect({ ...f.ctx, handle: started.handle }), 'HANDLE_MISMATCH');
  assert.equal(f.calls.length, before); assert.equal(f.state.workflowSubmits, 1); assert.equal(f.state.appSubmits, 0);
  f.ctx.operation = 'independent-app-operation';
  const appStarted = await f.endpoint.start(f.ctx);
  assert.equal(appStarted.status, 'pending', JSON.stringify(appStarted));
  assert.equal(appStarted.receipt.id, started.receipt.id, 'Service ownership must not depend on task ID alone');
  const after = f.calls.length;
  failed(await f.workflowEndpoint.poll({ ...workflow, operation: f.ctx.operation, handle: appStarted.handle }), 'HANDLE_MISMATCH');
  failed(await f.endpoint.poll({ ...f.ctx, operation: 'operation-without-an-ack', handle: appStarted.handle }), 'TASK_NOT_IN_OPERATION_JOURNAL');
  failed(await f.endpoint.collect({ ...f.ctx, handle: { ...appStarted.handle, taskId: 'foreign-task' } }), 'TASK_NOT_IN_OPERATION_JOURNAL');
  assert.equal(f.calls.length, after);
});

test('workflow without new options preserves its prior fingerprint, preparation bytes and handle', async t => {
  const { readFile } = await import('node:fs/promises');
  const f = await appFixture(t, { files: 0 });
  const workflow = await f.workflowContext(), request = workflow.need.constraints;
  const fingerprint = digest({ request, credentialSha256: credentialSha256(KEY), apiKey: f.config.apiKey, baseUrl: f.config.baseUrl });
  const started = await f.workflowEndpoint.start(workflow);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.deepEqual(started.handle, { contract: 'hypit.runninghub.workflow@1', taskId: 'workflow-fixture-task', fingerprint });
  const graph = structuredClone(workflow.graph); graph['1'].inputs.text = 'workflow-chosen';
  const preparedBody = { workflowId: request.workflowId, nodeInfoList: request.nodeInfoList, workflow: JSON.stringify(graph) };
  const expected = { format: 'workflow-preparation@1', fingerprint, state: 'ready', credentialSha256: credentialSha256(KEY),
    apiKeyDigest: digest(f.config.apiKey), baseUrl: f.config.baseUrl, graph: workflow.graph, graphDigest: digest(workflow.graph),
    fileDigests: [], preparedBody, preparedBodyDigest: digest(preparedBody) };
  const journal = await f.journal('/preparation');
  assert.equal(await readFile(journal.file, 'utf8'), JSON.stringify(expected));
  const before = f.calls.length; f.state.offline = true; f.restart();
  assert.deepEqual((await f.workflowEndpoint.start(workflow)).handle, started.handle); assert.equal(f.calls.length, before);
});

test('workflow instanceType and password reach only the native create invocation, never prepared journals', async t => {
  const f = await appFixture(t, { password: true });
  const workflow = await f.workflowContext({ instanceType: 'plus' });
  const started = await f.workflowEndpoint.start(workflow);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const body = f.calls.find(call => call.path === '/task/openapi/create').body;
  assert.equal(body.instanceType, 'plus'); assert.equal(body.accessPassword, PASSWORD); assert.equal(body.apiKey, KEY);
  assert.deepEqual(JSON.parse(body.workflow)['1'].inputs, { text: 'workflow-chosen', untouched: [false, null] });
  const preparation = await (await f.journal('/preparation')).read();
  assert.equal(preparation.preparedBody.instanceType, 'plus');
  assert.ok(!Object.hasOwn(preparation.preparedBody, 'accessPassword')); publicSafe([started, preparation]);
});

test('three transient total attempts remain durable across provider restart for both upload and App submit', async t => {
  for (const action of ['upload', 'submit']) await t.test(action, async child => {
    const f = await appFixture(child, { files: action === 'upload' ? 1 : 0 });
    f.state[action === 'upload' ? 'onUpload' : 'onSubmit'] = () => new Response('{}', { status: 503 });
    f.state.onSleep = () => { delete f.state.onSleep; throw new ProviderError('MOCK_PROCESS_INTERRUPTED'); };
    failed(await f.endpoint.start(f.ctx), 'MOCK_PROCESS_INTERRUPTED');
    const suffix = action === 'upload' ? `/uploads/${digest('file-0')}` : '';
    const interrupted = await (await f.journal(suffix)).read();
    assert.equal(interrupted.state, 'retryable'); assert.equal(interrupted.attempts.length, 1);
    f.restart();
    failed(await f.endpoint.start(f.ctx), 'HTTP_503');
    const exhausted = await (await f.journal(suffix)).read();
    assert.equal(exhausted.state, 'unknown'); assert.equal(exhausted.attempts.length, 3);
    assert.deepEqual(exhausted.attempts.map(attempt => attempt.attempt), [1, 2, 3]);
    const before = f.calls.length; f.restart();
    failed(await f.endpoint.start(f.ctx), 'OUTCOME_UNKNOWN_NO_NEW_SERIES');
    if (action === 'submit') assert.equal(f.calls.length, before);
    assert.equal(action === 'upload' ? f.state.uploads : f.state.appSubmits, 3);
    if (action === 'upload') assert.equal(f.state.appSubmits, 0);
  });
});

test('unknown App acknowledgement and interrupted in-flight journal cannot open a new submit series', async t => {
  const f = await appFixture(t, { files: 0 });
  f.state.onSubmit = () => ({ code: 0, data: {} });
  failed(await f.endpoint.start(f.ctx), 'SUBMIT_RESPONSE_UNKNOWN');
  assert.equal(f.state.appSubmits, 1);
  const journal = await f.journal(), saved = await journal.read();
  assert.equal(saved.attempts.length, 1); assert.deepEqual(saved.taskIds, []);
  const before = f.calls.length;
  f.restart();
  failed(await f.endpoint.start(f.ctx), 'OUTCOME_UNKNOWN_NO_NEW_SERIES');
  assert.equal(f.calls.length, before);
  // Represent a restart after durable intent but before an ACK could be saved.
  saved.state = 'in-flight'; saved.attempts[0].outcome = 'in-flight';
  delete saved.attempts[0].finishedAt; delete saved.attempts[0].error;
  await journal.write(saved);
  f.restart();
  failed(await f.endpoint.start(f.ctx), 'OUTCOME_UNKNOWN_NO_NEW_SERIES');
  assert.equal(f.calls.length, before); assert.equal(f.state.appSubmits, 1);
});

test('an App ACK carried by a transient response immediately stops retries and is resumable offline', async t => {
  const f = await appFixture(t, { files: 0 });
  f.state.onSubmit = () => ({ code: 415, msg: `ignored ${KEY} ${PASSWORD}`, data: { taskId: 'ack-before-error' } });
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.equal(started.receipt.id, 'ack-before-error'); assert.equal(f.state.appSubmits, 1);
  const before = f.calls.length; f.state.offline = true; f.restart();
  const resumed = await f.endpoint.start(f.ctx);
  assert.deepEqual(resumed.handle, started.handle); assert.equal(f.calls.length, before); publicSafe([started, resumed]);
});

test('wrong App password or tier is terminal with no fallback or replacement retry budget', async t => {
  const f = await appFixture(t, { encrypted: true, password: true, instanceType: 'ultra' });
  f.state.onSubmit = () => ({ code: 805, msg: `password rejected ${PASSWORD}; key ${KEY}; /api/webapp/apiCallDemo?apiKey=${KEY}` });
  const result = await f.endpoint.start(f.ctx);
  failed(result, 'UPSTREAM_BUSINESS_ERROR'); publicSafe(result);
  assert.equal(f.state.appSubmits, 1);
  const before = f.calls.length; f.restart();
  failed(await f.endpoint.start(f.ctx), 'OUTCOME_UNKNOWN_NO_NEW_SERIES');
  assert.equal(f.calls.length, before);
  f.request.instanceType = 'default'; f.ctx.credentials.accessPassword.secret = 'rotated-inert-password';
  failed(await f.endpoint.start(f.ctx), 'JOURNAL_IDENTITY_MISMATCH');
  assert.equal(f.calls.length, before); assert.equal(f.state.appSubmits, 1);
});

test('metadata upstream errors never publish the query URL, curl, key or password echoes', async t => {
  const f = await appFixture(t, { password: true });
  f.state.onMetadata = () => ({ code: 805, msg: `curl -- ${KEY} ${PASSWORD} https://www.runninghub.ai/api/webapp/apiCallDemo?apiKey=${KEY}` });
  const result = await f.endpoint.start(f.ctx);
  failed(result, 'UPSTREAM_BUSINESS_ERROR'); publicSafe(result); noEffects(f);
  publicSafe(await (await f.journal('/preparation')).read());
});

test('CREATE is pending and CANCEL is terminal, both with receipts and private raw observations', async t => {
  const f = await appFixture(t, { files: 0 });
  const started = await f.endpoint.start(f.ctx);
  let query = { taskId: 'app-fixture-task', status: 'CREATE' };
  f.state.onQuery = () => query;
  const pending = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
  assert.equal(pending.status, 'pending', JSON.stringify(pending)); assert.deepEqual(pending.handle, started.handle);
  assert.deepEqual(pending.receipt, started.receipt); assert.ok(pending.wakeAt > f.clock.now());
  assert.deepEqual((await (await f.journal('/observations')).read()).response, query);
  query = { taskId: 'app-fixture-task', status: 'CANCEL' };
  const cancelled = await f.endpoint.poll({ ...f.ctx, handle: pending.handle });
  failed(cancelled, 'REMOTE_TASK_CANCELLED'); assert.deepEqual(cancelled.receipt, started.receipt);
  assert.deepEqual((await (await f.journal('/observations')).read()).response, query);
  assert.equal(f.state.downloads, 0); assert.equal(f.writes.length, 0); publicSafe([pending, cancelled]);
});

test('Money guards preserve exact private evidence before failure and make results uncollectable', async t => {
  for (const field of ['consumeMoney', 'thirdPartyConsumeMoney']) await t.test(field, async child => {
    const f = await appFixture(child, { files: 0, password: true });
    const started = await f.endpoint.start(f.ctx);
    const query = { taskId: 'app-fixture-task', status: 'SUCCESS', usage: { [field]: '0.01', consumeCoins: '5' },
      results: [{ url: 'https://cdn.example.invalid/files/0?signature=PRIVATE_SIGNED_OUTPUT_0', outputType: 'png', echo: `${KEY} ${PASSWORD}` }] };
    f.state.onQuery = () => query;
    const result = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    failed(result, 'BILLING_MISMATCH'); assert.deepEqual(result.receipt, started.receipt); publicSafe(result);
    const observation = (await (await f.journal('/observations')).read()).response;
    assert.deepEqual(observation, { ...query, results: [{ ...query.results[0], echo: '[redacted]' }] });
    assert.ok(!JSON.stringify(observation).includes(KEY)); assert.ok(!JSON.stringify(observation).includes(PASSWORD));
    failed(await f.endpoint.collect({ ...f.ctx, handle: started.handle }), 'BILLING_MISMATCH');
    assert.equal(f.state.downloads, 0); assert.equal(f.writes.length, 0);
  });
});

test('password and key echoes in query errors and output metadata are sanitized without losing files', async t => {
  await t.test('query business error keeps receipt and raw private response', async child => {
    const f = await appFixture(child, { files: 0, password: true });
    const started = await f.endpoint.start(f.ctx);
    const query = { taskId: 'app-fixture-task', status: 'FAILED', errorCode: '805',
      errorMessage: `${KEY} ${PASSWORD} https://private.invalid/PRIVATE_SIGNED_OUTPUT`, results: [] };
    f.state.onQuery = () => query;
    const result = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    failed(result, 'UPSTREAM_BUSINESS_ERROR'); assert.deepEqual(result.receipt, started.receipt); publicSafe(result);
    const observation = (await (await f.journal('/observations')).read()).response;
    assert.deepEqual(observation, { ...query, errorMessage: '[redacted]' });
    assert.ok(!JSON.stringify(observation).includes(KEY)); assert.ok(!JSON.stringify(observation).includes(PASSWORD));
    assert.equal(f.state.downloads, 0);
  });
  await t.test('both secrets and URL output types redact, safe metadata survives', async child => {
    const items = mixedOutputs.slice(0, 3).map((item, index) => ({ ...item,
      outputType: [KEY, PASSWORD, 'https://private.invalid/PRIVATE_SIGNED_OUTPUT'][index] }));
    const f = await appFixture(child, { files: 0, password: true, items });
    const started = await f.endpoint.start(f.ctx);
    f.state.onQuery = () => ({ taskId: 'app-fixture-task', status: 'SUCCESS', results: items.map((item, index) => ({
      url: `https://cdn.example.invalid/files/${index}?signature=PRIVATE_SIGNED_OUTPUT_${index}`, outputType: item.outputType,
      safe: { literal: [false, null, 'ok'], nested: { arbitraryKey: KEY, arbitraryPassword: PASSWORD } },
      [KEY]: 'key must not leak through a property name', [PASSWORD]: 'password must not leak through a property name', loose: `${KEY}:${PASSWORD}`,
    })) });
    const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.deepEqual(completed.result.value.value.outputs.map(output => output.outputType), ['[redacted]', '[redacted]', '[redacted]']);
    for (const [index, item] of items.entries()) {
      assert.deepEqual(f.writes[index].bytes, item.bytes);
      assert.deepEqual(completed.result.value.value.outputs[index].metadata.safe.literal, [false, null, 'ok']);
    }
    publicSafe(completed);
  });
});

test('credential literals cannot enter request, source, upload filename or task ID journals', async t => {
  for (const secret of [KEY, PASSWORD]) await t.test(secret === KEY ? 'API key' : 'password', async child => {
    await child.test('selected input value', async leaf => {
      const f = await appFixture(leaf, { password: true });
      f.request.nodeInfoList[0].fieldValue = { literal: secret };
      const result = await f.endpoint.start(f.ctx);
      failed(result, 'CREDENTIAL_IN_OPERATION_INPUT'); noEffects(f); publicSafe(result);
      assert.equal(await (await f.journal('/preparation')).read(), undefined);
    });
    await child.test('uploaded filename echo', async leaf => {
      const f = await appFixture(leaf, { password: true });
      f.state.onUpload = () => ({ code: 0, data: { fileName: `api/${secret}.png`, fileType: 'input' } });
      const result = await f.endpoint.start(f.ctx);
      failed(result, 'UPLOAD_RESPONSE_UNKNOWN'); assert.equal(f.state.appSubmits, 0); publicSafe(result);
      publicSafe([await (await f.journal('/preparation')).read(),
        await (await f.journal(`/uploads/${digest('file-0')}`)).read()]);
    });
    await child.test('task ID echo', async leaf => {
      const f = await appFixture(leaf, { files: 0, password: true });
      f.state.onSubmit = () => ({ code: 0, data: { taskId: secret } });
      const result = await f.endpoint.start(f.ctx);
      failed(result, 'SUBMIT_RESPONSE_UNKNOWN'); assert.equal(result.receipt, undefined); publicSafe(result);
      assert.equal(f.state.appSubmits, 1);
      publicSafe(await (await f.journal()).read());
    });
  });
});

test('prepared body tampering cannot bypass wire identity even when its stored digest is recomputed', async t => {
  for (const recompute of [false, true]) await t.test(recompute ? 'recomputed body digest' : 'stale body digest', async child => {
    const f = await appFixture(child);
    const started = await f.endpoint.start(f.ctx);
    assert.equal(started.status, 'pending', JSON.stringify(started));
    const journal = await f.journal('/preparation'), preparation = await journal.read();
    preparation.preparedBody.nodeInfoList[0].fieldValue = 'not-the-admitted-request';
    if (recompute) preparation.preparedBodyDigest = digest(preparation.preparedBody);
    await journal.write(preparation);
    const before = f.calls.length; f.state.offline = true; f.restart();
    failed(await f.endpoint.start(f.ctx), 'PREPARATION_IDENTITY_MISMATCH');
    failed(await f.endpoint.poll({ ...f.ctx, handle: started.handle }), 'PREPARATION_IDENTITY_MISMATCH');
    assert.equal(f.calls.length, before);
  });
});

test('App polling budgets survive restart and preserve task receipts on deadline or transient exhaustion', async t => {
  await t.test('elapsed deadline', async child => {
    const f = await appFixture(child, { files: 0 });
    const started = await f.endpoint.start(f.ctx);
    f.state.onQuery = () => ({ taskId: 'app-fixture-task', status: 'CREATE' });
    const pending = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    assert.equal(pending.status, 'pending', JSON.stringify(pending));
    const budget = await (await f.journal('/poll')).read(), before = f.calls.length;
    f.state.now = budget.startedAt + f.config.polling.maxElapsedMs; f.restart();
    const result = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    failed(result, 'POLL_DEADLINE_EXCEEDED'); assert.deepEqual(result.receipt, started.receipt);
    assert.equal(f.calls.length, before); publicSafe(result);
  });
  await t.test('consecutive transient failures', async child => {
    const f = await appFixture(child, { files: 0 });
    const started = await f.endpoint.start(f.ctx);
    f.state.onQuery = () => new Response('{}', { status: 503 });
    const limit = f.config.polling.maxConsecutiveTransientFailures;
    for (let number = 1; number < limit; number++) {
      f.restart();
      const pending = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
      assert.equal(pending.status, 'pending', JSON.stringify(pending)); assert.deepEqual(pending.receipt, started.receipt);
      f.state.now = pending.wakeAt;
    }
    f.restart();
    const exhausted = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    failed(exhausted, 'POLL_FAILURE_LIMIT'); assert.deepEqual(exhausted.receipt, started.receipt);
    assert.equal(f.state.queryReads, limit);
    const before = f.calls.length;
    failed(await f.endpoint.poll({ ...f.ctx, handle: started.handle }), 'POLL_FAILURE_LIMIT');
    assert.equal(f.calls.length, before); assert.equal(f.state.downloads, 0);
  });
});

test('malformed usage cannot mask Money or revive previously ready results across restart', async t => {
  const usages = [
    { consumeCoins: 1, thirdPartyConsumeMoney: '0.01' },
    { thirdPartyConsumeMoney: '0.01', consumeCoins: 1 },
    { thirdPartyConsumeMoney: false, consumeMoney: '0.01' },
    { consumeMoney: '0.01', thirdPartyConsumeMoney: false },
  ];
  for (const [index, usage] of usages.entries()) await t.test(`usage ordering ${index}`, async child => {
    const f = await appFixture(child);
    const started = await f.endpoint.start(f.ctx);
    assert.equal(started.status, 'pending', JSON.stringify(started));
    const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    const query = { taskId: started.handle.taskId, status: 'SUCCESS', results: [], usage };
    f.state.onQuery = () => query;
    const rejected = await f.endpoint.poll({ ...f.ctx, handle: ready.handle });
    assert.equal(rejected.status, 'failed', JSON.stringify(rejected));
    assert.ok(['BILLING_USAGE_UNKNOWN', 'BILLING_MISMATCH'].includes(rejected.failure.code), JSON.stringify(rejected));
    assert.deepEqual(rejected.receipt, started.receipt);
    const evidence = await (await f.journal('/observations')).read();
    assert.deepEqual(evidence.response, query); assert.equal(evidence.billingViolation, true);
    f.restart(); f.state.offline = true;
    const before = f.calls.length;
    failed(await f.endpoint.collect({ ...f.ctx, handle: ready.handle }), 'BILLING_MISMATCH');
    failed(await f.endpoint.poll({ ...f.ctx, handle: ready.handle }), 'BILLING_MISMATCH');
    assert.equal(f.calls.length, before);
    assert.equal(f.state.downloads, 0); assert.deepEqual(f.writes, []);
  });
});

test('App metadata changes during blocking submit admission cannot reach submit', async t => {
  await t.test('parameterless-file admission account preflight', async child => {
    const f = await appFixture(child, { files: 0 });
    f.state.onAccount = number => {
      if (number === 2) f.state.metadata.nodeInfoList[0].fieldData = 'changed-during-submit-account';
      return { code: 0, data: { apiType: 'NORMAL', remainCoins: '100' } };
    };
    failed(await f.endpoint.start(f.ctx), 'AI_APP_REVISION_MISMATCH');
    noEffects(f);
  });
  await t.test('file reread after submit account preflight', async child => {
    const f = await appFixture(child);
    let submitAccountFinished = false, mutated = false;
    f.state.onAccount = () => {
      if (f.state.uploads > 0) submitAccountFinished = true;
      return { code: 0, data: { apiType: 'NORMAL', remainCoins: '100' } };
    };
    f.state.onResource = (_number, index) => {
      if (submitAccountFinished) {
        mutated = true;
        f.state.metadata.nodeInfoList[0].fieldData = 'changed-during-final-file-reread';
      }
      return f.state.inputs[index];
    };
    failed(await f.endpoint.start(f.ctx), 'AI_APP_REVISION_MISMATCH');
    assert.equal(mutated, true); assert.equal(f.state.uploads, 1); assert.equal(f.state.appSubmits, 0);
    assert.equal(f.state.downloads, 0);
  });
});

test('signed URL property names in nested metadata never enter public results', async t => {
  const f = await appFixture(t, { files: 0, items: mixedOutputs.slice(0, 1) });
  const started = await f.endpoint.start(f.ctx);
  const signed = 'https://private.invalid/output?signature=PRIVATE_SIGNED_OUTPUT_PROPERTY';
  f.state.onQuery = () => ({ taskId: started.handle.taskId, status: 'SUCCESS', results: [{
    url: 'https://cdn.example.invalid/files/0?signature=PRIVATE_SIGNED_OUTPUT_0', outputType: 'png',
    nested: { [signed]: 'sensitive-key', safeFlag: true },
    entries: [{ [signed]: false, safeFlag: false }, { safeFlag: true }],
  }] });
  const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  publicSafe([started, ready, completed], [signed]);
  const metadata = completed.result.value.value.outputs[0].metadata;
  assert.equal(metadata.nested.safeFlag, true);
  assert.deepEqual(metadata.entries.map(entry => entry.safeFlag), [false, true]);
  assert.deepEqual(f.writes[0].bytes, mixedOutputs[0].bytes);
});

test('static protocol strings do not collide with an approved runninghub password', async t => {
  for (const encrypted of [true, false]) await t.test(encrypted ? 'encrypted App' : 'unencrypted App', async child => {
    const f = await appFixture(child, { password: 'runninghub', encrypted, files: 0 });
    const started = await f.endpoint.start(f.ctx);
    assert.equal(started.status, 'pending', JSON.stringify(started));
    const body = f.calls.find(call => call.path === '/task/openapi/ai-app/run').body;
    if (encrypted) assert.equal(body.accessPassword, 'runninghub');
    else assert.ok(!Object.hasOwn(body, 'accessPassword'));
    const before = f.calls.length;
    f.restart(); f.state.offline = true;
    const resumed = await f.endpoint.start(f.ctx);
    assert.equal(resumed.status, 'pending', JSON.stringify(resumed));
    assert.deepEqual(resumed.handle, started.handle); assert.equal(f.calls.length, before);
    f.state.offline = false;
    const ready = await f.endpoint.poll({ ...f.ctx, handle: resumed.handle });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    for (const output of completed.result.value.value.outputs) assert.ok(!JSON.stringify(output.metadata).includes('runninghub'));
    assert.ok(!Object.hasOwn((await (await f.journal('/preparation')).read()).preparedBody, 'accessPassword'));
  });
  await t.test('Workflow invocation', async child => {
    const f = await appFixture(child, { password: 'runninghub', files: 0 });
    const workflow = await f.workflowContext();
    const started = await f.workflowEndpoint.start(workflow);
    assert.equal(started.status, 'pending', JSON.stringify(started));
    assert.equal(f.calls.find(call => call.path === '/task/openapi/create').body.accessPassword, 'runninghub');
    const ready = await f.workflowEndpoint.poll({ ...workflow, handle: started.handle });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    assert.equal((await f.workflowEndpoint.collect({ ...workflow, handle: ready.handle })).status, 'completed');
  });
  await t.test('short password without editable-value collisions', async child => {
    const f = await appFixture(child, { password: '1', encrypted: true, parameterless: true, items: [] });
    const started = await f.endpoint.start(f.ctx);
    assert.equal(started.status, 'pending', JSON.stringify(started));
    assert.equal(f.calls.find(call => call.path === '/task/openapi/ai-app/run').body.accessPassword, '1');
    const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.deepEqual(completed.result.value.value.outputs, []);
  });
});

test('App execution accepts endpoint HTTP limits across the config@2 range', async t => {
  const f = await appFixture(t, { parameterless: true, items: [] });
  f.config.http.requestTimeoutMs = 300001;
  f.config.http.maxResponseBytes = 1023;
  f.restart();
  assert.equal(f.settings.supports(f.ctx.need).status, 'supported');
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.equal(f.state.appSubmits, 1);
});

test('standalone App fetch validates shared HTTP boundaries before bounded response handling', async () => {
  const { fetchAiApp } = await import('../ai-app/document.js');
  const config = { format: 'hypit-runninghub.ai-app-fetch@1', baseUrl: 'https://www.runninghub.ai', webappId: id,
    apiKey: { store: 'fixture', key: 'fixture' }, requestTimeoutMs: 600000, maxResponseBytes: 1023 };
  let calls = 0;
  const deps = { resolveCredential: () => KEY, clock: { timeout: () => ({ signal: new AbortController().signal, cancel() {} }) }, fetch: async () => {
    calls++; return json({ code: 0, data: { webappName: 'Small App', accessEncrypted: false, nodeInfoList: [] } });
  } };
  for (const requestTimeoutMs of [300001, 600000, 1]) {
    assert.equal((await fetchAiApp({ ...config, requestTimeoutMs }, deps)).webappId, id);
  }
  const beforeMinimum = calls;
  await assert.rejects(fetchAiApp({ ...config, maxResponseBytes: 1 }, deps), { code: 'RESPONSE_TOO_LARGE' });
  assert.equal(calls, beforeMinimum + 1, 'Minimum byte budget is valid and reaches the bounded transport');
  for (const change of [{ requestTimeoutMs: 0 }, { requestTimeoutMs: 600001 }, { maxResponseBytes: 0 }, { maxResponseBytes: 16777217 }]) {
    const before = calls;
    await assert.rejects(fetchAiApp({ ...config, ...change }, deps), { code: 'INVALID_FETCH_CONFIG' });
    assert.equal(calls, before);
  }
});

test('Money denial survives redacted observation overflow and provider restart', async t => {
  const f = await appFixture(t, { password: '1', encrypted: true, parameterless: true, items: mixedOutputs.slice(0, 1) });
  f.config.budgets.maxRequestBytes = 1024;
  f.config.http.maxResponseBytes = 262144;
  f.config.budgets.maxJournalBytes = 589824;
  f.restart();
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const ctx = { ...f.ctx, handle: started.handle };
  assert.equal((await f.endpoint.poll(ctx)).status, 'ready');
  f.state.onQuery = () => ({ taskId: started.handle.taskId, status: 'SUCCESS', results: [],
    usage: { thirdPartyConsumeMoney: '0.01', consumeCoins: 1 }, echo: Array(60000).fill('1') });
  failed(await f.endpoint.poll(ctx), 'JOURNAL_TOO_LARGE');
  const observation = await (await f.journal('/observations')).read();
  assert.equal(observation.billingViolation, true);
  f.restart(); f.state.offline = true;
  const before = f.calls.length;
  failed(await f.endpoint.collect(ctx), 'BILLING_MISMATCH');
  failed(await f.endpoint.poll(ctx), 'BILLING_MISMATCH');
  assert.equal(f.calls.length, before); assert.equal(f.state.downloads, 0); assert.deepEqual(f.writes, []);
});

test('download MIME credential echoes are rejected before ResourceStore writes', async t => {
  const f = await appFixture(t, { password: 'inert-password-82', encrypted: true, parameterless: true,
    items: [{ outputType: 'bin', mime: 'application/x-inert-password-82', bytes: Buffer.from('inert') }] });
  const started = await f.endpoint.start(f.ctx), ctx = { ...f.ctx, handle: started.handle };
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.equal((await f.endpoint.poll(ctx)).status, 'ready');
  const result = await f.endpoint.collect(ctx);
  failed(result, 'UNSAFE_RESULT_MIME'); publicSafe(result, ['inert-password-82']);
  assert.deepEqual(f.writes, []);
});

test('observed Money is terminal even when the query response has transient HTTP status', async t => {
  const f = await appFixture(t, { parameterless: true, items: [] });
  const started = await f.endpoint.start(f.ctx), ctx = { ...f.ctx, handle: started.handle };
  const query = { code: 0, taskId: started.handle.taskId, status: 'SUCCESS', results: [], usage: { consumeMoney: '0.01' } };
  f.state.onQuery = () => new Response(JSON.stringify(query), { status: 429 });
  const result = await f.endpoint.poll(ctx);
  failed(result, 'BILLING_MISMATCH'); assert.deepEqual(result.receipt, started.receipt);
  assert.deepEqual((await (await f.journal('/observations')).read()).response, query);
  assert.equal(f.state.queryReads, 1);
  failed(await f.endpoint.collect(ctx), 'BILLING_MISMATCH');
  assert.equal(f.state.downloads, 0); assert.deepEqual(f.writes, []);
});

test('input mutation during final App metadata refresh blocks the submit', async t => {
  const f = await appFixture(t);
  let submitAdmission = false, mutated = false;
  f.state.onAccount = () => {
    if (f.state.uploads > 0) submitAdmission = true;
    return { code: 0, data: { apiType: 'NORMAL', remainCoins: '100' } };
  };
  f.state.onMetadata = () => {
    if (submitAdmission) {
      mutated = true; f.state.inputs[0] = Buffer.concat([PNG, Buffer.from([99])]);
    }
    return { code: 0, data: f.state.metadata };
  };
  failed(await f.endpoint.start(f.ctx), 'REFERENCE_CHANGED');
  assert.equal(mutated, true); assert.equal(f.state.uploads, 1); assert.equal(f.state.appSubmits, 0);
  assert.equal(f.state.downloads, 0);
});

test('final review expiry is enforced with a fresh clock sample after the private read', async t => {
  const f = await appFixture(t, { files: 0 });
  let tightened = false;
  f.state.onMetadata = async () => {
    if (f.state.accountReads >= 2) {
      tightened = true; f.review.expiresAt = new Date(2000).toISOString(); await f.saveReview();
      let samples = 0; f.clock.now = () => ++samples === 1 ? 1999 : 3000;
    }
    return { code: 0, data: f.state.metadata };
  };
  failed(await f.endpoint.start(f.ctx), 'MEMBER_BINDING_EXPIRED');
  assert.equal(tightened, true); noEffects(f);
});

test('Workflow ACK resumes read-only while the original checkpoint holds both journals', { timeout: 10000 }, async t => {
  const f = await appFixture(t, { files: 0 }), ctx = await f.workflowContext();
  let reachedCheckpoint, releaseCheckpoint;
  const entered = new Promise(resolve => { reachedCheckpoint = resolve; });
  const held = new Promise(resolve => { releaseCheckpoint = resolve; });
  ctx.checkpoint = async () => { reachedCheckpoint(); await held; };
  const original = f.workflowEndpoint.start(ctx);
  try {
    await entered;
    const before = f.calls.length, checkpoints = [];
    const resumed = await f.workflowEndpoint.start({ ...ctx, checkpoint: async value => { checkpoints.push(value); } });
    assert.equal(resumed.status, 'pending', JSON.stringify(resumed));
    assert.deepEqual(resumed.receipt, { id: 'workflow-fixture-task' });
    assert.deepEqual(checkpoints, [{ handle: resumed.handle, receipt: resumed.receipt }]);
    assert.equal(f.calls.length, before);
  } finally {
    releaseCheckpoint(); await original;
  }
});

test('Workflow post-account review read cannot outlive its tightened approval', async t => {
  const f = await appFixture(t, { files: 0 }), ctx = await f.workflowContext();
  let tightened = false;
  f.state.onAccount = async number => {
    if (number === 2) {
      tightened = true; ctx.review.expiresAt = new Date(2000).toISOString();
      await f.saveReview(ctx.review, ctx.need.constraints.review);
      let samples = 0; f.clock.now = () => ++samples <= 3 ? 1999 : 3000;
    }
    return { code: 0, data: { apiType: 'NORMAL', remainCoins: '100' } };
  };
  failed(await f.workflowEndpoint.start(ctx), 'MEMBER_BINDING_EXPIRED');
  assert.equal(tightened, true); noEffects(f);
});
