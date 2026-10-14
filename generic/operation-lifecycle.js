import { createHash } from 'node:crypto';
import { fail, safeError } from '../core/errors.js';
import { openJournal } from '../core/journal.js';
import { runJournaledAction, validTaskId, acknowledgedTaskId, acquirePreparation } from '../core/submission-machine.js';
import { createJsonTransport, boundedBySignal, boundedBytes } from '../core/transport.js';
import { updatePollBudget } from '../core/poll-budget.js';
import { credentialSha256 } from '../native/member-binding.js';
import { digest } from '../native/descriptor.js';
import { jsonValue } from './request-json.js';
import { admitFile, safeMime } from './media.js';
import { containsSecret, containsUrlSecret, secretFree, redactSecrets, metadata,
  secretFreeRequest, secretFreeSource, secretFreePreparedBody } from './operation-sanitization.js';

const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');
function positiveMoney(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['consumeMoney', 'thirdPartyConsumeMoney'].some(key => {
    const amount = value[key];
    return typeof amount === 'string' && amount.length <= 32 && /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  });
}
function usageValue(value, secrets) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail('BILLING_USAGE_UNKNOWN');
  const result = {};
  for (const key of ['consumeMoney', 'consumeCoins', 'thirdPartyConsumeMoney', 'taskCostTime']) {
    const amount = value[key]; if (amount === undefined) continue;
    if (amount !== null && (typeof amount !== 'string' || amount.length > 32 || !/^\d+(\.\d+)?$/.test(amount))) fail('BILLING_USAGE_UNKNOWN');
    if (['consumeMoney', 'thirdPartyConsumeMoney'].includes(key) && amount !== null && Number(amount) > 0) fail('BILLING_MISMATCH');
    result[key] = amount;
  }
  // Billing validation must finish before credential checks. Fixed field names
  // and null absence sentinels are structure; only decimal strings carry usage.
  if (Object.values(result).some(amount => typeof amount === 'string' && containsSecret(amount, secrets))) fail('CREDENTIAL_IN_RESULT_USAGE');
  return result;
}

