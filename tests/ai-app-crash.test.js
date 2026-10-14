import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

function worker(mode) {
  const child = fork(new URL('./ai-app-crash-worker.mjs', import.meta.url), [mode], {
    execArgv: ['--import', fileURLToPath(new URL('./sdk-register.js', import.meta.url))],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stdout.resume(); child.stderr.on('data', bytes => { errors += bytes; });
  return { child, errors: () => errors };
}
function message(entry) {
  return new Promise((resolve, reject) => {
    const { child } = entry;
    const finish = (error, value) => {
      clearTimeout(timer); child.off('message', received); child.off('exit', exited); child.off('error', failed);
      error ? reject(error) : resolve(value);
    };
    const received = value => finish(undefined, value);
    const exited = (code, signal) => finish(Error(`Crash worker exited early: ${code}/${signal}: ${entry.errors()}`));
    const failed = error => finish(error);
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Error('Crash worker readiness deadline')); }, 10000);
    child.once('message', received); child.once('exit', exited); child.once('error', failed);
  });
}
async function stop(entry) {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) return;
  const exited = once(entry.child, 'exit'); entry.child.kill('SIGKILL'); await exited;
}

test('App durable ACK survives SIGKILL inside checkpoint and resumes offline in a fresh process', { timeout: 20000 }, async () => {
  const children = []; let snapshot;
  try {
    const first = worker('checkpoint'); children.push(first); snapshot = await message(first);
    const before = await Promise.all(snapshot.files.map(path => readFile(path, 'utf8')));
    const died = once(first.child, 'exit'); first.child.kill('SIGKILL');
    const [code, signal] = await died; assert.equal(code, null); assert.equal(signal, 'SIGKILL');
    const second = worker('resume'); children.push(second);
    const resumed = message(second); second.child.send(snapshot); const observed = await resumed;
    assert.equal(observed.result.status, 'pending', JSON.stringify(observed.result));
    assert.deepEqual(observed.result.handle, snapshot.checkpoint.handle);
    assert.deepEqual(observed.result.receipt, snapshot.checkpoint.receipt);
    assert.deepEqual(observed.checkpoints, [snapshot.checkpoint]);
    assert.equal(observed.networkCalls, 0);
    assert.deepEqual(await Promise.all(snapshot.files.map(path => readFile(path, 'utf8'))), before);
    for (const lock of snapshot.locks) assert.ok((await stat(lock)).isDirectory(), 'Recovery must not reclaim crash-persistent locks');
  } finally {
    await Promise.all(children.map(stop));
    if (snapshot) await rm(snapshot.dataRoot, { recursive: true, force: true });
  }
});
