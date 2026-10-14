import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkflowProvider } from '../generic/provider.js';
import { aiAppCapability } from '../ai-app/model.js';
import { digest } from '../native/descriptor.js';
import { credentialSha256 } from '../native/member-binding.js';
import { appFixture, failed, publicSafe, mixedOutputs } from './ai-app-fixture.js';

const PASSWORD = '731952';
const resultItems = () => mixedOutputs.map((item, index) => ({
  url: `https://cdn.example.invalid/files/${index}?signature=PRIVATE_SIGNED_OUTPUT_${index}`,
  outputType: item.outputType,
}));
const success = (taskId, usage) => ({ taskId, status: 'SUCCESS', results: resultItems(), usage });

async function startedContext(f) {
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.equal(f.state.uploads, 0);
  assert.equal(f.state.appSubmits, 1);
  return { started, ctx: { ...f.ctx, handle: started.handle } };
}

for (const field of ['taskCostTime', 'consumeCoins']) {
  test(`encrypted App rejects password-bearing ${field} before saving results`, async t => {
    const f = await appFixture(t, { encrypted: true, parameterless: true, password: PASSWORD });
    const { started, ctx } = await startedContext(f);
    const usage = { consumeMoney: '0', consumeCoins: '1', thirdPartyConsumeMoney: null, taskCostTime: '2', [field]: PASSWORD };
    f.state.onQuery = () => success(started.handle.taskId, usage);
    const rejected = await f.endpoint.poll(ctx);
    failed(rejected, 'CREDENTIAL_IN_RESULT_USAGE');
    assert.deepEqual(rejected.receipt, started.receipt);
    assert.equal(await (await f.journal('/results')).read(), undefined);
    const observed = await (await f.journal('/observations')).read();
    assert.equal(observed.billingViolation, undefined);
    assert.ok(!JSON.stringify(observed).includes(PASSWORD));
    failed(await f.endpoint.collect(ctx), 'RESULT_JOURNAL_MISSING');
    assert.equal(f.state.downloads, 0);
    assert.deepEqual(f.writes, []);
    publicSafe([started, rejected], [PASSWORD]);
  });
}

test('saved legacy password usage is rejected after factory restart without downloads or puts', async t => {
  for (const field of ['taskCostTime', 'consumeCoins']) await t.test(field, async child => {
    const f = await appFixture(child, { encrypted: true, parameterless: true, password: PASSWORD });
    const { ctx } = await startedContext(f);
    assert.equal((await f.endpoint.poll(ctx)).status, 'ready');
    const journal = await f.journal('/results');
    const saved = await journal.read();
    await journal.write({ ...saved, usage: { consumeMoney: '0', consumeCoins: '1', [field]: `0${PASSWORD}.00` } });
    f.restart();
    f.state.offline = true;
    const before = f.calls.length;
    const rejected = await f.endpoint.collect(ctx);
    failed(rejected, 'CREDENTIAL_IN_RESULT_USAGE');
    assert.equal(f.calls.length, before);
    assert.equal(f.state.downloads, 0);
    assert.deepEqual(f.writes, []);
    publicSafe(rejected, [PASSWORD]);
  });
});

test('captured numeric API key is checked in polled and legacy saved usage', async t => {
  const key = '864207';
  const f = await appFixture(t, { encrypted: true, parameterless: true, password: PASSWORD });
  f.ctx.credentials.apiKey.secret = key;
  f.review.credential.sha256 = credentialSha256(key);
  await f.saveReview();
  let endpoint;
  const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const fetch = async (url, init) => {
    assert.equal(f.state.offline, false, 'Legacy collection must not call transport');
    const parsed = new URL(url);
    assert.equal(parsed.origin, new URL(f.config.baseUrl).origin);
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, `Bearer ${key}`);
    const path = parsed.pathname;
    f.calls.push({ url, init, path });
    if (path === '/api/webapp/apiCallDemo') {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      assert.deepEqual([...parsed.searchParams.keys()].sort(), ['apiKey', 'webappId']);
      assert.equal(parsed.searchParams.get('apiKey'), key);
      assert.equal(parsed.searchParams.get('webappId'), f.request.webappId);
      f.state.metadataReads++;
      return response({ code: 0, data: f.state.metadata });
    }
    assert.equal(init.method, 'POST');
    assert.equal(parsed.search, '');
    const body = JSON.parse(init.body);
    if (path === '/uc/openapi/accountStatus') {
      assert.deepEqual(body, { apikey: key });
      f.state.accountReads++;
      return response({ code: 0, data: { apiType: 'NORMAL', remainCoins: '100' } });
    }
    if (path === '/task/openapi/ai-app/run') {
      assert.deepEqual(body, { webappId: f.request.webappId, nodeInfoList: [], apiKey: key, accessPassword: PASSWORD });
      f.state.appSubmits++;
      return response({ code: 0, data: { taskId: 'app-fixture-task' } });
    }
    assert.equal(path, '/openapi/v2/query', 'No other transport path is permitted');
    assert.deepEqual(body, { taskId: 'app-fixture-task' });
    f.state.queryReads++;
    return response(success(body.taskId, { consumeMoney: '0', consumeCoins: key, taskCostTime: '2' }));
  };
  const restart = () => createWorkflowProvider({ config: f.config, dataRoot: f.dataRoot, instance: f.instance,
    pool: f.instance, clock: f.clock, fetch }).install({
    registerAsyncEndpoint(_instance, capability, _returns, installed) {
      if (digest(capability) === digest(aiAppCapability)) endpoint = installed;
    },
  });
  restart();
  const started = await endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const ctx = { ...f.ctx, handle: started.handle };
  const rejected = await endpoint.poll(ctx);
  failed(rejected, 'CREDENTIAL_IN_RESULT_USAGE');
  assert.equal(await (await f.journal('/results')).read(), undefined);
  const observed = await (await f.journal('/observations')).read();
  assert.ok(!JSON.stringify(observed).includes(key));
  await (await f.journal('/results')).write({ taskId: started.handle.taskId, fingerprint: started.handle.fingerprint,
    results: resultItems(), usage: { consumeMoney: '0', taskCostTime: `0${key}.00` } });
  restart();
  f.state.offline = true;
  const before = f.calls.length;
  const collected = await endpoint.collect(ctx);
  failed(collected, 'CREDENTIAL_IN_RESULT_USAGE');
  assert.equal(f.calls.length, before);
  assert.equal(f.state.downloads, 0);
  assert.deepEqual(f.writes, []);
  publicSafe([started, rejected, collected], [key, PASSWORD]);
});

