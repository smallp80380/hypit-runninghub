import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '../core/errors.js';
import { appFixture, failed, noEffects, publicSafe, KEY, PASSWORD, mixedOutputs } from './ai-app-fixture.js';

async function route(f, kind) {
  return kind === 'workflow'
    ? { endpoint: f.workflowEndpoint, ctx: await f.workflowContext() }
    : { endpoint: f.endpoint, ctx: f.ctx };
}
function untouched(f) {
  noEffects(f);
  assert.equal(f.calls.length, 0, 'Credential failures must not reach HTTP');
  assert.equal(f.state.resourceReads, 0, 'Credential failures must not read resources');
}

for (const kind of ['ai-app', 'workflow']) {
  test(`${kind} disabled start does not access credentials`, async t => {
    const f = await appFixture(t);
    f.config.submissionEnabled = false;
    f.restart();
    const { endpoint, ctx } = await route(f, kind);
    let reads = 0;
    Object.defineProperty(ctx, 'credentials', { get() { reads++; throw new Error(KEY); } });
    const result = await endpoint.start(ctx);
    failed(result, 'SUBMISSION_DISABLED');
    assert.equal(reads, 0);
    publicSafe(result);
    untouched(f);
  });

  test(`${kind} mismatched capability start does not access credentials`, async t => {
    const f = await appFixture(t);
    const { endpoint, ctx } = await route(f, kind);
    const other = await route(f, kind === 'workflow' ? 'ai-app' : 'workflow');
    const wrong = { ...ctx, need: other.ctx.need };
    let reads = 0;
    Object.defineProperty(wrong, 'credentials', { get() { reads++; throw new Error(KEY); } });
    const result = await endpoint.start(wrong);
    failed(result, 'CAPABILITY_MISMATCH');
    assert.equal(reads, 0);
    publicSafe(result);
    untouched(f);
  });

  for (const method of ['start', 'poll', 'collect']) {
    for (const [slot, location] of [['apiKey', 'slot'], ['apiKey', 'secret'], ['accessPassword', 'slot'], ['accessPassword', 'secret']]) {
      test(`${kind} ${method} contains throwing ${slot} ${location} getter`, async t => {
        const f = await appFixture(t, { password: true });
        const { endpoint, ctx } = await route(f, kind);
        let reads = 0;
        const credentials = { apiKey: { secret: KEY }, accessPassword: { secret: PASSWORD } };
        Object.defineProperty(location === 'slot' ? credentials : credentials[slot], location === 'slot' ? slot : 'secret', { get() {
          reads++;
          throw new Error(`Private credential getter: ${KEY} ${PASSWORD}`);
        } });
        const result = await endpoint[method]({ ...ctx, credentials, handle: { taskId: 'safe-existing-task' } });
        failed(result, 'UNCLASSIFIED_ERROR');
        assert.equal(result.receipt, undefined);
        assert.equal(reads, 1);
        publicSafe(result);
        untouched(f);
      });
    }

    test(`${kind} ${method} suppresses receipts after partial credential capture`, async t => {
      const f = await appFixture(t, { password: true });
      const { endpoint, ctx } = await route(f, kind);
      const credentials = { apiKey: { secret: KEY } };
      Object.defineProperty(credentials, 'accessPassword', { get() {
        throw new ProviderError('CREDENTIAL_MISSING', { taskIds: [PASSWORD, `task-${KEY}`, 'safe-error-task'] });
      } });
      const result = await endpoint[method]({ ...ctx, credentials, handle: { taskId: `handle-${KEY}` } });
      failed(result, 'CREDENTIAL_MISSING');
      assert.equal(result.receipt, undefined);
      publicSafe(result);
      // The uncaptured password cannot be safely distinguished from a task ID.
      const fallbackCredentials = { apiKey: credentials.apiKey };
      Object.defineProperty(fallbackCredentials, 'accessPassword', { get() { throw new Error(PASSWORD); } });
      const fallback = await endpoint[method]({ ...ctx, credentials: fallbackCredentials, handle: { taskId: PASSWORD } });
      failed(fallback, 'UNCLASSIFIED_ERROR');
      assert.equal(fallback.receipt, undefined);
      publicSafe(fallback);
      untouched(f);
    });

    test(`${kind} ${method} preserves missing credential failures`, async t => {
      const f = await appFixture(t, { password: true });
      const { endpoint, ctx } = await route(f, kind);
      for (const [credentials, code] of [
        [{ accessPassword: { secret: PASSWORD } }, 'CREDENTIAL_MISSING'],
        [{ apiKey: { secret: KEY } }, 'ACCESS_PASSWORD_REQUIRED'],
      ]) {
        const result = await endpoint[method]({ ...ctx, credentials, handle: { taskId: PASSWORD } });
        failed(result, code);
        assert.equal(result.receipt, undefined);
        publicSafe(result);
      }
      untouched(f);
    });
  }
  for (const method of ['poll', 'collect']) {
    test(`${kind} ${method} filters both secrets only after complete credential capture`, async t => {
      const f = await appFixture(t, { password: true });
      const { endpoint, ctx } = await route(f, kind);
      for (const taskId of ['safe-existing-task', KEY, PASSWORD]) {
        const result = await endpoint[method]({ ...ctx, handle: { taskId } });
        failed(result, 'HANDLE_MISMATCH');
        assert.deepEqual(result.receipt, taskId === 'safe-existing-task' ? { id: taskId } : undefined);
        publicSafe(result);
      }
      untouched(f);
    });
  }

  for (const secondRead of ['throw', 'rotate']) {
    test(`${kind} captures the context credentials getter once despite subsequent ${secondRead}`, async t => {
      const f = await appFixture(t, { password: true });
      const { endpoint, ctx } = await route(f, kind);
      async function invoke(method, handle) {
        let reads = 0;
        const input = { ...ctx, ...(handle === undefined ? {} : { handle }) };
        Object.defineProperty(input, 'credentials', { enumerable: true, get() {
          reads++;
          if (reads === 1) return ctx.credentials;
          if (secondRead === 'throw') throw new Error(`${KEY} ${PASSWORD}`);
          return { apiKey: { secret: 'rotated-inert-key' }, accessPassword: { secret: 'rotated-inert-password' } };
        } });
        const result = await endpoint[method](input);
        assert.equal(reads, 1, `${method} must capture context credentials exactly once`);
        return result;
      }
      const taskId = kind === 'workflow' ? 'workflow-fixture-task' : 'app-fixture-task';
      const started = await invoke('start');
      assert.equal(started.status, 'pending', JSON.stringify(started));
      assert.deepEqual(started.receipt, { id: taskId });
      const ready = await invoke('poll', started.handle);
      assert.equal(ready.status, 'ready', JSON.stringify(ready));
      const completed = await invoke('collect', ready.handle);
      assert.equal(completed.status, 'completed', JSON.stringify(completed));
      assert.deepEqual(completed.receipt, { id: taskId });
      assert.equal(completed.result.value.value.outputs.length, mixedOutputs.length);
      for (const [index, item] of mixedOutputs.entries()) {
        assert.deepEqual(f.writes[index].bytes, item.bytes);
        assert.equal(f.writes[index].mediaType, item.mime);
      }
      publicSafe([started, ready, completed]);
    });
  }


  test(`${kind} execution never reads an unconfigured password and captures key once per method`, async t => {
    const f = await appFixture(t);
    const { endpoint, ctx } = await route(f, kind);
    let passwordReads = 0, keyReads = 0;
    const credentials = { apiKey: {} };
    Object.defineProperty(credentials.apiKey, 'secret', { get() {
      keyReads++;
      return KEY;
    } });
    Object.defineProperty(credentials, 'accessPassword', { get() {
      passwordReads++;
      throw new Error(PASSWORD);
    } });
    const input = { ...ctx, credentials };
    const taskId = kind === 'workflow' ? 'workflow-fixture-task' : 'app-fixture-task';
    const started = await endpoint.start(input);
    assert.equal(started.status, 'pending', JSON.stringify(started));
    assert.deepEqual(started.receipt, { id: taskId });
    assert.equal(keyReads, 1);
    const ready = await endpoint.poll({ ...input, handle: started.handle });
    assert.equal(ready.status, 'ready', JSON.stringify(ready));
    assert.deepEqual(ready.receipt, { id: taskId });
    assert.equal(keyReads, 2);
    const completed = await endpoint.collect({ ...input, handle: ready.handle });
    assert.equal(completed.status, 'completed', JSON.stringify(completed));
    assert.deepEqual(completed.receipt, { id: taskId });
    assert.equal(completed.result.value.value.taskId, taskId);
    assert.equal(keyReads, 3);
    assert.equal(passwordReads, 0);
    assert.equal(completed.result.value.value.outputs.length, mixedOutputs.length);
    for (const [index, item] of mixedOutputs.entries()) {
      assert.deepEqual(f.writes[index].bytes, item.bytes);
      assert.equal(f.writes[index].mediaType, item.mime);
    }
    publicSafe([started, ready, completed]);
  });
}
