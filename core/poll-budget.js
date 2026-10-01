import { fail } from './errors.js';
import { validTaskId } from './submission-machine.js';

// One budget document per acknowledged operation. Adapter will schedule each
// separate query with Hypit wakeAt rather than spin in a local polling loop.
export async function updatePollBudget({ journal, taskId, now, limits, event = 'check' }) {
  if (!validTaskId(taskId) || !Number.isFinite(now) || !['check', 'transient-failure', 'observed'].includes(event)) fail('INVALID_POLL_BUDGET');
  if (!limits || !Number.isSafeInteger(limits.intervalMs) || limits.intervalMs < 1 || limits.intervalMs > 600_000
    || !Number.isSafeInteger(limits.maxElapsedMs) || limits.maxElapsedMs < 1 || limits.maxElapsedMs > 86_400_000
    || !Number.isSafeInteger(limits.maxConsecutiveTransientFailures) || limits.maxConsecutiveTransientFailures < 1
    || limits.maxConsecutiveTransientFailures > 20) fail('INVALID_POLL_BUDGET');
  const release = await journal.acquire();
  try {
    let state = await journal.read();
    if (!state) state = { version: 1, action: 'poll', taskId, startedAt: now, consecutiveFailures: 0 };
    if (state.version !== 1 || state.action !== 'poll' || state.taskId !== taskId || !Number.isFinite(state.startedAt)
      || !Number.isInteger(state.consecutiveFailures) || state.consecutiveFailures < 0) fail('POLL_JOURNAL_MISMATCH');
    if (now < state.startedAt) fail('CLOCK_MOVED_BACKWARDS');
    if (event === 'transient-failure') state.consecutiveFailures++;
    if (event === 'observed') state.consecutiveFailures = 0;
    await journal.write(state);
    if (now - state.startedAt >= limits.maxElapsedMs) fail('POLL_DEADLINE_EXCEEDED', { taskIds: [taskId] });
    if (state.consecutiveFailures >= limits.maxConsecutiveTransientFailures) fail('POLL_FAILURE_LIMIT', { taskIds: [taskId] });
    return { taskId, wakeAt: Math.min(now + limits.intervalMs, state.startedAt + limits.maxElapsedMs) };
  } finally { await release(); }
}
