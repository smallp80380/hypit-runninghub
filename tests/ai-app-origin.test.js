import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fetchAiApp, validateAiAppDocument, validateAiAppFetchConfig } from '../ai-app/document.js';
import { prepareAiAppReviewCandidate } from '../ai-app/review-candidate.js';
import { credentialSha256 } from '../native/member-binding.js';
import { digest } from '../native/descriptor.js';
import { serviceBase } from '../core/config.js';
import { appFixture, KEY, mixedOutputs, publicSafe } from './ai-app-fixture.js';

const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020.js').default;
const ajv = new Ajv2020();
const fetchSchema = ajv.compile(JSON.parse(await readFile(new URL('../schemas/ai-app-fetch.schema.json', import.meta.url))));
const documentSchema = ajv.compile(JSON.parse(await readFile(new URL('../schemas/ai-app-document.schema.json', import.meta.url))));

test('published App schemas accept canonical and trailing-slash official origins only', () => {
  for (const origin of ['https://www.runninghub.ai', 'https://www.runninghub.cn']) {
    const content = { baseUrl: origin, webappId: '1937084629516193794', accessEncrypted: false, nodeInfoList: [] };
    const appDigest = digest(content);
    const fetchConfig = { format: 'hypit-runninghub.ai-app-fetch@1', baseUrl: origin, webappId: content.webappId,
      apiKey: { store: 'fixture', key: 'api-key' }, requestTimeoutMs: 1000, maxResponseBytes: 4096 };
    const document = { format: 'hypit-runninghub.ai-app-document@1', ...content, webappName: 'Empty interface', appDigest };
    for (const baseUrl of [origin, `${origin}/`]) {
      const config = { ...fetchConfig, baseUrl }, source = { ...document, baseUrl };
      assert.equal(fetchSchema(config), true, JSON.stringify(fetchSchema.errors));
      assert.equal(documentSchema(source), true, JSON.stringify(documentSchema.errors));
      assert.equal(validateAiAppFetchConfig(config).baseUrl, origin);
      assert.equal(validateAiAppDocument(source).appDigest, appDigest);
    }
    for (const baseUrl of ['https://foreign.invalid', `${origin}//`, `${origin}/path`, `${origin}/?query=1`, `${origin}/#fragment`]) {
      assert.equal(fetchSchema({ ...fetchConfig, baseUrl }), false, baseUrl);
      assert.equal(documentSchema({ ...document, baseUrl }), false, baseUrl);
      assert.throws(() => validateAiAppFetchConfig({ ...fetchConfig, baseUrl }), { code: 'UNTRUSTED_SERVICE_BASE' });
      assert.throws(() => validateAiAppDocument({ ...document, baseUrl }), { code: 'UNTRUSTED_SERVICE_BASE' });
    }
  }
});
async function readDocument(f, baseUrl) {
  const config = { format: 'hypit-runninghub.ai-app-fetch@1', baseUrl, webappId: f.request.webappId,
    apiKey: f.config.apiKey, requestTimeoutMs: f.config.http.requestTimeoutMs, maxResponseBytes: f.config.http.maxResponseBytes };
  const original = structuredClone(config);
  assert.equal(validateAiAppFetchConfig(config).baseUrl, serviceBase(baseUrl, 'native-workflow'));
  let reads = 0;
  const document = await fetchAiApp(config, { resolveCredential: () => KEY, clock: f.clock,
    fetch: async (url, init) => {
      reads++;
      const parsed = new URL(url);
      assert.equal(parsed.origin, serviceBase(baseUrl, 'native-workflow'));
      assert.equal(parsed.pathname, '/api/webapp/apiCallDemo');
      assert.equal(parsed.searchParams.get('webappId'), f.request.webappId);
      assert.equal(parsed.searchParams.get('apiKey'), KEY);
      assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error');
      return new Response(JSON.stringify({ code: 0, data: f.state.metadata }), { headers: { 'content-type': 'application/json' } });
    } });
  assert.equal(reads, 1);
  assert.deepEqual(config, original, 'Fetch config must remain caller-owned');
  assert.equal(f.state.uploads, 0); assert.equal(f.state.appSubmits, 0);
  return document;
}

