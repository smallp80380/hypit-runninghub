import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { openJournal } from '../core/journal.js';
import { acknowledgedTaskId, acquirePreparation, runJournaledAction } from '../core/submission-machine.js';

const [mode, dataRoot] = process.argv.slice(2);
const fingerprint = 'a'.repeat(64);
const policy = { maxAttempts: 3, initialDelayMs: 2, maxDelayMs: 10 };
const clock = { now: () => 100, sleep: async () => assert.fail('recovery must not retry') };
const options = { dataRoot, instance: 'crash-endpoint', operation: 'crash-operation' };
const preparation = await openJournal({ ...options, journalDirectory: 'preparation' });
const submit = await openJournal({ ...options, journalDirectory: 'submit' });
globalThis.fetch = async () => assert.fail('crash regression must never use HTTP');
const send = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));

if (mode === 'first') {
  const release = await acquirePreparation(preparation, submit, fingerprint);
  assert.equal(typeof release, 'function');
  await preparation.write({ version: 1, fingerprint, state: 'ready', preparedBody: { fixture: 'inert' } });
  await runJournaledAction({ journal: submit, fingerprint, policy, clock,
    invoke: async () => ({ taskId: 'durable-crash-task' }),
    checkpoint: async value => {
      const saved = await submit.read();
      assert.equal(acknowledgedTaskId(saved, fingerprint), value.handle.taskId);
      assert.equal(saved.attempts.length, 1);
      assert.equal(saved.attempts[0].outcome, 'acknowledged');
      assert.equal((await preparation.read()).state, 'ready');
      assert.equal((await stat(preparation.lock)).isDirectory(), true);
      assert.equal((await stat(submit.lock)).isDirectory(), true);
      await send({ type: 'ready', taskId: value.handle.taskId });
      // Only SIGKILL ends this checkpoint: both durable locks remain in place.
      await new Promise(() => { setInterval(() => {}, 60_000); });
    },
  });
  assert.fail('the first worker must be killed inside its checkpoint');
} else if (mode === 'second') {
  const release = await acquirePreparation(preparation, submit, fingerprint);
  assert.equal(release, undefined);
  const checkpoints = [];
  const readOnly = { ...submit,
    acquire: async () => assert.fail('resumeOnly must not acquire any lock'),
    write: async () => assert.fail('ACK replay must not write state'),
  };
  const forbidden = async () => assert.fail('ACK replay must not invoke or preflight');
  const checkpoint = async value => { checkpoints.push(value); };
  const result = await runJournaledAction({ journal: readOnly, fingerprint, policy, clock,
    resumeOnly: true, invoke: forbidden, beforeAttempt: forbidden, checkpoint });
  // Direct machine callers also recover an ACK under the existing submit lock.
  const fallback = await runJournaledAction({ journal: { ...submit, write: readOnly.write },
    fingerprint, policy, clock, invoke: forbidden, beforeAttempt: forbidden, checkpoint });
  assert.deepEqual(result, { taskId: 'durable-crash-task', receipt: { taskId: 'durable-crash-task' }, resumed: true });
  assert.deepEqual(fallback, result);
  assert.equal(checkpoints.length, 2);
  await send({ type: 'resumed', result, fallback, checkpoints });
} else {
  assert.fail('unknown crash worker mode');
}
