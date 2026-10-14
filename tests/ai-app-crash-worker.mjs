import assert from 'node:assert/strict';
import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { appFixture, KEY, PASSWORD } from './ai-app-fixture.js';
import { createWorkflowProvider } from '../generic/provider.js';
import { aiAppCapability } from '../ai-app/model.js';
import { workflowTypes } from '../generic/references.js';
import { digest } from '../native/descriptor.js';

if (process.argv[2] === 'checkpoint') {
  const f = await appFixture({ after() {} }, { files: 0, password: true, encrypted: true });
  f.ctx.checkpoint = async checkpoint => {
    const prep = await f.journal('/preparation'), submit = await f.journal();
    const state = await submit.read();
    assert.equal(state.state, 'acknowledged'); assert.equal(state.taskIds[0], checkpoint.handle.taskId);
    for (const lock of [prep.lock, submit.lock]) assert.ok((await stat(lock)).isDirectory());
    process.send({ dataRoot: f.dataRoot, instance: f.instance, config: f.config, request: f.request,
      operation: f.ctx.operation, checkpoint, files: [prep.file, submit.file], locks: [prep.lock, submit.lock] });
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  };
  await f.endpoint.start(f.ctx);
} else if (process.argv[2] === 'resume') {
  const [snapshot] = await once(process, 'message');
  let endpoint, networkCalls = 0; const checkpoints = [];
  const rejectIO = async () => { networkCalls++; throw Error('No HTTP permitted during ACK recovery'); };
  globalThis.fetch = rejectIO;
  const clock = { now: () => 1000, timeout: () => ({ signal: new AbortController().signal, cancel() {} }),
    sleep: async () => { throw Error('No retry permitted'); } };
  createWorkflowProvider({ config: snapshot.config, dataRoot: snapshot.dataRoot, instance: snapshot.instance,
    pool: snapshot.instance, fetch: rejectIO, clock }).install({
    registerAsyncEndpoint(_instance, capability, _returns, candidate) {
      if (digest(capability) === digest(aiAppCapability)) endpoint = candidate;
    },
  });
  assert.ok(endpoint);
  const result = await endpoint.start({ operation: snapshot.operation,
    need: { capability: aiAppCapability, returns: workflowTypes.result, constraints: snapshot.request },
    credentials: { apiKey: { secret: KEY }, accessPassword: { secret: PASSWORD } },
    resources: { get: async () => { throw Error('Unexpected ResourceStore read'); },
      put: async () => { throw Error('Unexpected ResourceStore write'); } },
    checkpoint: async value => { checkpoints.push(value); } });
  process.send({ result, networkCalls, checkpoints });
  process.disconnect();
} else {
  throw Error('Unknown lifecycle crash worker mode');
}
