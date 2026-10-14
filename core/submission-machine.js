import { ProviderError, fail, safeError } from './errors.js';

export const validTaskId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
const validTimestamp = value => value === undefined || (typeof value === 'number' && Number.isFinite(value));
function validIdentity(state, fingerprint, action) {
  return record(state) && /^[a-f0-9]{64}$/.test(fingerprint)
    && state.version === 1 && state.action === action && state.fingerprint === fingerprint;
}
function validTaskIds(ids, minimum = 0) {
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > 3) return false;
  for (let index = 0; index < ids.length; index++)
    if (!validTaskId(ids[index]) || ids.indexOf(ids[index]) !== index) return false;
  return true;
}
function validHistory(attempts, outcome) {
  if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 3) return false;
  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    if (!record(attempt) || attempt.attempt !== index + 1
      || attempt.outcome !== (index === attempts.length - 1 ? outcome : 'retryable')
      || !validTimestamp(attempt.startedAt) || !validTimestamp(attempt.finishedAt)) return false;
  }
  return true;
}

// A received ID alone is not a durable submit acknowledgement.
export function acknowledgedTaskId(state, fingerprint) {
  if (!validIdentity(state, fingerprint, 'submit') || state.state !== 'acknowledged'
    || !validTimestamp(state.nextAttemptAt) || !validTaskIds(state.taskIds, 1)
    || !validHistory(state.attempts, 'acknowledged')) return undefined;
  return state.taskIds[0];
}

export async function acquirePreparation(preparationJournal, submitJournal, fingerprint) {
  try { return await preparationJournal.acquire(); }
  catch (error) {
    if (error.code !== 'OPERATION_LOCKED'
      || !acknowledgedTaskId(await submitJournal.read(), fingerprint)) throw error;
    // The existing lock is untouched; this grants read-only ACK recovery only.
    return undefined;
  }
}

function validActionState(state, fingerprint, action) {
  if (!validIdentity(state, fingerprint, action) || !validTaskIds(state.taskIds)
    || !validTimestamp(state.nextAttemptAt)) return false;
  if (state.state === 'acknowledged') return acknowledgedTaskId(state, fingerprint) !== undefined && action === 'submit';
  if (state.taskIds.length) return false;
  if (state.state === 'prepared') return Array.isArray(state.attempts) && state.attempts.length === 0;
  if (state.state === 'completed') return action === 'upload' && validHistory(state.attempts, 'completed')
    && typeof state.uploadResult === 'string' && state.uploadResult.length > 0 && state.uploadResult.length <= 4096;
  return ['retryable', 'in-flight', 'unknown', 'failed'].includes(state.state)
    && validHistory(state.attempts, state.state) && (state.state !== 'retryable' || state.attempts.length < 3);
}

async function acknowledge(taskId, checkpoint, resumed) {
  if (checkpoint) {
    try { await checkpoint({ handle: { taskId }, receipt: { taskId } }); }
    catch { fail('CHECKPOINT_FAILED_RESUME', { taskIds: [taskId] }); }
  }
  return { taskId, receipt: { taskId }, resumed };
}

async function replayAcknowledgement(journal, fingerprint, checkpoint, lockedError) {
  const taskId = acknowledgedTaskId(await journal.read(), fingerprint);
  if (!taskId) {
    if (lockedError) throw lockedError;
    fail('JOURNAL_IDENTITY_MISMATCH');
  }
  return await acknowledge(taskId, checkpoint, true);
}

// Internal transport-independent state machine. Tests supply inert callbacks.
// No credential resolution, SDK activation or public billing bypass lives here.
export async function runJournaledAction({ journal, fingerprint, action = 'submit', policy, clock, invoke, checkpoint, beforeAttempt, resumeOnly = false }) {
  if (!['submit', 'upload'].includes(action) || !/^[a-f0-9]{64}$/.test(fingerprint)
    || policy.maxAttempts !== 3 || typeof resumeOnly !== 'boolean' || (resumeOnly && action !== 'submit')) fail('INVALID_ACTION');
  if (resumeOnly) return await replayAcknowledgement(journal, fingerprint, checkpoint);
  let release;
  try { release = await journal.acquire(); }
  catch (error) {
    if (error.code !== 'OPERATION_LOCKED' || action !== 'submit') throw error;
    return await replayAcknowledgement(journal, fingerprint, checkpoint, error);
  }
  try {
    let state = await journal.read();
    if (state === undefined) state = { version: 1, action, fingerprint, state: 'prepared', attempts: [], taskIds: [] };
    if (!validActionState(state, fingerprint, action)) fail('JOURNAL_IDENTITY_MISMATCH');
    async function persist() {
      try { await journal.write(state); }
      catch (error) {
        // A received ID survives even if private persistence cannot finish.
        // The earlier in-flight intent still blocks any new submit series.
        if (state.taskIds.length) throw new ProviderError('ACK_PERSISTENCE_FAILED', { taskIds: [...state.taskIds] });
        throw error;
      }
    }
    const taskId = action === 'submit' ? acknowledgedTaskId(state, fingerprint) : undefined;
    if (taskId) return await acknowledge(taskId, checkpoint, true);
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
        if (action === 'submit' && error instanceof ProviderError && error.taskIds.length) {
          const ids = error.taskIds.filter(validTaskId);
          if (ids.length) {
            state.taskIds = [...new Set([...state.taskIds, ...ids])].slice(0, 3); state.state = 'acknowledged';
            state.attempts.at(-1).outcome = 'acknowledged'; state.attempts.at(-1).error = publicError;
            await persist(); return await acknowledge(state.taskIds[0], checkpoint, false);
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
      if (action === 'submit') return await acknowledge(state.taskIds[0], checkpoint, false);
      return { uploadResult: state.uploadResult, resumed: false };
    }
    fail('ATTEMPT_BUDGET_EXHAUSTED');
  } finally { await release(); }
}
