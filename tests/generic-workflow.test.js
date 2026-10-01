import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkflowProvider, workflowCapability, workflowTypes, workflowManifest, workflowComponent, workflowFragment, requestDigest, validateGenericConfig, validateWorkflowResult } from '../generic/index.js';
import { parseJson, jsonValue } from '../generic/request.js';
import { uploadFormats, admitFile } from '../generic/media.js';
import { digest } from '../native/descriptor.js';
import { credentialSha256, MEMBER_CONTRACT_SHA256 } from '../native/member-binding.js';
import { MEMBERSHIP_SOURCE } from '../native/membership-assessment.js';
import { openJournal } from '../core/journal.js';
const original = JSON.parse(await readFile(new URL('../examples/native-config.json', import.meta.url)));
const secret = 'inert-generic-fixture-key-no-live-authority';
const png = Buffer.from([137,80,78,71,13,10,26,10]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function clock() { let now = 1000; return { now: () => now, sleep: async ms => { now += ms; }, timeout: () => ({ signal: new AbortController().signal, cancel() {} }) }; }
async function fixture(t, opts = {}) {
 const dataRoot = await mkdtemp(join(tmpdir(), 'rh-any-core-')); t.after(() => rm(dataRoot, { recursive: true, force: true }));
 const config = { ...structuredClone(original), schemaVersion: 'hypit-runninghub.config@2', keyType: 'Consumer-Member', submissionEnabled: true,
 native: { uploadProtocol: 'legacy-filename', submitProtocol: 'legacy-create', queryProtocol: 'v2-query' }, budgets: { maxRequestBytes: 1048576, maxJournalBytes: 8388608 } };
 config.http.allowedDownloadHosts = ['cdn.example.invalid'];
 const graph = { newNode: { class_type: 'NeverRegisteredCustomNode', inputs: { object: { labels: ['a','b'], enabled: false }, literal: [1,2,3], empty: null } } };
 const request = { format: 'hypit-runninghub.request@1', workflowId: 'unseen-id-A', ...(opts.saved ? {} : { workflowJson: JSON.stringify(graph) }),
 nodeInfoList: [{ nodeId: 'newNode', fieldName: 'optionalNewField', fieldValue: { list: [false,null,0,{ more: ['nested'] }] } }],
 files: Array.from({ length: opts.files ?? 0 }, (_, i) => ({ key: `file-${i}`, blob: { kind: 'blob', resource: `res_${i}`, size: png.length, mediaType: 'image/png' } })),
 bindings: Array.from({ length: opts.files ?? 0 }, (_, i) => ({ fileKey: `file-${i}`, nodeId: 'newNode', fieldName: `arbitraryField-${i}` })), review: 'reviews/operation.json' };
 const review = { format: 'REVIEWED_WORKFLOW_OPERATION@1', credential: { reference: config.apiKey, sha256: credentialSha256(secret) }, baseUrl: config.baseUrl,
 requestDigest: requestDigest(request), graphDigest: digest(graph), fileDigests: request.files.map(f => ({ key: f.key, sha256: hash(png) })), scope: 'reviewed-native-only-no-external-money',
 source: { url: MEMBERSHIP_SOURCE, noteSha256: MEMBER_CONTRACT_SHA256 }, humanReview: { kind: 'project-owner-reviewed-membership-key-and-native-workflow', recordId: 'offline-fixture-only', reviewer: 'mock-only', reviewedAt: new Date(0).toISOString() }, expiresAt: new Date(86400000).toISOString() };
 await mkdir(join(dataRoot, 'reviews'), { mode: 0o700 }); const save = () => writeFile(join(dataRoot, request.review), JSON.stringify(review), { mode: 0o600 }); await save();
 const calls = [], writes = []; let uploads = 0, creates = 0, gets = 0;
 const fetch = async (url, init) => {
 calls.push({ url, init });
 if (url.endsWith('/accountStatus')) return json({ code: 0, data: { apiType: opts.account ?? 'NORMAL', remainCoins: '100' } });
 if (url.endsWith('/getJsonApiFormat')) return json({ code: 0, data: { prompt: JSON.stringify(opts.remoteGraph ?? graph) } });
 if (url.endsWith('/upload')) { uploads++; return opts.upload ? opts.upload(uploads) : json({ code: 0, data: { fileName: `api/exact-${uploads}.png`, fileType: 'input' } }); }
 if (url.endsWith('/create')) { creates++; return opts.create ? opts.create(creates) : json({ code: 0, data: { taskId: 'generic-task' } }); }
 if (url.endsWith('/query')) return json(opts.query ?? { taskId: 'generic-task', status: 'SUCCESS', results: opts.results ?? [{ url: 'https://cdn.example.invalid/a?private=signed', outputType: 'csv', count: 0, safe: [false,null], echo: secret }], usage: opts.usage });
 assert.equal(init.headers, undefined); assert.equal(init.redirect, 'error'); return new Response(typeof opts.output === 'function' ? opts.output(url) : opts.output ?? 'a,b\n1,2\n', { headers: { 'content-type': typeof opts.mime === 'function' ? opts.mime(url) : opts.mime ?? 'text/csv; charset=utf-8' } });
 };
 const ctx = { operation: 'operation-generic', need: { capability: workflowCapability, returns: workflowTypes.result, constraints: request }, credentials: { apiKey: { secret } },
 resources: { get: async () => { gets++; return opts.get ? opts.get(gets) : png; }, put: async (bytes, mediaType) => { writes.push({ bytes, mediaType }); return { kind: 'blob', resource: `res_output_${writes.length}`, size: bytes.length, mediaType }; } } };
 let endpoint, settings, registered = 0;
 createWorkflowProvider({ config, dataRoot, instance: 'generic-account', pool: 'generic-account', fetch, clock: clock() }).install({ registerAsyncEndpoint(instance, capability, returns, value, s) { registered++; assert.deepEqual(capability, workflowCapability); assert.deepEqual(returns, workflowTypes.result); endpoint = value; settings = s; } });
 const journal = suffix => openJournal({ dataRoot, instance: 'generic-account', operation: ctx.operation, journalDirectory: config.paths.journalDirectory + suffix, maxBytes: config.budgets.maxJournalBytes });
 return { config, graph, request, review, save, ctx, endpoint, settings, registered, calls, writes, journal, dataRoot };
}
function failure(result, code) { assert.equal(result.status, 'failed', JSON.stringify(result)); assert.equal(result.failure.code, code); }
test('nominal Model has custom result and no generation port/category quota', () => {
 assert.equal(workflowManifest.capabilities.length, 1); assert.deepEqual(workflowManifest.capabilities[0].returns, workflowTypes.result); assert.equal(workflowFragment.exports[0].type.name, 'WorkflowResult'); assert.equal(workflowComponent.producers.length, 4);
 assert.equal(validateWorkflowResult({ format: 'hypit-runninghub.result@1', taskId: 'task', outputs: Array.from({ length: 35 }, (_, i) => ({ blob: { kind: 'blob', resource: `res_${i}`, size: 0, mediaType: 'text/csv' }, outputType: 'csv' })) }).outputs.length, 35);
});
test('safe JSON preserves literals and rejects duplicate keys/getters/cycles/nonfinite', () => {
 assert.deepEqual(parseJson('{"a":[false,null,0,{"b":[1,2]}]}'), { a: [false,null,0,{ b: [1,2] }] }); assert.throws(() => parseJson('{"a":1,"a":2}'), { code: 'DUPLICATE_JSON_KEY' });
 assert.throws(() => jsonValue({ get a() { throw Error('getter invoked'); } }), { code: 'NON_JSON_VALUE' }); const cycle = {}; cycle.self = cycle; assert.throws(() => jsonValue(cycle), { code: 'NON_JSON_VALUE' }); assert.throws(() => jsonValue({ a: Infinity }), { code: 'NON_JSON_VALUE' });
});
test('account-only config rejects Money/retry widening', async t => { const f = await fixture(t); assert.equal(validateGenericConfig(f.config).native.workflowDescriptor, undefined); const c = structuredClone(f.config); c.billingExpectation.ledger = 'money'; assert.throws(() => validateGenericConfig(c)); c.billingExpectation.ledger = 'coins'; c.retry.submit.maxAttempts = 4; assert.throws(() => validateGenericConfig(c), { code: 'INVALID_RETRY_BUDGET' }); });
for (const files of [0,1,3,12,35]) test(`ANY inline graph with ${files} files needs no Model/descriptor registration`, async t => {
 const f = await fixture(t, { files }); assert.equal(f.registered, 1); assert.equal(f.settings.supports(f.ctx.need).status, 'supported'); const start = await f.endpoint.start(f.ctx); assert.equal(start.status, 'pending', JSON.stringify(start));
 assert.equal(f.calls.filter(c => c.url.endsWith('/upload')).length, files); const body = JSON.parse(f.calls.find(c => c.url.endsWith('/create')).init.body); const effective = JSON.parse(body.workflow);
 assert.deepEqual(body.nodeInfoList[0].fieldValue, f.request.nodeInfoList[0].fieldValue); assert.deepEqual(effective.newNode.inputs.literal, [1,2,3]); assert.equal(effective.newNode.inputs.optionalNewField.list[0], false);
 for (let i=0;i<files;i++) assert.equal(effective.newNode.inputs[`arbitraryField-${i}`], `api/exact-${i+1}.png`); assert.equal(f.calls.filter(c => c.url.endsWith('/getJsonApiFormat')).length, 0); assert.equal(f.graph.newNode.inputs.optionalNewField, undefined);
});
test('one account capability accepts unrelated saved ID and new inline graph per request', async t => {
 const f = await fixture(t, { saved: true }); assert.equal((await f.endpoint.start(f.ctx)).status, 'pending'); assert.equal(JSON.parse(f.calls.find(c => c.url.endsWith('/create')).init.body).workflow, undefined);
 f.ctx.operation = 'independent-operation'; f.request.workflowId = 'unseen-id-B'; f.request.workflowJson = JSON.stringify({ other: { class_type: 'AnotherUnregisteredNode', inputs: {} } }); f.request.nodeInfoList = [];
 f.review.requestDigest = requestDigest(f.request); f.review.graphDigest = digest(JSON.parse(f.request.workflowJson)); await f.save(); assert.equal((await f.endpoint.start(f.ctx)).status, 'pending'); assert.equal(f.calls.filter(c => c.url.endsWith('/create')).length, 2);
});
test('collects >20 mixed/unknown extensions with actual MIME, metadata and no URL/key leaks', async t => {
 const results = Array.from({ length: 25 }, (_, i) => ({ url: `https://cdn.example.invalid/${i}?private=signed`, outputType: i%2 ? 'unknown-extension' : 'csv', index: i, enabled: false, echo: secret })); const f = await fixture(t, { results });
 const start = await f.endpoint.start(f.ctx), ready = await f.endpoint.poll({ ...f.ctx, handle: start.handle }); assert.equal(ready.status, 'ready'); const collected = await f.endpoint.collect({ ...f.ctx, handle: ready.handle }); assert.equal(collected.status, 'completed', JSON.stringify(collected));
 assert.equal(collected.result.value.value.outputs.length, 25); assert.equal(f.writes.length, 25); assert.equal(collected.result.value.value.outputs[1].blob.mediaType, 'text/csv'); assert.equal(collected.result.value.value.outputs[1].outputType, 'unknown-extension'); assert.equal(collected.result.value.value.outputs[0].metadata.enabled, false); assert.ok(!JSON.stringify(collected).includes('signed')); assert.ok(!JSON.stringify(collected).includes(secret));
});
test('SUCCESS with zero outputs returns empty collection', async t => { const f = await fixture(t, { results: [] }); const s = await f.endpoint.start(f.ctx), r = await f.endpoint.poll({ ...f.ctx, handle: s.handle }); assert.equal((await f.endpoint.collect({ ...f.ctx, handle: r.handle })).result.value.value.outputs.length, 0); });
test('invalid review and SHARED fail before upload/create', async t => { for (const opts of [{}, { account: 'SHARED' }]) { const f = await fixture(t, { ...opts, files: 1 }); if (!opts.account) { f.review.requestDigest = '0'.repeat(64); await f.save(); } failure(await f.endpoint.start(f.ctx), opts.account ? 'BILLING_MISMATCH' : 'MEMBER_BINDING_WORKFLOW_MISMATCH'); assert.equal(f.calls.filter(c => /\/(upload|create)$/.test(c.url)).length, 0); } });
test('same operation rejects graph/ID/key changes after ACK and resumes unchanged without network', async t => {
 const f = await fixture(t); const s = await f.endpoint.start(f.ctx); assert.equal(s.status, 'pending'); const count = f.calls.length; assert.equal((await f.endpoint.start(f.ctx)).status, 'pending'); assert.equal(f.calls.length, count);
 f.request.workflowId = 'other'; failure(await f.endpoint.start(f.ctx), 'JOURNAL_IDENTITY_MISMATCH'); f.request.workflowId = 'unseen-id-A'; f.ctx.credentials.apiKey.secret = 'rotated-fixture'; failure(await f.endpoint.start(f.ctx), 'JOURNAL_IDENTITY_MISMATCH'); failure(await f.endpoint.poll({ ...f.ctx, handle: s.handle }), 'TASK_NOT_IN_OPERATION_JOURNAL'); assert.equal(f.calls.length, count);
});
test('three transient create attempts become durable unknown without new series', async t => { const f = await fixture(t, { create: () => new Response('{}', { status: 503 }) }); failure(await f.endpoint.start(f.ctx), 'HTTP_503'); failure(await f.endpoint.start(f.ctx), 'OUTCOME_UNKNOWN_NO_NEW_SERIES'); assert.equal(f.calls.filter(c => c.url.endsWith('/create')).length, 3); });
test('partial upload durable budget cannot reset', async t => { const f = await fixture(t, { files: 1, upload: () => new Response('{}', { status: 503 }) }); failure(await f.endpoint.start(f.ctx), 'HTTP_503'); failure(await f.endpoint.start(f.ctx), 'OUTCOME_UNKNOWN_NO_NEW_SERIES'); assert.equal(f.calls.filter(c => c.url.endsWith('/upload')).length, 3); assert.equal(f.calls.filter(c => c.url.endsWith('/create')).length, 0); });
test('every file admitted before first upload; reread mutation refused', async t => { const f = await fixture(t, { files: 2, get: n => n===2 ? Buffer.alloc(png.length) : png }); failure(await f.endpoint.start(f.ctx), 'REFERENCE_SIGNATURE_MISMATCH'); assert.equal(f.calls.filter(c => c.url.endsWith('/upload')).length, 0); const g = await fixture(t, { files: 1, get: n => n===2 ? Buffer.alloc(png.length) : png }); failure(await g.endpoint.start(g.ctx), 'REFERENCE_SIGNATURE_MISMATCH'); assert.equal(g.calls.filter(c => c.url.endsWith('/upload')).length, 0); });
test('all documented MIME container families plus ZIP are admitted', () => {
 const fixtures = { png, jpg: Buffer.from([255,216,255]), webp: Buffer.from('RIFF0000WEBP'), mp3: Buffer.from('ID3'), wav: Buffer.from('RIFF0000WAVE'), flac: Buffer.from('fLaC'), mp4: Buffer.from('0000ftypisom'), avi: Buffer.from('RIFF0000AVI '), mov: Buffer.from('0000moov'), mkv: Buffer.from([0x1a,0x45,0xdf,0xa3]), zip: Buffer.from([0x50,0x4b,3,4]) };
 for (const [mime, ext] of Object.entries(uploadFormats)) assert.equal(admitFile({ size: fixtures[ext].length, mediaType: mime }, fixtures[ext]).extension, ext);
});
test('untrusted output origin and positive Money usage stay blocked', async t => { const f = await fixture(t, { results: [{ url: 'https://untrusted.invalid/a', outputType: 'csv' }] }); const s = await f.endpoint.start(f.ctx), r = await f.endpoint.poll({ ...f.ctx, handle: s.handle }); failure(await f.endpoint.collect({ ...f.ctx, handle: r.handle }), 'UNSAFE_RESULT_URL'); const g = await fixture(t, { usage: { consumeMoney: '1' } }); const started = await g.endpoint.start(g.ctx); failure(await g.endpoint.poll({ ...g.ctx, handle: started.handle }), 'BILLING_MISMATCH'); });
test('raw Money and business failure observations persist before failure classification', async t => {
 for (const query of [{ taskId: 'generic-task', status: 'SUCCESS', usage: { consumeMoney: '2' }, results: [] }, { taskId: 'generic-task', status: 'FAILED', errorCode: '805', errorMessage: 'fixture-failure', results: [] }]) {
  const f = await fixture(t, { query }); const start = await f.endpoint.start(f.ctx); const result = await f.endpoint.poll({ ...f.ctx, handle: start.handle });
  failure(result, query.usage ? 'BILLING_MISMATCH' : 'UPSTREAM_BUSINESS_ERROR'); assert.equal(result.receipt.id, 'generic-task'); assert.deepEqual((await (await f.journal('/observations')).read()).response, query);
 }
});
test('secret or URL outputType is redacted without discarding the resource', async t => {
 const f = await fixture(t, { results: [{ url: 'https://cdn.example.invalid/a', outputType: secret }, { url: 'https://cdn.example.invalid/b', outputType: 'https://private.invalid/signed' }] });
 const start = await f.endpoint.start(f.ctx), ready = await f.endpoint.poll({ ...f.ctx, handle: start.handle }); const result = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
 assert.equal(result.result.value.value.outputs.length, 2); assert.ok(result.result.value.value.outputs.every(item => item.outputType === '[redacted]')); assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('private.invalid'));
});
test('mixed actual image/audio/video/binary bytes are admitted into distinct ResourceStore Blobs', async t => {
 const items = [{ ext:'png', mime:'image/png', bytes:png }, { ext:'wav', mime:'audio/wav', bytes:Buffer.from('RIFF0000WAVE') }, { ext:'mp4', mime:'video/mp4', bytes:Buffer.from('0000ftypisom') }, { ext:'novel', mime:'application/octet-stream', bytes:Buffer.from([0,255,1]) }];
 const at = url => items[Number(new URL(url).pathname.slice(1))];
 const f = await fixture(t, { results: items.map((item,i) => ({ url: `https://cdn.example.invalid/${i}`, outputType:item.ext })), mime:url=>at(url).mime, output:url=>at(url).bytes });
 const start = await f.endpoint.start(f.ctx), ready = await f.endpoint.poll({ ...f.ctx, handle:start.handle }); const result = await f.endpoint.collect({ ...f.ctx, handle:ready.handle }); assert.equal(result.status,'completed');
 for (const [i,item] of items.entries()) { assert.equal(result.result.value.value.outputs[i].blob.mediaType,item.mime); assert.deepEqual(f.writes[i].bytes,item.bytes); } assert.equal(new Set(result.result.value.value.outputs.map(item=>item.blob.resource)).size,4);
});
test('public run/bind/finalize Producer handlers create one generic Need with real Blob references', async t => {
 const f = await fixture(t); f.request.bindings.push({ fileKey:'extra',nodeId:'newNode',fieldName:'newFile' }); const inline=value=>({value:{kind:'inline',value}});
 const bind = workflowComponent.producers.find(item=>item.producer.name==='bind-workflow-file'); const bound = bind.handler({inputs:{draft:inline(f.request),key:inline('extra'),file:{value:{kind:'blob',resource:'res_extra',size:png.length,mediaType:'image/png'}}}});
 const finalize = workflowComponent.producers.find(item=>item.producer.name==='finalize-workflow'); const finalized = finalize.handler({inputs:{draft:{value:bound.outputs.draft}}});
 const run = workflowComponent.producers.find(item=>item.producer.name==='run-workflow'); const generated = run.handler({inputs:{request:{value:finalized.outputs.request}}}); assert.equal(generated.needs.workflow.files[0].blob.resource,'res_extra'); assert.deepEqual(generated.outputs,{});
});
test('duplicate keys in private owner review are rejected before uploads/create', async t => {
 const f = await fixture(t, { files: 1 });
 await writeFile(join(f.dataRoot,f.request.review), JSON.stringify(f.review).replace('{','{"format":"conflicting-duplicate",'), {mode:0o600});
 failure(await f.endpoint.start(f.ctx),'PRIVATE_JSON_INVALID'); assert.equal(f.calls.filter(c=>/\/(upload|create)$/.test(c.url)).length,0);
});
test('semantic review accepts new ResourceStore identity for identical bytes on a distinct operation',async t=>{
 const f=await fixture(t,{files:1});assert.equal((await f.endpoint.start(f.ctx)).status,'pending');f.ctx.operation='independent-resource-admission';f.request.files[0].blob.resource='res_B';assert.equal(requestDigest(f.request),f.review.requestDigest);assert.equal((await f.endpoint.start(f.ctx)).status,'pending');assert.equal(f.calls.filter(c=>c.url.endsWith('/create')).length,2);
});
test('changed file order, targets and values fail review before any upload/create',async t=>{
 for(const mutate of [f=>f.request.files.reverse(),f=>f.request.bindings[0].fieldName='otherOptionalField',f=>f.request.nodeInfoList[0].fieldValue=false]){
 const f=await fixture(t,{files:2});mutate(f);failure(await f.endpoint.start(f.ctx),'MEMBER_BINDING_WORKFLOW_MISMATCH');assert.equal(f.calls.filter(c=>/\/(upload|create)$/.test(c.url)).length,0);
 }
});
test('changed admitted file byte SHA fails review before effects even with same MIME/size',async t=>{
 const f=await fixture(t,{files:1});f.request.files[0].blob.size=png.length+1;f.review.requestDigest=requestDigest(f.request);f.review.fileDigests[0].sha256=hash(Buffer.concat([png,Buffer.from([0])]));await f.save();f.ctx.resources.get=async()=>Buffer.concat([png,Buffer.from([1])]);failure(await f.endpoint.start(f.ctx),'MEMBER_BINDING_WORKFLOW_MISMATCH');assert.equal(f.calls.filter(c=>/\/(upload|create)$/.test(c.url)).length,0);
});
