// Mock-only secrets and transport for the ordinary installed consumer proof.
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const key = 'offline-v004-fixture-not-real';
const password = 'offline-app-password-not-real';
const sha256 = value => createHash('sha256').update(value).digest('hex');
export const credentialSha256 = sha256(key);
export const accessPasswordSha256 = sha256(password);
export function assertPublicSafe(text) {
  for (const forbidden of [key, password, '/api/webapp/apiCallDemo?', 'private=signed', 'curl -H', 'https://cdn.example.invalid/']) {
    assert.ok(!text.includes(forbidden), `Private transport material leaked: ${forbidden === key || forbidden === password ? 'credential' : 'transport detail'}`);
  }
}
if (basename(fileURLToPath(import.meta.url)) === 'mock-preload.mjs') {
  const root = dirname(fileURLToPath(import.meta.url));
  const cases = JSON.parse(readFileSync(root + '/mock-cases.json'));
  process.env.INERT_GENERIC_MEMBER_KEY = key;
  process.env.INERT_GENERIC_ACCESS_PASSWORD = password;
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  const record = value => appendFileSync(root + '/calls.jsonl', JSON.stringify(value) + '\n');
  const fixture = (value, field) => {
    const found = cases.find(item => item.request[field] === value);
    assert.ok(found, 'UNKNOWN_FIXTURE');
    return found;
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init.method ?? 'GET';
    assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.port, ''); assert.equal(url.hash, '');
    if (url.origin === 'https://cdn.example.invalid') {
      assert.equal(method, 'GET'); assert.equal(new Headers(init.headers).has('authorization'), false);
      assert.equal(new Headers(init.headers).has('x-api-key'), false);
      assert.equal(init.headers, undefined); assert.equal(init.body, undefined);
      assert.equal(url.search, '?private=signed');
      const match = /^\/([a-z0-9]+)\/(\d+)$/.exec(url.pathname); assert.ok(match, 'UNEXPECTED_DOWNLOAD_PATH');
      const c = cases.find(item => item.id === match[1]); assert.ok(c && !c.failure);
      const index = Number(match[2]); assert.ok(index < c.resultCount);
      record({ path: url.pathname, method, fixture: c.id, download: true });
      const [name, mime] = [['image.png', 'image/png'], ['audio.wav', 'audio/wav'], ['video.mp4', 'video/mp4'], ['data.csv', 'text/csv'], ['data.bin', 'application/octet-stream']][index % 5];
      return new Response(readFileSync(root + '/assets/' + name), { headers: { 'content-type': mime } });
    }
    assert.equal(url.origin, 'https://www.runninghub.ai', 'UNEXPECTED_ORIGIN');
    if (url.pathname === '/enterprise-api/consumerApi') {
      assert.equal(method, 'GET'); assert.equal(url.search, ''); assert.equal(init.body, undefined);
      assert.equal(new Headers(init.headers).has('authorization'), false);
      record({ path: url.pathname, method });
      return new Response('Offline fixture Membership price source page; no numeric quote.');
    }
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + key);
    assert.equal(init.redirect, 'error');
    if (url.pathname === '/api/webapp/apiCallDemo') {
      assert.equal(method, 'GET'); assert.equal(init.body, undefined);
      assert.deepEqual([...url.searchParams.keys()].sort(), ['apiKey', 'webappId']);
      assert.equal(url.searchParams.get('apiKey'), key);
      const c = fixture(url.searchParams.get('webappId'), 'webappId');
      record({ path: url.pathname, method, fixture: c.id, webappId: c.request.webappId });
      return json({ code: 0, data: { ...c.metadata, curl: 'curl -H "Authorization: Bearer ' + key + '" --data "accessPassword=' + password + '"', statisticsInfo: { count: 999 } } });
    }
    assert.equal(method, 'POST'); assert.equal(url.search, '');
    if (url.pathname === '/task/openapi/upload') {
      assert.deepEqual([...init.body.keys()].sort(), ['apiKey', 'file', 'fileType']);
      assert.equal(init.body.get('apiKey'), key); assert.equal(init.body.get('fileType'), 'input');
      const file = init.body.get('file');
      const expected = [['image.png', 'image/png'], ['audio.wav', 'audio/wav'], ['video.mp4', 'video/mp4']].find(([, mime]) => mime === file.type);
      assert.ok(expected, 'UNEXPECTED_UPLOAD_TYPE');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), readFileSync(root + '/assets/' + expected[0]));
      record({ path: url.pathname, method });
      appendFileSync(root + '/uploads.jsonl', JSON.stringify({ name: file.name, type: file.type, size: file.size }) + '\n');
      return json({ code: 0, data: { fileName: 'api/exact-' + file.name, fileType: 'input' } });
    }
    const body = JSON.parse(init.body);
    if (!['/uc/openapi/accountStatus', '/openapi/v2/query'].includes(url.pathname)) assert.equal(body.apiKey, key);
    if (url.pathname === '/uc/openapi/accountStatus') {
      assert.deepEqual(Object.keys(body), ['apikey']); assert.equal(body.apikey, key); record({ path: url.pathname, method });
      return json({ code: 0, data: { apiType: 'NORMAL', remainCoins: '1000' } });
    }
    if (url.pathname === '/api/openapi/getJsonApiFormat') {
      assert.deepEqual(Object.keys(body).sort(), ['apiKey', 'workflowId']);
      const c = fixture(body.workflowId, 'workflowId'); record({ path: url.pathname, method, fixture: c.id });
      return json({ code: 0, data: { prompt: JSON.stringify(c.graph) } });
    }
    if (url.pathname === '/task/openapi/create' || url.pathname === '/task/openapi/ai-app/run') {
      const app = url.pathname.endsWith('/ai-app/run');
      const c = fixture(body[app ? 'webappId' : 'workflowId'], app ? 'webappId' : 'workflowId');
      assert.notEqual(c.failure, 'invalid-review', 'INVALID_REVIEW_SUBMITTED');
      const expectedKeys = ['apiKey', 'nodeInfoList', app ? 'webappId' : 'workflowId', ...(body.workflow !== undefined ? ['workflow'] : []), ...(c.request.instanceType ? ['instanceType'] : []), ...(!app || c.metadata.accessEncrypted ? ['accessPassword'] : [])];
      assert.deepEqual(Object.keys(body).sort(), expectedKeys.sort());
      if (c.request.instanceType) assert.equal(body.instanceType, c.request.instanceType);
      if (!app || c.metadata.accessEncrypted) assert.equal(body.accessPassword, password);
      else assert.equal(body.accessPassword, undefined);
      const expectedNodes = [...c.request.nodeInfoList, ...c.request.bindings.map(binding => ({ nodeId: binding.nodeId, fieldName: binding.fieldName, fieldValue: body.nodeInfoList.find(node => node.nodeId === binding.nodeId && node.fieldName === binding.fieldName)?.fieldValue }))];
      assert.deepEqual(body.nodeInfoList, expectedNodes);
      for (const node of body.nodeInfoList.slice(c.request.nodeInfoList.length)) assert.match(node.fieldValue, /^api\/exact-/);
      if (body.workflow) {
        const graph = JSON.parse(body.workflow);
        for (const node of body.nodeInfoList) assert.deepEqual(graph[node.nodeId].inputs[node.fieldName], node.fieldValue);
      }
      record({ path: url.pathname, method, fixture: c.id, instanceType: body.instanceType, passwordSent: body.accessPassword !== undefined });
      const { apiKey, accessPassword, ...safeWire } = body;
      appendFileSync(root + '/wire.jsonl', JSON.stringify(safeWire) + '\n');
      return json({ code: 0, data: { taskId: 'task-' + c.id } });
    }
    if (url.pathname === '/openapi/v2/query') {
      assert.deepEqual(Object.keys(body), ['taskId']);
      const c = cases.find(item => 'task-' + item.id === body.taskId); assert.ok(c);
      record({ path: url.pathname, method, fixture: c.id });
      return json({ taskId: body.taskId, status: 'SUCCESS', ...(c.failure === 'money' ? { promptTips: key + ' ' + password } : {}), results: Array.from({ length: c.resultCount }, (_, i) => ({ url: 'https://cdn.example.invalid/' + c.id + '/' + i + '?private=signed', outputType: ['png', 'wav', 'mp4', 'csv', 'novel'][i % 5], index: i })), usage: { consumeCoins: '1', consumeMoney: c.failure === 'money' ? '0.01' : null, thirdPartyConsumeMoney: null, taskCostTime: '1' } });
    }
    throw Error('UNEXPECTED_PATH');
  };
}
