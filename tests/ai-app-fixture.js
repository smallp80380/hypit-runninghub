import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkflowProvider } from '../generic/provider.js';
import { workflowCapability, workflowTypes } from '../generic/references.js';
import { aiAppCapability } from '../ai-app/model.js';
import { aiAppRequestDigest } from '../ai-app/request.js';
import { requestDigest } from '../generic/request.js';
import { digest } from '../native/descriptor.js';
import { credentialSha256, MEMBER_CONTRACT_SHA256 } from '../native/member-binding.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { openJournal } from '../core/journal.js';

export const APP_ID = '1937084629516193794';
export const KEY = 'inert-app-key-no-live-authority';
export const PASSWORD = 'inert-app-password-no-live-authority';
export const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const node = (fieldName, fieldValue = '') => ({ nodeId: '1', nodeName: 'Literal interface', fieldName, fieldValue,
  fieldData: 'LIST:literal-data-not-a-universal-schema', fieldType: 'STRING', description: '', descriptionEn: '' });
export const mixedOutputs = [
  { outputType: 'png', mime: 'image/png', bytes: PNG },
  { outputType: 'wav', mime: 'audio/wav', bytes: Buffer.from('RIFF0000WAVEfixture') },
  { outputType: 'mp4', mime: 'video/mp4', bytes: Buffer.from('0000ftypisomfixture') },
  { outputType: 'unregistered-binary', mime: 'application/octet-stream', bytes: Buffer.from([0, 255, 1, 128]) },
  { outputType: 'txt', mime: 'text/plain', bytes: Buffer.from('literal text file\nnot an inline result\n') },
];
const original = JSON.parse(await readFile(new URL('../examples/generic-config.json', import.meta.url)));
const instance = 'app-and-workflow-account';

export function failed(result, code) {
  assert.equal(result.status, 'failed', JSON.stringify(result));
  assert.equal(result.failure.code, code, JSON.stringify(result));
}
export function noEffects(f) {
  assert.equal(f.state.uploads, 0);
  assert.equal(f.state.appSubmits, 0);
  assert.equal(f.state.workflowSubmits, 0);
  assert.equal(f.state.downloads, 0);
  assert.equal(f.writes.length, 0);
}
export function publicSafe(value, extra = []) {
  const text = JSON.stringify(value);
  for (const forbidden of [KEY, PASSWORD, '/api/webapp/apiCallDemo', 'PRIVATE_SIGNED_OUTPUT', 'curl --', ...extra]) {
    assert.ok(!text.includes(forbidden), `Public result leaked ${forbidden}`);
  }
}

