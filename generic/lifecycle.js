import { createHash } from 'node:crypto';
import { fail, safeError } from '../core/errors.js';
import { openJournal } from '../core/journal.js';
import { runJournaledAction, validTaskId } from '../core/submission-machine.js';
import { createJsonTransport, boundedBySignal, boundedBytes } from '../core/transport.js';
import { updatePollBudget } from '../core/poll-budget.js';
import { credentialSha256 } from '../native/member-binding.js';
import { digest } from '../native/descriptor.js';
import { validateRequest, validateApiGraph, validateTargets, parseJson, mapRequest, jsonValue } from './request.js';
import { admitFile, safeMime } from './media.js';
const bytesDigest = bytes => createHash('sha256').update(bytes).digest('hex');

function usageValue(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail('BILLING_USAGE_UNKNOWN');
  const result = {};
  for (const key of ['consumeMoney', 'consumeCoins', 'thirdPartyConsumeMoney', 'taskCostTime']) {
    const amount = value[key]; if (amount === undefined) continue;
    if (amount !== null && (typeof amount !== 'string' || amount.length > 32 || !/^\d+(\.\d+)?$/.test(amount))) fail('BILLING_USAGE_UNKNOWN');
    if (['consumeMoney', 'thirdPartyConsumeMoney'].includes(key) && amount !== null && Number(amount) > 0) fail('BILLING_MISMATCH');
    result[key] = amount;
  }
  return result;
}
function metadata(value, secret, depth = 0) {
  if (depth > 32) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value.includes(secret) || /https?:\/\//i.test(value) ? undefined : value;
  if (Array.isArray(value)) return value.map(v => metadata(v, secret, depth + 1)).filter(v => v !== undefined);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/url|token|secret|credential|apikey|authorization|password/i.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      const safe = metadata(entry, secret, depth + 1); if (safe !== undefined) result[key] = safe;
    }
    return result;
  }
}

