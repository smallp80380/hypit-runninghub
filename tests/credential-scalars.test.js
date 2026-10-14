import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { containsSecret, secretFree, redactSecrets, metadata } from '../generic/operation-sanitization.js';
import { aiAppRequestDigest } from '../ai-app/request.js';
import { appFixture, failed, noEffects, publicSafe, mixedOutputs, PNG } from './ai-app-fixture.js';

const NUMERIC_PASSWORD = '731952';
const numericEcho = Number(NUMERIC_PASSWORD);

function assertSanitizedNested(actual, safe) {
  assert.ok(!JSON.stringify(actual).includes(NUMERIC_PASSWORD));
  assert.deepEqual(actual.safe, safe);
  assert.deepEqual(actual.array.slice(-3), [731953, false, null]);
}

function beforeAnyCalls(f) {
  noEffects(f);
  assert.equal(f.state.metadataReads, 0);
  assert.equal(f.state.accountReads, 0);
  assert.equal(f.state.resourceReads, 0);
  assert.equal(f.calls.length, 0);
}

// The scalar's JSON spelling, not a guessed credential format or minimum
// length, defines an echo. Adjacent non-echo values keep their JSON types.
test('credential guards cover every finite JSON primitive spelling', () => {
  const aliases = [
    ['731952', 731952], ['false', false], ['true', true], ['null', null],
    ['0', -0], ['1e+21', 1e21],
  ];
  for (const [secret, value] of aliases) {
    assert.equal(containsSecret(value, [secret]), true);
    assert.throws(() => secretFree({ nested: [value] }, [secret], 'CREDENTIAL_IN_OPERATION_INPUT'),
      error => error.code === 'CREDENTIAL_IN_OPERATION_INPUT');
    assert.ok(!JSON.stringify(redactSecrets({ nested: [value] }, [secret])).includes(secret));
    assert.ok(!JSON.stringify(metadata({ nested: [value] }, [secret])).includes(secret));
  }
  const safe = { number: 731953, negative: -4.5, zero: 0, yes: true, no: false, nil: null, array: [17, false, null] };
  assert.deepEqual(redactSecrets(safe, [NUMERIC_PASSWORD]), safe);
  assert.deepEqual(metadata(safe, [NUMERIC_PASSWORD]), safe);
});

test('App primitive credential echoes fail before metadata, account, upload or submit', async t => {
  for (const [password, value] of [[NUMERIC_PASSWORD, numericEcho], ['false', false], ['true', true], ['null', null]]) {
    await t.test(password, async child => {
      const f = await appFixture(child, { password });
      f.request.nodeInfoList[0].fieldValue = value;
      failed(await f.endpoint.start(f.ctx), 'CREDENTIAL_IN_OPERATION_INPUT');
      beforeAnyCalls(f);
    });
  }
});

test('Workflow graph numeric credential literal fails before any effects', async t => {
  const f = await appFixture(t, { password: NUMERIC_PASSWORD });
  const ctx = await f.workflowContext();
  ctx.graph['1'].inputs.nested = { literal: [numericEcho] };
  ctx.need.constraints.workflowJson = JSON.stringify(ctx.graph);
  failed(await f.workflowEndpoint.start(ctx), 'CREDENTIAL_IN_OPERATION_INPUT');
  beforeAnyCalls(f);
});

test('SUCCESS scalar echoes redact private evidence and exported metadata without changing files', async t => {
  const f = await appFixture(t, { files: 0, password: NUMERIC_PASSWORD });
  const safe = { adjacent: 731953, zero: 0, fraction: 2.5, yes: true, no: false, nil: null };
  const nested = { echo: numericEcho, safe, array: [numericEcho, 731953, false, null] };
  const query = { taskId: 'app-fixture-task', status: 'SUCCESS', arbitrary: { nested },
    results: mixedOutputs.map((item, index) => ({
      url: `https://cdn.example.invalid/files/${index}?signature=PRIVATE_SIGNED_OUTPUT_${index}`,
      outputType: item.outputType, nested,
    })) };
  f.state.onQuery = () => query;
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const observation = (await (await f.journal('/observations')).read()).response;
  assertSanitizedNested(observation.arbitrary.nested, safe);
  for (const item of observation.results) assertSanitizedNested(item.nested, safe);
  const saved = await (await f.journal('/results')).read();
  for (const item of saved.results) assertSanitizedNested(item.nested, safe);
  assert.ok(!JSON.stringify([observation, saved]).includes(NUMERIC_PASSWORD));
  const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const outputs = completed.result.value.value.outputs;
  assert.equal(outputs.length, mixedOutputs.length);
  for (const [index, item] of mixedOutputs.entries()) {
    assertSanitizedNested(outputs[index].metadata.nested, safe);
    assert.deepEqual(f.writes[index].bytes, item.bytes);
    assert.equal(f.writes[index].mediaType, item.mime);
    assert.equal(outputs[index].blob.mediaType, item.mime);
    assert.equal(outputs[index].blob.size, item.bytes.length);
    assert.equal(outputs[index].outputType, item.outputType);
  }
  publicSafe([started, ready, completed], [NUMERIC_PASSWORD]);
});

test('admitted SDK Blob identity and byte length do not become credential echoes', async t => {
  const f = await appFixture(t, { password: '8', resourceIds: ['res_8_sdk_owned_blob'], items: [mixedOutputs[0]] });
  f.state.inputs[0] = PNG;
  f.request.files[0].blob.size = PNG.length;
  f.review.requestDigest = aiAppRequestDigest(f.request);
  f.review.fileDigests[0].sha256 = createHash('sha256').update(PNG).digest('hex');
  await f.saveReview();
  const original = f.request.nodeInfoList[0].fieldValue;
  f.request.nodeInfoList[0].fieldValue = 8;
  failed(await f.endpoint.start(f.ctx), 'CREDENTIAL_IN_OPERATION_INPUT');
  beforeAnyCalls(f);
  f.request.nodeInfoList[0].fieldValue = original;
  const started = await f.endpoint.start(f.ctx), ctx = { ...f.ctx, handle: started.handle };
  assert.equal(started.status, 'pending', JSON.stringify(started));
  assert.equal((await f.endpoint.poll(ctx)).status, 'ready');
  const completed = await f.endpoint.collect(ctx);
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  assert.deepEqual(f.writes, [{ bytes: PNG, mediaType: 'image/png' }]);
  assert.equal(completed.result.value.value.outputs[0].blob.size, PNG.length);
});

test('parameterless App accepts a one-character password without scanning generated Blob sizes', async t => {
  const f = await appFixture(t, { parameterless: true, password: '8', items: [mixedOutputs[0]] });
  assert.deepEqual(f.request.nodeInfoList, []);
  assert.deepEqual(f.state.metadata.nodeInfoList, []);
  const started = await f.endpoint.start(f.ctx);
  assert.equal(started.status, 'pending', JSON.stringify(started));
  const ready = await f.endpoint.poll({ ...f.ctx, handle: started.handle });
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  const completed = await f.endpoint.collect({ ...f.ctx, handle: ready.handle });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const output = completed.result.value.value.outputs[0];
  assert.equal(output.blob.size, 8);
  assert.equal(output.blob.mediaType, 'image/png');
  assert.deepEqual(f.writes[0].bytes, PNG);
  assert.equal(f.writes[0].mediaType, 'image/png');
});