export async function appFixture(t, options = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'rh-app-execution-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const password = typeof options.password === 'string' ? options.password : PASSWORD;
  const config = { ...structuredClone(original), keyType: 'Consumer-Member', submissionEnabled: true,
    ...(options.password ? { accessPassword: { store: 'fixture', key: 'app-password' } } : {}) };
  config.http.allowedDownloadHosts = ['cdn.example.invalid'];
  const count = options.files ?? (options.parameterless ? 0 : 1);
  const inputs = Array.from({ length: count }, (_, i) => Buffer.concat([PNG, Buffer.from([i])]));
  const metadata = { webappName: 'Unregistered opaque App', accessEncrypted: Boolean(options.encrypted),
    nodeInfoList: options.parameterless ? [] : [node('text', 'default'), ...inputs.map((_, i) => node(`file-${i}`))],
    curl: `curl --header 'Authorization: Bearer ${KEY}' --data '${PASSWORD}'`, statisticsInfo: { visits: 1 } };
  const content = { baseUrl: config.baseUrl, webappId: APP_ID, accessEncrypted: metadata.accessEncrypted, nodeInfoList: metadata.nodeInfoList };
  const app = { format: 'hypit-runninghub.ai-app-document@1', ...structuredClone(content), webappName: metadata.webappName, appDigest: digest(content) };
  const request = { format: 'hypit-runninghub.ai-app-request@1', webappId: APP_ID,
    nodeInfoList: options.parameterless ? [] : [{ nodeId: '1', fieldName: 'text', fieldValue: { literal: [false, null, 0, '01'] } }],
    files: inputs.map((bytes, i) => ({ key: `file-${i}`, blob: { kind: 'blob', resource: options.resourceIds?.[i] ?? `res_input_${i}`, size: bytes.length, mediaType: 'image/png' } })),
    bindings: inputs.map((_, i) => ({ fileKey: `file-${i}`, nodeId: '1', fieldName: `file-${i}` })),
    review: 'reviews/app.json', ...(options.instanceType === undefined ? {} : { instanceType: options.instanceType }) };
  const review = { format: 'REVIEWED_AI_APP_OPERATION@1', credential: { reference: config.apiKey, sha256: credentialSha256(KEY) },
    ...(options.password ? { accessPasswordCredential: { reference: config.accessPassword, sha256: credentialSha256(password) } } : {}),
    baseUrl: config.baseUrl, requestDigest: aiAppRequestDigest(request), appDigest: app.appDigest,
    fileDigests: inputs.map((bytes, i) => ({ key: `file-${i}`, sha256: sha256(bytes) })), scope: 'reviewed-ai-app-only-no-external-money',
    source: { url: MEMBERSHIP_SOURCE, noteSha256: MEMBER_CONTRACT_SHA256 },
    humanReview: { kind: 'project-owner-reviewed-membership-key-and-ai-app', recordId: 'SYNTHETIC_NO_LIVE_AUTHORITY', reviewer: 'MOCK_ONLY', reviewedAt: new Date(0).toISOString() },
    expiresAt: new Date(86400000).toISOString() };
  await mkdir(join(dataRoot, 'reviews'), { mode: 0o700 });
  const saveReview = (record = review, path = request.review) => writeFile(join(dataRoot, path), JSON.stringify(record), { mode: 0o600 });
  await saveReview();
  const items = options.items ?? mixedOutputs;
  const state = { metadata, inputs, items, offline: false, accountType: 'NORMAL', uploads: 0, appSubmits: 0, workflowSubmits: 0,
    metadataReads: 0, accountReads: 0, queryReads: 0, downloads: 0, resourceReads: 0, now: 1000 };
  const calls = [], writes = [], violations = [];
  t.after(() => assert.deepEqual(violations, [], 'Mock rejected an unexpected HTTP request'));
  const clock = { now: () => state.now, sleep: async ms => { if (state.onSleep) await state.onSleep(ms); state.now += ms; },
    timeout: () => ({ signal: new AbortController().signal, cancel() {} }) };
  const results = () => items.map((item, i) => ({ url: `https://cdn.example.invalid/files/${i}?signature=PRIVATE_SIGNED_OUTPUT_${i}`,
    outputType: item.outputType, order: i, literal: [false, null], echoKey: KEY, ...(options.password ? { echoPassword: password } : {}) }));
  async function fetch(url, init) {
    let parsed, body, route;
    try {
      parsed = new URL(url);
      assert.equal(parsed.username, ''); assert.equal(parsed.password, ''); assert.equal(parsed.port, ''); assert.equal(parsed.hash, '');
      assert.equal(init.redirect, 'error');
      if (parsed.origin === 'https://cdn.example.invalid') {
        assert.equal(init.headers, undefined, 'Download hosts must not receive credential headers');
        assert.equal(init.body, undefined);
        assert.equal(init.method, undefined);
        assert.match(parsed.pathname, /^\/files\/\d+$/);
        const index = Number(parsed.pathname.split('/').at(-1));
        assert.ok(items[index], 'Unexpected output download');
        assert.equal(parsed.search, `?signature=PRIVATE_SIGNED_OUTPUT_${index}`);
        route = 'download';
      } else {
        assert.equal(parsed.origin, new URL(config.baseUrl).origin, 'Only the configured RunningHub origin may be contacted');
        const auth = init.headers?.authorization;
        assert.ok(typeof auth === 'string' && auth.startsWith('Bearer '));
        const key = auth.slice(7);
        assert.ok([KEY, 'rotated-inert-key'].includes(key), 'Only fixture credentials may be used');
        assert.ok(['/api/webapp/apiCallDemo', '/uc/openapi/accountStatus', '/task/openapi/upload', '/task/openapi/ai-app/run', '/task/openapi/create', '/openapi/v2/query', '/api/openapi/getJsonApiFormat'].includes(parsed.pathname));
        route = parsed.pathname;
        if (route === '/api/webapp/apiCallDemo') {
          assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
          assert.deepEqual([...parsed.searchParams.keys()].sort(), ['apiKey', 'webappId']);
          assert.equal(parsed.searchParams.get('apiKey'), key); assert.equal(parsed.searchParams.get('webappId'), APP_ID);
        } else {
          assert.equal(init.method, 'POST'); assert.equal(parsed.search, '');
          if (route === '/task/openapi/upload') {
            assert.ok(init.body instanceof FormData);
            assert.deepEqual([...init.body.keys()].sort(), ['apiKey', 'file', 'fileType']);
            assert.equal(init.body.get('apiKey'), key); assert.equal(init.body.get('fileType'), 'input');
          } else {
            body = JSON.parse(init.body);
            if (route === '/uc/openapi/accountStatus') assert.deepEqual(body, { apikey: key });
            else if (route === '/openapi/v2/query') assert.deepEqual(Object.keys(body), ['taskId']);
            else {
              assert.equal(body.apiKey, key);
              if (route === '/task/openapi/ai-app/run') {
                assert.equal(body.webappId, APP_ID);
                assert.ok(Object.keys(body).every(name => ['apiKey', 'webappId', 'nodeInfoList', 'instanceType', 'accessPassword'].includes(name)), 'App submits must not contain workflow or metadata fields');
              }
            }
          }
        }
      }
    } catch (error) { violations.push(error.message); throw error; }
    const call = { url, init, path: parsed.pathname, body }; calls.push(call);
    if (state.offline) throw new TypeError('Mock-only offline transport');
    const custom = async (name, number, fallback) => {
      const value = state[name] ? await state[name](number, call) : fallback;
      return value instanceof Response ? value : response(value);
    };
    if (route === 'download') { state.downloads++; const item = items[Number(parsed.pathname.split('/').at(-1))]; return new Response(item.bytes, { headers: { 'content-type': item.mime } }); }
    if (route === '/api/webapp/apiCallDemo') return custom('onMetadata', ++state.metadataReads, { code: 0, data: state.metadata });
    if (route === '/uc/openapi/accountStatus') return custom('onAccount', ++state.accountReads, { code: 0, data: { apiType: state.accountType, remainCoins: '100' } });
    if (route === '/task/openapi/upload') return custom('onUpload', ++state.uploads, { code: 0, data: { fileName: `api/input-${state.uploads}.png`, fileType: 'input' } });
    if (route === '/task/openapi/ai-app/run') return custom('onSubmit', ++state.appSubmits, { code: 0, data: { taskId: 'app-fixture-task' } });
    if (route === '/task/openapi/create') return custom('onWorkflowSubmit', ++state.workflowSubmits, { code: 0, data: { taskId: 'workflow-fixture-task' } });
    if (route === '/openapi/v2/query') return custom('onQuery', ++state.queryReads, { taskId: body.taskId, status: 'SUCCESS', results: results() });
    return response({ code: 0, data: { prompt: JSON.stringify(state.workflowGraph) } });
  }
  const inputResources = new Map(request.files.map((file, index) => [file.blob.resource, index]));
  const ctx = { operation: 'operation-app', need: { capability: aiAppCapability, returns: workflowTypes.result, constraints: request },
    credentials: { apiKey: { secret: KEY }, ...(options.password ? { accessPassword: { secret: password } } : {}) },
    resources: { get: async resource => {
      state.resourceReads++; const index = inputResources.get(resource);
      assert.ok(index !== undefined, 'Unexpected ResourceStore input read');
      return state.onResource ? state.onResource(state.resourceReads, index) : state.inputs[index];
    }, put: async (bytes, mediaType) => {
      writes.push({ bytes: Buffer.from(bytes), mediaType });
      return { kind: 'blob', resource: `res_output_${writes.length}`, size: bytes.length, mediaType };
    } } };
  let appEndpoint, workflowEndpoint, appSettings, workflowSettings;
  function install() {
    createWorkflowProvider({ config, dataRoot, instance, pool: instance, fetch, clock }).install({
      registerAsyncEndpoint(_instance, capability, returns, endpoint, settings) {
        assert.deepEqual(returns, workflowTypes.result);
        if (digest(capability) === digest(aiAppCapability)) { appEndpoint = endpoint; appSettings = settings; }
        else if (digest(capability) === digest(workflowCapability)) { workflowEndpoint = endpoint; workflowSettings = settings; }
        else assert.fail('Unexpected native operation capability');
      },
    });
    assert.ok(appEndpoint && workflowEndpoint, 'Both native service routes must be available to consumers');
  }
  install();
  const journal = (suffix = '', operation = ctx.operation) => openJournal({ dataRoot, instance, operation,
    journalDirectory: config.paths.journalDirectory + suffix, maxBytes: config.budgets.maxJournalBytes });
  async function workflowContext({ instanceType } = {}) {
    const graph = { '1': { class_type: 'UnregisteredWorkflowNode', inputs: { text: 'original', untouched: [false, null] } } };
    state.workflowGraph = graph;
    const constraints = { format: 'hypit-runninghub.request@1', workflowId: '1979026379880697857', workflowJson: JSON.stringify(graph),
      nodeInfoList: [{ nodeId: '1', fieldName: 'text', fieldValue: 'workflow-chosen' }], files: [], bindings: [], review: 'reviews/workflow.json',
      ...(instanceType === undefined ? {} : { instanceType }) };
    const record = { ...structuredClone(review), format: 'REVIEWED_WORKFLOW_OPERATION@1', requestDigest: requestDigest(constraints),
      graphDigest: digest(graph), fileDigests: [], scope: 'reviewed-native-only-no-external-money',
      humanReview: { ...review.humanReview, kind: 'project-owner-reviewed-membership-key-and-native-workflow' } };
    delete record.appDigest;
    await saveReview(record, constraints.review);
    return { ...ctx, need: { capability: workflowCapability, returns: workflowTypes.result, constraints }, review: record, graph };
  }
  return { config, dataRoot, instance, state, app, request, review, saveReview, ctx, calls, writes, clock, journal, restart: install, workflowContext,
    get endpoint() { return appEndpoint; }, get workflowEndpoint() { return workflowEndpoint; },
    get settings() { return appSettings; }, get workflowSettings() { return workflowSettings; } };
}