// Private durable implementation for the two native service adapters. The same
// operation root prevents a workflow operation from becoming an App operation.
export function createNativeOperationLifecycle({ config, dataRoot, instance, fetch, clock, authority, protocol }) {
  const isApp = protocol.sourceField === 'app';
  if (!isApp && protocol.sourceField !== 'graph') fail('INVALID_ACTION');
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: 'native-workflow', fetch, clock,
    timeoutMs: config.http.requestTimeoutMs, maxResponseBytes: config.http.maxResponseBytes });
  const journal = (operation, suffix = '') => openJournal({ dataRoot, instance, operation,
    journalDirectory: config.paths.journalDirectory + suffix, maxBytes: config.budgets.maxJournalBytes });
  function capture(ctx) {
    const key = ctx.credentials?.apiKey?.secret;
    if (typeof key !== 'string' || !key) fail('CREDENTIAL_MISSING');
    const password = config.accessPassword === undefined ? undefined : ctx.credentials?.accessPassword?.secret;
    if (config.accessPassword !== undefined && (typeof password !== 'string' || !password)) fail('ACCESS_PASSWORD_REQUIRED');
    return { key, password, secrets: password === undefined ? [key] : [key, password] };
  }
  const fingerprintFor = (request, { key, password }) => digest({ request, credentialSha256: credentialSha256(key), apiKey: config.apiKey, baseUrl: config.baseUrl,
    ...(isApp ? { serviceKind: 'ai-app', capability: 'run-ai-app' } : {}),
    ...(password === undefined ? {} : { accessPassword: config.accessPassword, accessPasswordSha256: credentialSha256(password) }) });
  const passwordIdentity = password => password === undefined ? {} : { accessPasswordDigest: digest(config.accessPassword), accessPasswordSha256: credentialSha256(password) };
  const passwordMatches = (prep, password) => password === undefined
    ? prep.accessPasswordDigest === undefined && prep.accessPasswordSha256 === undefined
    : prep.accessPasswordDigest === digest(config.accessPassword) && prep.accessPasswordSha256 === credentialSha256(password);
  const handle = (taskId, fingerprint) => ({ contract: protocol.handleContract, taskId, fingerprint });
  const receipt = taskId => ({ id: taskId });
  function checkedSource(source, { secrets }) {
    const checked = protocol.validateSource(source, { secrets });
    secretFreeSource(checked, secrets, isApp, isApp ? 'AI_APP_RESPONSE_UNKNOWN' : 'WORKFLOW_RESPONSE_UNKNOWN');
    return checked;
  }
  function requirePassword(source, password) {
    if (isApp && source.accessEncrypted && password === undefined) fail('ACCESS_PASSWORD_REQUIRED');
  }
  async function admittedFiles(ctx, request) {
    const result = [];
    for (const file of request.files) {
      const admitted = admitFile(file.blob, await ctx.resources.get(file.blob.resource));
      result.push({ ...file, extension: admitted.extension, sha256: bytesDigest(admitted.bytes) });
    }
    return result;
  }
  const fileDigests = files => files.map(file => ({ key: file.key, sha256: file.sha256 }));
  function unchangedFiles(files, expected) {
    if (digest(fileDigests(files)) !== digest(expected)) fail('REFERENCE_CHANGED');
  }
  function sizeGuard(record) {
    if (Buffer.byteLength(JSON.stringify(record)) > config.budgets.maxJournalBytes) fail('JOURNAL_TOO_LARGE');
  }
  function preparedSource(prep, captured) {
    const source = prep[protocol.sourceField];
    if (prep.state !== 'ready' || !source || !prep.preparedBody || prep[protocol.sourceDigestField] !== protocol.digestSource(source)
      || prep.preparedBodyDigest !== digest(prep.preparedBody)) fail('PREPARATION_IDENTITY_MISMATCH');
    checkedSource(source, captured);
    jsonValue(prep.preparedBody, config.budgets.maxJournalBytes);
    secretFreePreparedBody(prep.preparedBody, captured.secrets, isApp, 'PREPARATION_IDENTITY_MISMATCH');
    if (Object.hasOwn(prep.preparedBody, 'apiKey') || Object.hasOwn(prep.preparedBody, 'accessPassword')) fail('PREPARATION_IDENTITY_MISMATCH');
    requirePassword(source, captured.password);
    return source;
  }
  async function verifyPrepared(ctx, request, prep, fingerprint, captured) {
    const source = preparedSource(prep, captured);
    protocol.validateTargets(source, request);
    if (!Array.isArray(prep.fileDigests) || prep.fileDigests.length !== request.files.length) fail('PREPARATION_IDENTITY_MISMATCH');
    const names = new Map();
    for (const [index, file] of request.files.entries()) {
      const uploaded = await (await journal(ctx.operation, `/uploads/${digest(file.key)}`)).read();
      const admitted = prep.fileDigests[index];
      if (admitted?.key !== file.key || typeof admitted.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(admitted.sha256)
        || uploaded?.state !== 'completed' || uploaded.fingerprint !== digest({ operation: fingerprint, key: file.key, blob: file.blob, sha256: admitted.sha256 })) fail('PREPARATION_IDENTITY_MISMATCH');
      secretFree(uploaded.uploadResult, captured.secrets, 'PREPARATION_IDENTITY_MISMATCH');
      names.set(file.key, uploaded.uploadResult);
    }
    if (digest(protocol.wire(request, source, names)) !== prep.preparedBodyDigest) fail('PREPARATION_IDENTITY_MISMATCH');
  }
  async function upload(ctx, file, fingerprint, request, source, files, captured) {
    const expected = fileDigests(files), sourceDigest = protocol.digestSource(source);
    let bytes;
    const state = await runJournaledAction({ journal: await journal(ctx.operation, `/uploads/${digest(file.key)}`),
      action: 'upload', fingerprint: digest({ operation: fingerprint, key: file.key, blob: file.blob, sha256: file.sha256 }), policy: config.retry.upload, clock,
      beforeAttempt: async () => {
        checkedSource(source, captured); protocol.validateTargets(source, request);
        if (protocol.digestSource(source) !== sourceDigest) fail('PREPARATION_IDENTITY_MISMATCH');
        requirePassword(source, captured.password);
        const currentFiles = await admittedFiles(ctx, request); unchangedFiles(currentFiles, expected);
        await authority.preflight(protocol.reviewArgs(request, source, currentFiles, captured.key, captured.password));
        // Read after admission as well: an account call must not leave stale
        // admitted bytes available to the immediately following upload.
        const admitted = admitFile(file.blob, await ctx.resources.get(file.blob.resource));
        if (bytesDigest(admitted.bytes) !== file.sha256) fail('REFERENCE_CHANGED');
        bytes = admitted.bytes;
      },
      invoke: async () => {
        const form = new FormData(); form.set('apiKey', captured.key); form.set('fileType', 'input');
        form.set('file', new Blob([bytes], { type: file.blob.mediaType }), `input.${file.extension}`);
        const response = await transport.request({ path: '/task/openapi/upload', secret: captured.key, form });
        if (response.code !== 0 || response.data?.fileType !== 'input' || typeof response.data.fileName !== 'string' || !response.data.fileName
          || containsSecret(response.data.fileName, captured.secrets)) fail('UPLOAD_RESPONSE_UNKNOWN');
        return { uploadResult: response.data.fileName };
      },
    });
    secretFree(state.uploadResult, captured.secrets, 'UPLOAD_RESPONSE_UNKNOWN');
    return state.uploadResult;
  }
  async function owned(ctx) {
    const captured = capture(ctx), h = ctx.handle;
    if (h?.contract !== protocol.handleContract || !validTaskId(h.taskId) || containsSecret(h.taskId, captured.secrets) || !/^[a-f0-9]{64}$/.test(h.fingerprint)) fail('HANDLE_MISMATCH');
    const prep = await (await journal(ctx.operation, '/preparation')).read();
    const submit = await (await journal(ctx.operation)).read();
    if (prep?.format !== protocol.preparationFormat || prep.fingerprint !== h.fingerprint || prep.credentialSha256 !== credentialSha256(captured.key)
      || prep.apiKeyDigest !== digest(config.apiKey) || prep.baseUrl !== config.baseUrl || !passwordMatches(prep, captured.password)
      || submit?.fingerprint !== h.fingerprint || !submit.taskIds?.includes(h.taskId)) fail('TASK_NOT_IN_OPERATION_JOURNAL');
    if (ctx.need?.constraints) {
      const request = protocol.validateRequest(ctx.need.constraints, { maxBytes: config.budgets.maxRequestBytes });
      secretFreeRequest(request, captured.secrets, 'CREDENTIAL_IN_OPERATION_INPUT');
      if (fingerprintFor(request, captured) !== h.fingerprint) fail('JOURNAL_IDENTITY_MISMATCH');
      await verifyPrepared(ctx, request, prep, h.fingerprint, captured);
    } else preparedSource(prep, captured);
    return { ...captured, taskId: h.taskId, fingerprint: h.fingerprint };
  }
  return {
    async start(ctx) {
      const request = protocol.validateRequest(ctx.need.constraints, { maxBytes: config.budgets.maxRequestBytes }), captured = capture(ctx);
      secretFreeRequest(request, captured.secrets, 'CREDENTIAL_IN_OPERATION_INPUT');
      const { key, password } = captured, fingerprint = fingerprintFor(request, captured);
      const prepJournal = await journal(ctx.operation, '/preparation'), submitJournal = await journal(ctx.operation);
      const release = await acquirePreparation(prepJournal, submitJournal, fingerprint);
      try {
        let prep = await prepJournal.read(); const submit = await submitJournal.read();
        if (prep && (prep.format !== protocol.preparationFormat || prep.fingerprint !== fingerprint || prep.credentialSha256 !== credentialSha256(key)
          || prep.apiKeyDigest !== digest(config.apiKey) || prep.baseUrl !== config.baseUrl || !passwordMatches(prep, password))) fail('JOURNAL_IDENTITY_MISMATCH');
        if (submit && submit.fingerprint !== fingerprint) fail('JOURNAL_IDENTITY_MISMATCH');
        if (release === undefined && (prep?.state !== 'ready' || acknowledgedTaskId(submit, fingerprint) === undefined)) fail('JOURNAL_IDENTITY_MISMATCH');
        if (!prep) {
          if (submit) fail('PREPARATION_MISSING');
          prep = { format: protocol.preparationFormat, fingerprint, state: 'preparing', credentialSha256: credentialSha256(key),
            apiKeyDigest: digest(config.apiKey), baseUrl: config.baseUrl, ...passwordIdentity(password) };
          await prepJournal.write(prep); // Bind request/key/options before any effects.
        }
        if (prep.state === 'ready') await verifyPrepared(ctx, request, prep, fingerprint, captured);
        // ACK and unknown/in-flight outcomes are handled by the durable machine
        // without source/account calls, uploads, or a new submit series.
        if (!submit && prep.state !== 'ready') {
          const source = checkedSource(await protocol.fetchSource(request, key), captured);
          requirePassword(source, password); protocol.validateTargets(source, request);
          const files = await admittedFiles(ctx, request), args = protocol.reviewArgs(request, source, files, key, password);
          await authority.preflight(args);
          const sourceFields = { [protocol.sourceField]: source, [protocol.sourceDigestField]: protocol.digestSource(source), fileDigests: args.fileDigests };
          // Account for the upload core's maximum filename before any upload.
          const worstNames = new Map(files.map(file => [file.key, '\u0000'.repeat(4096)]));
          const worstBody = protocol.wire(request, source, worstNames);
          secretFreePreparedBody(worstBody, captured.secrets, isApp, 'CREDENTIAL_IN_OPERATION_INPUT');
          sizeGuard({ ...prep, state: 'ready', ...sourceFields, preparedBody: worstBody, preparedBodyDigest: '0'.repeat(64) });
          const names = new Map();
          for (const file of files) names.set(file.key, await upload(ctx, file, fingerprint, request, source, files, captured));
          const preparedBody = protocol.wire(request, source, names);
          secretFreePreparedBody(preparedBody, captured.secrets, isApp, 'CREDENTIAL_IN_OPERATION_INPUT');
          prep = { ...prep, state: 'ready', ...sourceFields, preparedBody, preparedBodyDigest: digest(preparedBody) };
          await prepJournal.write(prep);
        }
        const result = await runJournaledAction({ journal: submitJournal, fingerprint, policy: config.retry.submit, clock, resumeOnly: release === undefined,
          beforeAttempt: async () => {
            await verifyPrepared(ctx, request, prep, fingerprint, captured);
            const currentSource = checkedSource(await protocol.fetchSource(request, key), captured);
            if (protocol.digestSource(currentSource) !== prep[protocol.sourceDigestField]) fail(protocol.revisionMismatchCode);
            requirePassword(currentSource, password); protocol.validateTargets(currentSource, request);
            const currentFiles = await admittedFiles(ctx, request); unchangedFiles(currentFiles, prep.fileDigests);
            const admission = await authority.preflight(protocol.reviewArgs(request, currentSource, currentFiles, key, password));
            unchangedFiles(await admittedFiles(ctx, request), prep.fileDigests);
            if (isApp) {
              // Account and resource checks can block while the published interface changes.
              const finalSource = checkedSource(await protocol.fetchSource(request, key), captured);
              if (protocol.digestSource(finalSource) !== prep[protocol.sourceDigestField]) fail(protocol.revisionMismatchCode);
              requirePassword(finalSource, password); protocol.validateTargets(finalSource, request);
              const finalFiles = await admittedFiles(ctx, request); unchangedFiles(finalFiles, prep.fileDigests);
              const finalReview = await authority.check({ ...protocol.reviewArgs(request, finalSource, finalFiles, key, password), now: clock.now() });
              const now = clock.now();
              if (now < admission.observedAt || now - admission.observedAt > 60000) fail('ACCOUNT_PREFLIGHT_STALE');
              if (now >= Math.min(admission.expiresAt, Date.parse(finalReview.expiresAt))) fail('MEMBER_BINDING_EXPIRED');
            }
          },
          invoke: async () => {
            const response = await transport.request({ path: protocol.submitPath, secret: key, body: { apiKey: key, ...prep.preparedBody,
              ...(password !== undefined && (!isApp || prep.app.accessEncrypted) ? { accessPassword: password } : {}) },
              extractTaskIds: data => typeof data.data?.taskId === 'string' && !containsSecret(data.data.taskId, captured.secrets) ? [data.data.taskId] : [] });
            if (response.code !== 0 || !validTaskId(response.data?.taskId) || containsSecret(response.data.taskId, captured.secrets)) fail('SUBMIT_RESPONSE_UNKNOWN');
            return { taskId: response.data.taskId };
          },
          checkpoint: async value => {
            if (containsSecret(value.handle.taskId, captured.secrets)) fail('SUBMIT_RESPONSE_UNKNOWN');
            await ctx.checkpoint?.({ handle: handle(value.handle.taskId, fingerprint), receipt: receipt(value.handle.taskId) });
          },
        });
        if (containsSecret(result.taskId, captured.secrets)) fail('SUBMIT_RESPONSE_UNKNOWN');
        return { status: 'pending', handle: handle(result.taskId, fingerprint), receipt: receipt(result.taskId), wakeAt: clock.now() + config.polling.intervalMs };
      } finally { await release?.(); }
    },
    async poll(ctx) {
      const { taskId, key, secrets, fingerprint } = await owned(ctx);
      const observations = await journal(ctx.operation, '/observations');
      const previous = await observations.read();
      if (previous?.taskId === taskId && previous.fingerprint === fingerprint && previous.billingViolation) fail('BILLING_MISMATCH');
      const budget = await journal(ctx.operation, '/poll');
      await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling });
      let response, moneyObserved = false;
      try { response = await transport.request({ path: '/openapi/v2/query', secret: key, body: { taskId }, observeResponse: async raw => {
        const release = await observations.acquire();
        try {
          const previous = await observations.read();
          const alreadyLatched = Boolean(previous?.taskId === taskId && previous.fingerprint === fingerprint && previous.billingViolation);
          const billingViolation = alreadyLatched || positiveMoney(raw.usage), observedAt = clock.now();
          moneyObserved = billingViolation;
          // Redaction can expand an otherwise bounded response. Persist denial
          // first so evidence serialization/storage failure cannot revive results.
          if (billingViolation && !alreadyLatched) await observations.write({ taskId, fingerprint, observedAt, billingViolation: true });
          await observations.write({ taskId, fingerprint, observedAt, response: redactSecrets(raw, secrets),
            ...(billingViolation ? { billingViolation: true } : {}) });
        }
        finally { await release(); }
      } }); }
      catch (error) {
        if (!safeError(error).retryable) throw error;
        if (moneyObserved) fail('BILLING_MISMATCH');
        const next = await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling, event: 'transient-failure' });
        return { status: 'pending', handle: handle(taskId, fingerprint), receipt: receipt(taskId), wakeAt: next.wakeAt };
      }
      if (response.taskId !== taskId || !['CREATE', 'QUEUED', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCEL'].includes(response.status)) fail('QUERY_RESPONSE_UNKNOWN');
      const next = await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling, event: 'observed' });
      const usage = usageValue(response.usage, secrets);
      if (response.status === 'FAILED') return { status: 'failed', receipt: receipt(taskId), failure: { code: 'REMOTE_TASK_FAILED', message: 'RunningHub task failed.' } };
      if (response.status === 'CANCEL') return { status: 'failed', receipt: receipt(taskId), failure: { code: 'REMOTE_TASK_CANCELLED', message: 'RunningHub task cancelled.' } };
      if (response.status !== 'SUCCESS') return { status: 'pending', handle: handle(taskId, fingerprint), receipt: receipt(taskId), wakeAt: next.wakeAt };
      if (!Array.isArray(response.results)) fail('QUERY_RESPONSE_UNKNOWN');
      for (const item of response.results) {
        if (!item || typeof item.url !== 'string' || typeof item.outputType !== 'string') fail('QUERY_RESPONSE_UNKNOWN');
        if (containsUrlSecret(item.url, secrets)) fail('UNSAFE_RESULT_URL');
      }
      jsonValue(response.results, config.http.maxResponseBytes);
      const results = await journal(ctx.operation, '/results'), release = await results.acquire();
      try { await results.write({ taskId, fingerprint, results: redactSecrets(response.results, secrets), ...(usage === undefined ? {} : { usage }) }); }
      finally { await release(); }
      return { status: 'ready', handle: handle(taskId, fingerprint), receipt: receipt(taskId) };
    },
    async collect(ctx) {
      const { taskId, secrets, fingerprint } = await owned(ctx);
      const observation = await (await journal(ctx.operation, '/observations')).read();
      if (observation?.taskId === taskId && observation.fingerprint === fingerprint && observation.billingViolation) fail('BILLING_MISMATCH');
      const saved = await (await journal(ctx.operation, '/results')).read();
      if (saved?.taskId !== taskId || saved.fingerprint !== fingerprint || !Array.isArray(saved.results)) fail('RESULT_JOURNAL_MISSING');
      const usage = usageValue(saved.usage, secrets), outputs = [];
      for (const item of saved.results) {
        let url; try { url = new URL(item.url); } catch { fail('UNSAFE_RESULT_URL'); }
        if (containsUrlSecret(item.url, secrets) || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !config.http.allowedDownloadHosts.includes(url.hostname)) fail('UNSAFE_RESULT_URL');
        const timer = clock.timeout(config.http.requestTimeoutMs);
        try {
          const response = await boundedBySignal(timer.signal, () => fetch(url.href, { redirect: 'error', signal: timer.signal }));
          if (!response.ok) fail('DOWNLOAD_HTTP_ERROR');
          const contentType = response.headers.get('content-type'), mime = safeMime(contentType);
          if (contentType !== null && (containsSecret(contentType, secrets) || containsSecret(mime, secrets))) fail('UNSAFE_RESULT_MIME');
          const bytes = await boundedBySignal(timer.signal, () => boundedBytes(response, config.http.maxDownloadBytes));
          const blob = await ctx.resources.put(bytes, mime, { signal: timer.signal });
          if (typeof item.outputType !== 'string') fail('QUERY_RESPONSE_UNKNOWN');
          const outputType = containsSecret(item.outputType, secrets) || /https?:\/\//i.test(item.outputType) ? '[redacted]' : item.outputType;
          outputs.push({ blob, outputType, metadata: metadata(item, secrets) ?? {} });
        } finally { timer.cancel(); }
      }
      const value = { format: 'hypit-runninghub.result@1', taskId, outputs, ...(usage === undefined ? {} : { usage }) };
      return { status: 'completed', receipt: receipt(taskId), result: { value: { kind: 'inline', value } } };
    },
  };
}
