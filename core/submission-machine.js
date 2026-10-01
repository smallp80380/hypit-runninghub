import { ProviderError, fail, safeError } from './errors.js';

export const validTaskId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

// Internal transport-independent state machine. Tests supply inert callbacks.
// No credential resolution, SDK activation or public billing bypass lives here.
export async function runJournaledAction({ journal, fingerprint, action = 'submit', policy, clock, invoke, checkpoint, beforeAttempt }) {
  if (!['submit', 'upload'].includes(action) || !/^[a-f0-9]{64}$/.test(fingerprint)
    || policy.maxAttempts !== 3) fail('INVALID_ACTION');
  const release = await journal.acquire();
  try {
    let state = await journal.read();
    if (!state) state = { version: 1, action, fingerprint, state: 'prepared', attempts: [], taskIds: [] };
    if (state.version !== 1 || state.action !== action || state.fingerprint !== fingerprint
      || !Array.isArray(state.attempts) || state.attempts.length > 3 || !Array.isArray(state.taskIds)
      || state.taskIds.length > 3 || state.taskIds.some(id => !validTaskId(id))) fail('JOURNAL_IDENTITY_MISMATCH');
    async function persist() {
      try { await journal.write(state); }
      catch (error) {
        // A received ID survives even if private persistence cannot finish.
        // The earlier in-flight intent still blocks any new submit series.
        if (state.taskIds.length) throw new ProviderError('ACK_PERSISTENCE_FAILED', { taskIds: [...state.taskIds] });
        throw error;
      }
    }
    const resumed = state.taskIds.length > 0;
    async function acknowledge(taskId) {
      if (checkpoint) {
        try { await checkpoint({ handle: { taskId }, receipt: { taskId } }); }
        catch { fail('CHECKPOINT_FAILED_RESUME', { taskIds: [taskId] }); }
      }
      return { taskId, receipt: { taskId }, resumed };
    }
    if (state.taskIds.length) return await acknowledge(state.taskIds[0]);
    if (state.state === 'completed' && action === 'upload') return { uploadResult: state.uploadResult, resumed: true };
    if (['in-flight', 'unknown', 'failed'].includes(state.state)) fail('OUTCOME_UNKNOWN_NO_NEW_SERIES');
    while (state.attempts.length < policy.maxAttempts) {
      const attempt = state.attempts.length + 1;
      if (state.nextAttemptAt !== undefined && state.nextAttemptAt > clock.now()) await clock.sleep(state.nextAttemptAt - clock.now());
      // Read-only billing/revision admission is outside the paid retry intent.
      // A preflight failure never spends an attempt or enters paid retries.
      if (beforeAttempt) {
        try { await beforeAttempt({ attempt }); }
        catch (error) {
          state.preflightFailure = { at: clock.now(), error: safeError(error) };
          await persist();
          throw error;
        }
      }
      delete state.preflightFailure;
      state.state = 'in-flight'; delete state.nextAttemptAt;
      state.attempts.push({ attempt, startedAt: clock.now(), outcome: 'in-flight' });
      await persist();
      try {
        const result = await invoke({ attempt });
        if (action === 'submit') {
          if (!validTaskId(result?.taskId)) throw new ProviderError('ACKNOWLEDGEMENT_MISSING', { category: 'unknown' });
          state.taskIds.push(result.taskId); state.state = 'acknowledged';
        } else {
          if (typeof result?.uploadResult !== 'string' || !result.uploadResult || result.uploadResult.length > 4096) fail('UPLOAD_RESULT_INVALID');
          // Upload URLs/filenames remain private journal state, never receipt/logs.
          state.uploadResult = result.uploadResult; state.state = 'completed';
        }
        state.attempts.at(-1).outcome = state.state; state.attempts.at(-1).finishedAt = clock.now();
        await persist();
      } catch (error) {
        if (state.taskIds.length) throw error;
        const publicError = safeError(error);
        if (error instanceof ProviderError && error.taskIds.length) {
          const ids = error.taskIds.filter(validTaskId);
          if (ids.length) {
            state.taskIds = [...new Set([...state.taskIds, ...ids])].slice(0, 3); state.state = 'acknowledged';
            state.attempts.at(-1).outcome = 'acknowledged'; state.attempts.at(-1).error = publicError;
            await persist(); return await acknowledge(state.taskIds[0]);
          }
        }
        state.attempts.at(-1).error = publicError; state.attempts.at(-1).finishedAt = clock.now();
        const retry = publicError.retryable && attempt < policy.maxAttempts;
        state.state = retry ? 'retryable' : publicError.retryable ? 'unknown' : 'failed';
        state.attempts.at(-1).outcome = state.state;
        if (retry) state.nextAttemptAt = clock.now() + Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
        await persist();
        if (!retry) throw error instanceof ProviderError ? error : new ProviderError('UNCLASSIFIED_ERROR');
        continue;
      }
      if (action === 'submit') return await acknowledge(state.taskIds[0]);
      return { uploadResult: state.uploadResult, resumed: false };
    }
    fail('ATTEMPT_BUDGET_EXHAUSTED');
  } finally { await release(); }
}