export function createWorkflowLifecycle({ config, dataRoot, instance, fetch, clock, authority }) {
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: 'native-workflow', fetch, clock,
    timeoutMs: config.http.requestTimeoutMs, maxResponseBytes: config.http.maxResponseBytes });
  const journal = (operation, suffix = '') => openJournal({ dataRoot, instance, operation,
    journalDirectory: config.paths.journalDirectory + suffix, maxBytes: config.budgets.maxJournalBytes });
  const secret = ctx => {
    const value = ctx.credentials?.apiKey?.secret;
    if (typeof value !== 'string' || !value) fail('CREDENTIAL_MISSING'); return value;
  };
  const fingerprintFor = (request, key) => digest({ request, credentialSha256: credentialSha256(key), apiKey: config.apiKey, baseUrl: config.baseUrl });
  const handle = (taskId, fingerprint) => ({ contract: 'hypit.runninghub.workflow@1', taskId, fingerprint });
  const receipt = taskId => ({ id: taskId });
  async function graphFor(request, key) {
    if (request.workflowJson !== undefined) return validateApiGraph(parseJson(request.workflowJson, config.budgets.maxRequestBytes), config.budgets.maxRequestBytes);
    const result = await transport.request({ path: '/api/openapi/getJsonApiFormat', secret: key, body: { apiKey: key, workflowId: request.workflowId } });
    if (result.code !== 0 || typeof result.data?.prompt !== 'string') fail('WORKFLOW_RESPONSE_UNKNOWN');
    return validateApiGraph(parseJson(result.data.prompt, config.budgets.maxRequestBytes), config.budgets.maxRequestBytes);
  }
  function wire(request, graph, filenames) {
    const nodeInfoList = mapRequest(request, filenames);
    const body = { workflowId: request.workflowId, nodeInfoList };
    if (request.workflowJson !== undefined) {
      const effective = structuredClone(graph);
      for (const item of nodeInfoList) effective[item.nodeId].inputs[item.fieldName] = item.fieldValue;
      body.workflow = JSON.stringify(effective);
    }
    return body;
  }
  async function admittedFiles(ctx, request) {
    const result = [];
    for (const file of request.files) {
      const admitted = admitFile(file.blob, await ctx.resources.get(file.blob.resource));
      result.push({ ...file, extension: admitted.extension, sha256: bytesDigest(admitted.bytes) });
    }
    return result;
  }
  function sizeGuard(record) {
    if (Buffer.byteLength(JSON.stringify(record)) > config.budgets.maxJournalBytes) fail('JOURNAL_TOO_LARGE');
  }
  function reviewArgs(request, graph, files, key) {
    return { config, request, graphDigest: digest(graph), fileDigests: files.map(file => ({ key: file.key, sha256: file.sha256 })), secret: key, fetch, clock };
  }
  async function upload(ctx, file, fingerprint, args) {
    const { bytes } = admitFile(file.blob, await ctx.resources.get(file.blob.resource));
    if (bytesDigest(bytes) !== file.sha256) fail('REFERENCE_CHANGED');
    const state = await runJournaledAction({ journal: await journal(ctx.operation, `/uploads/${digest(file.key)}`),
      action: 'upload', fingerprint: digest({ operation: fingerprint, key: file.key, blob: file.blob, sha256: file.sha256 }), policy: config.retry.upload, clock,
      beforeAttempt: async () => { await authority.preflight(args); },
      invoke: async () => {
        const form = new FormData(); form.set('apiKey', args.secret); form.set('fileType', 'input');
        form.set('file', new Blob([bytes], { type: file.blob.mediaType }), `input.${file.extension}`);
        const response = await transport.request({ path: '/task/openapi/upload', secret: args.secret, form });
        if (response.code !== 0 || response.data?.fileType !== 'input' || typeof response.data.fileName !== 'string' || !response.data.fileName) fail('UPLOAD_RESPONSE_UNKNOWN');
        return { uploadResult: response.data.fileName };
      },
    });
    return state.uploadResult;
  }
  async function owned(ctx) {
    const key = secret(ctx), h = ctx.handle;
    if (h?.contract !== 'hypit.runninghub.workflow@1' || !validTaskId(h.taskId) || !/^[a-f0-9]{64}$/.test(h.fingerprint)) fail('HANDLE_MISMATCH');
    const prep = await (await journal(ctx.operation, '/preparation')).read();
    const submit = await (await journal(ctx.operation)).read();
    if (prep?.fingerprint !== h.fingerprint || prep.credentialSha256 !== credentialSha256(key)
      || prep.apiKeyDigest !== digest(config.apiKey) || prep.baseUrl !== config.baseUrl
      || submit?.fingerprint !== h.fingerprint || !submit.taskIds?.includes(h.taskId)) fail('TASK_NOT_IN_OPERATION_JOURNAL');
    if (ctx.need?.constraints && fingerprintFor(validateRequest(ctx.need.constraints, { maxBytes: config.budgets.maxRequestBytes }), key) !== h.fingerprint) fail('JOURNAL_IDENTITY_MISMATCH');
    return { key, taskId: h.taskId, fingerprint: h.fingerprint };
  }
  return {
    async start(ctx) {
      const request = validateRequest(ctx.need.constraints, { maxBytes: config.budgets.maxRequestBytes }), key = secret(ctx);
      const fingerprint = fingerprintFor(request, key);
      const prepJournal = await journal(ctx.operation, '/preparation'), submitJournal = await journal(ctx.operation);
      const release = await prepJournal.acquire();
      try {
        let prep = await prepJournal.read(); const submit = await submitJournal.read();
        if (prep && (prep.format !== 'workflow-preparation@1' || prep.fingerprint !== fingerprint)) fail('JOURNAL_IDENTITY_MISMATCH');
        if (submit && submit.fingerprint !== fingerprint) fail('JOURNAL_IDENTITY_MISMATCH');
        if (!prep) {
          if (submit) fail('PREPARATION_MISSING');
          prep = { format: 'workflow-preparation@1', fingerprint, state: 'preparing', credentialSha256: credentialSha256(key),
            apiKeyDigest: digest(config.apiKey), baseUrl: config.baseUrl };
          await prepJournal.write(prep); // Bind request/key before any effects.
        }
        let files, graph, args;
        async function verifyPrepared() {
          if (prep.state !== 'ready' || !prep.graph || !prep.preparedBody || prep.graphDigest !== digest(prep.graph)
            || prep.preparedBodyDigest !== digest(prep.preparedBody)) fail('PREPARATION_IDENTITY_MISMATCH');
          validateApiGraph(prep.graph, config.budgets.maxRequestBytes); validateTargets(prep.graph, request);
          if (request.workflowJson !== undefined && digest(parseJson(request.workflowJson, config.budgets.maxRequestBytes)) !== prep.graphDigest) fail('PREPARATION_IDENTITY_MISMATCH');
          const names = new Map();
          for (const file of request.files) {
            const uploaded = await (await journal(ctx.operation, `/uploads/${digest(file.key)}`)).read();
            const sha256 = prep.fileDigests?.find(item => item.key === file.key)?.sha256;
            if (uploaded?.state !== 'completed' || uploaded.fingerprint !== digest({ operation: fingerprint, key: file.key, blob: file.blob, sha256 })) fail('PREPARATION_IDENTITY_MISMATCH');
            names.set(file.key, uploaded.uploadResult);
          }
          if (digest(wire(request, prep.graph, names)) !== prep.preparedBodyDigest) fail('PREPARATION_IDENTITY_MISMATCH');
        }
        if (prep.state === 'ready') await verifyPrepared();
        // Existing ACK/unknown state is handled by the unchanged durable action
        // machine before new uploads or admission. Never create a new series.
        if (!submit && prep.state !== 'ready') {
          graph = await graphFor(request, key); validateTargets(graph, request);
          files = await admittedFiles(ctx, request); args = reviewArgs(request, graph, files, key);
          await authority.preflight(args);
          // Worst-case client filename limit from the durable upload core is
          // checked before uploading, including repeated targets and graph wire.
          const worstNames = new Map(files.map(file => [file.key, '\u0000'.repeat(4096)]));
          sizeGuard({ ...prep, state: 'ready', graph, graphDigest: digest(graph), fileDigests: args.fileDigests,
            preparedBody: wire(request, graph, worstNames), preparedBodyDigest: '0'.repeat(64) });
          const names = new Map();
          for (const file of files) names.set(file.key, await upload(ctx, file, fingerprint, args));
          const preparedBody = wire(request, graph, names);
          prep = { ...prep, state: 'ready', graph, graphDigest: digest(graph), fileDigests: args.fileDigests,
            preparedBody, preparedBodyDigest: digest(preparedBody) };
          await prepJournal.write(prep);
        }
        const result = await runJournaledAction({ journal: submitJournal, fingerprint, policy: config.retry.submit, clock,
          beforeAttempt: async () => {
            await verifyPrepared();
            const currentGraph = await graphFor(request, key);
            if (digest(currentGraph) !== prep.graphDigest) fail('WORKFLOW_REVISION_MISMATCH');
            const currentFiles = await admittedFiles(ctx, request);
            if (digest(currentFiles.map(file => ({ key: file.key, sha256: file.sha256 }))) !== digest(prep.fileDigests)) fail('REFERENCE_CHANGED');
            await authority.preflight(reviewArgs(request, currentGraph, currentFiles, key));
          },
          invoke: async () => {
            const response = await transport.request({ path: '/task/openapi/create', secret: key, body: { apiKey: key, ...prep.preparedBody },
              extractTaskIds: data => typeof data.data?.taskId === 'string' && !data.data.taskId.includes(key) ? [data.data.taskId] : [] });
            if (response.code !== 0 || !validTaskId(response.data?.taskId) || response.data.taskId.includes(key)) fail('SUBMIT_RESPONSE_UNKNOWN');
            return { taskId: response.data.taskId };
          },
          checkpoint: async value => ctx.checkpoint?.({ handle: handle(value.handle.taskId, fingerprint), receipt: receipt(value.handle.taskId) }),
        });
        return { status: 'pending', handle: handle(result.taskId, fingerprint), receipt: receipt(result.taskId), wakeAt: clock.now() + config.polling.intervalMs };
      } finally { await release(); }
    },
    async poll(ctx) {
      const { taskId, key, fingerprint } = await owned(ctx);
      const budget = await journal(ctx.operation, '/poll');
      await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling });
      let response;
      try { response = await transport.request({ path: '/openapi/v2/query', secret: key, body: { taskId }, observeResponse: async raw => {
        const observations = await journal(ctx.operation, '/observations'), release = await observations.acquire();
        try { await observations.write({ taskId, fingerprint, observedAt: clock.now(), response: raw }); }
        finally { await release(); }
      } }); }
      catch (error) {
        if (!safeError(error).retryable) throw error;
        const next = await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling, event: 'transient-failure' });
        return { status: 'pending', handle: handle(taskId, fingerprint), receipt: receipt(taskId), wakeAt: next.wakeAt };
      }
      if (response.taskId !== taskId || !['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED'].includes(response.status)) fail('QUERY_RESPONSE_UNKNOWN');
      const next = await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling, event: 'observed' });
      const usage = usageValue(response.usage);
      if (response.status === 'FAILED') return { status: 'failed', receipt: receipt(taskId), failure: { code: 'REMOTE_TASK_FAILED', message: 'RunningHub task failed.' } };
      if (response.status !== 'SUCCESS') return { status: 'pending', handle: handle(taskId, fingerprint), receipt: receipt(taskId), wakeAt: next.wakeAt };
      if (!Array.isArray(response.results)) fail('QUERY_RESPONSE_UNKNOWN');
      for (const item of response.results) {
        if (!item || typeof item.url !== 'string' || typeof item.outputType !== 'string') fail('QUERY_RESPONSE_UNKNOWN');
      }
      jsonValue(response.results, config.http.maxResponseBytes);
      const results = await journal(ctx.operation, '/results'), release = await results.acquire();
      try { await results.write({ taskId, fingerprint, results: response.results, ...(usage === undefined ? {} : { usage }) }); }
      finally { await release(); }
      return { status: 'ready', handle: handle(taskId, fingerprint), receipt: receipt(taskId) };
    },
    async collect(ctx) {
      const { taskId, key, fingerprint } = await owned(ctx);
      const saved = await (await journal(ctx.operation, '/results')).read();
      if (saved?.taskId !== taskId || saved.fingerprint !== fingerprint || !Array.isArray(saved.results)) fail('RESULT_JOURNAL_MISSING');
      const outputs = [];
      for (const item of saved.results) {
        let url; try { url = new URL(item.url); } catch { fail('UNSAFE_RESULT_URL'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !config.http.allowedDownloadHosts.includes(url.hostname)) fail('UNSAFE_RESULT_URL');
        const timer = clock.timeout(config.http.requestTimeoutMs);
        try {
          const response = await boundedBySignal(timer.signal, () => fetch(url.href, { redirect: 'error', signal: timer.signal }));
          if (!response.ok) fail('DOWNLOAD_HTTP_ERROR');
          const mime = safeMime(response.headers.get('content-type'));
          const bytes = await boundedBySignal(timer.signal, () => boundedBytes(response, config.http.maxDownloadBytes));
          const blob = await ctx.resources.put(bytes, mime, { signal: timer.signal });
          const outputType = item.outputType.includes(key) || /https?:\/\//i.test(item.outputType) ? '[redacted]' : item.outputType;
          outputs.push({ blob, outputType, metadata: metadata(item, key) ?? {} });
        } finally { timer.cancel(); }
      }
      const value = { format: 'hypit-runninghub.result@1', taskId, outputs, ...(saved.usage === undefined ? {} : { usage: saved.usage }) };
      return { status: 'completed', receipt: receipt(taskId), result: { value: { kind: 'inline', value } } };
    },
  };
}