test('billing validation completes before usage credential rejection', async t => {
  for (const [name, usage, code] of [
    ['malformed later time', { consumeCoins: PASSWORD, taskCostTime: 2 }, 'BILLING_USAGE_UNKNOWN'],
    ['later third-party Money', { consumeCoins: PASSWORD, thirdPartyConsumeMoney: '0.01' }, 'BILLING_MISMATCH'],
  ]) await t.test(name, async child => {
    const f = await appFixture(child, { encrypted: true, parameterless: true, password: PASSWORD });
    const { started, ctx } = await startedContext(f);
    f.state.onQuery = () => success(started.handle.taskId, usage);
    const rejected = await f.endpoint.poll(ctx);
    failed(rejected, code);
    assert.equal(await (await f.journal('/results')).read(), undefined);
    assert.equal(f.state.downloads, 0);
    assert.deepEqual(f.writes, []);
    publicSafe(rejected, [PASSWORD]);
  });
});

test('positive Money matching password retains durable billing denial and sanitized evidence', async t => {
  for (const field of ['consumeMoney', 'thirdPartyConsumeMoney']) await t.test(field, async child => {
    const f = await appFixture(child, { encrypted: true, parameterless: true, password: PASSWORD });
    const { started, ctx } = await startedContext(f);
    assert.equal((await f.endpoint.poll(ctx)).status, 'ready');
    f.state.onQuery = () => success(started.handle.taskId, { consumeCoins: '1', [field]: PASSWORD });
    const rejected = await f.endpoint.poll(ctx);
    failed(rejected, 'BILLING_MISMATCH');
    const observed = await (await f.journal('/observations')).read();
    assert.equal(observed.billingViolation, true);
    assert.ok(!JSON.stringify(observed).includes(PASSWORD));
    f.restart();
    f.state.offline = true;
    const before = f.calls.length;
    const collected = await f.endpoint.collect(ctx), polled = await f.endpoint.poll(ctx);
    failed(collected, 'BILLING_MISMATCH');
    failed(polled, 'BILLING_MISMATCH');
    assert.equal(f.calls.length, before);
    assert.equal(f.state.downloads, 0);
    assert.deepEqual(f.writes, []);
    publicSafe([rejected, collected, polled], [PASSWORD]);
  });
});

test('harmless decimal strings, fixed usage names and null sentinels are preserved exactly', async t => {
  for (const [password, usage] of [
    [PASSWORD, { consumeMoney: '00.000', consumeCoins: '0007.50', thirdPartyConsumeMoney: '0.000', taskCostTime: '0012.3400' }],
    ['consumeCoins', { consumeMoney: null, consumeCoins: '007.50', thirdPartyConsumeMoney: null, taskCostTime: '12.3400' }],
    ['null', { consumeMoney: null, consumeCoins: null, thirdPartyConsumeMoney: null, taskCostTime: null }],
  ]) await t.test(password, async child => {
    const f = await appFixture(child, { encrypted: true, parameterless: true, password });
    const { started, ctx } = await startedContext(f);
    f.state.onQuery = () => success(started.handle.taskId, usage);
    const ready = await f.endpoint.poll(ctx);
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    assert.deepEqual((await (await f.journal('/results')).read()).usage, usage);
    f.restart();
    const completed = await f.endpoint.collect(ctx);
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.deepEqual(completed.result.value.value.usage, usage);
    assert.equal(f.state.downloads, mixedOutputs.length);
    assert.deepEqual(f.writes, mixedOutputs.map(({ bytes, mime }) => ({ bytes, mediaType: mime })));
  });
});