for (const slashEndpoint of [false, true]) {
  test(`canonical App interface review executes with ${slashEndpoint ? 'trailing-slash Endpoint' : 'canonical Endpoint and trailing-slash fetch'}`, async t => {
    const f = await appFixture(t, { files: 0 });
    const origin = serviceBase(f.config.baseUrl, 'native-workflow');
    const canonical = await readDocument(f, origin);
    const slash = await readDocument(f, `${origin}/`);
    assert.deepEqual(slash, canonical);
    assert.equal(slash.appDigest, f.app.appDigest);
    assert.equal(slash.baseUrl, origin);
    if (slashEndpoint) { f.config.baseUrl = `${origin}/`; f.restart(); }
    // A noncanonical spelling with a canonical digest is validated without mutation.
    const source = { ...structuredClone(slash), baseUrl: `${origin}/` };
    const original = structuredClone(source);
    assert.deepEqual(validateAiAppDocument(source), canonical);
    assert.deepEqual(source, original);
    assert.equal(Object.isFrozen(source), false);
    const candidate = await prepareAiAppReviewCandidate({ config: f.config, request: f.request, app: source,
      credentialSha256: credentialSha256(KEY), files: [] });
    assert.equal(candidate.semanticValidation, 'UNVERIFIED');
    assert.equal(candidate.record.appDigest, canonical.appDigest);
    // Explicit mock-only owner approval, never automatic candidate authorization.
    await f.saveReview({ ...candidate.record, humanReview: structuredClone(f.review.humanReview), expiresAt: f.review.expiresAt });
    const started = await f.endpoint.start(f.ctx);
    assert.equal(started.status, 'pending', JSON.stringify(started));
    const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.deepEqual(f.writes, mixedOutputs.map(item => ({ bytes: item.bytes, mediaType: item.mime })));
    assert.deepEqual(completed.result.value.value.outputs.map(output => output.blob.mediaType), mixedOutputs.map(item => item.mime));
    assert.equal(f.config.baseUrl, slashEndpoint ? `${origin}/` : origin, 'Do not canonicalize Endpoint config globally');
    publicSafe([started, ready, completed]);
  });
}

test('App documents reject raw-spelling legacy digests, tampering and foreign origins', async t => {
  const f = await appFixture(t, { files: 0 });
  const slash = { ...structuredClone(f.app), baseUrl: `${f.app.baseUrl}/` };
  const rawDigest = digest({ baseUrl: slash.baseUrl, webappId: slash.webappId, accessEncrypted: slash.accessEncrypted, nodeInfoList: slash.nodeInfoList });
  assert.notEqual(rawDigest, f.app.appDigest);
  assert.throws(() => validateAiAppDocument({ ...slash, appDigest: rawDigest }), { code: 'REVISION_DIGEST_MISMATCH' });
  assert.throws(() => validateAiAppDocument({ ...f.app, appDigest: '0'.repeat(64) }), { code: 'REVISION_DIGEST_MISMATCH' });
  assert.throws(() => validateAiAppDocument({ ...f.app, baseUrl: 'https://foreign.invalid' }), { code: 'UNTRUSTED_SERVICE_BASE' });
  assert.throws(() => validateAiAppFetchConfig({ format: 'hypit-runninghub.ai-app-fetch@1', baseUrl: 'https://foreign.invalid',
    webappId: f.request.webappId, apiKey: f.config.apiKey, requestTimeoutMs: 1000, maxResponseBytes: 4096 }), { code: 'UNTRUSTED_SERVICE_BASE' });
  assert.equal(f.state.uploads, 0); assert.equal(f.state.appSubmits, 0);
});
