// Internal protocol component. Public activation supplies reviewed binding
// admission hooks. Development tests always use injected offline transport.
import { fail, safeError } from '../core/errors.js';
import { openJournal } from '../core/journal.js';
import { runJournaledAction, validTaskId, acknowledgedTaskId, acquirePreparation } from '../core/submission-machine.js';
import { createJsonTransport, boundedBySignal, boundedBytes } from '../core/transport.js';
import { updatePollBudget } from '../core/poll-budget.js';
import { digest, mapNodes, verifyRemoteGraph, selectNativeResults } from './descriptor.js';
import { createHash } from 'node:crypto';
const RESULT_TYPES = { jpg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4' };
function safeUsage(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) fail('BILLING_USAGE_UNKNOWN');
  const result = {};
  for (const field of ['consumeMoney', 'consumeCoins', 'thirdPartyConsumeMoney', 'taskCostTime']) {
    const amount = value[field];
    if (amount === undefined) continue;
    if (amount !== null && (typeof amount !== 'string' || amount.length > 32 || !/^\d+(\.\d+)?$/.test(amount))) fail('BILLING_USAGE_UNKNOWN');
    result[field] = amount;
  }
  return result;
}
function verifyMediaBytes(bytes, mediaType) {
  if (!bytes.length) fail('DOWNLOAD_EMPTY');
  const matches = mediaType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : mediaType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mediaType === 'video/mp4' && bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (!matches) fail('DOWNLOAD_SIGNATURE_MISMATCH');
}

export function createNativeLifecycle({ config, descriptor, graph, dataRoot, instance, fetch, clock, sdk, beforePrepare, beforeSubmit }) {
  const v2 = descriptor.schemaVersion === 'hypit-runninghub.workflow@2';
  const inline = v2 && descriptor.sourceMode === 'inline-json';
  const template = v2 ? structuredClone(graph) : undefined;
  function verifyTemplate() { if (v2 && digest(template) !== descriptor.graphDigest.value) fail('WORKFLOW_REVISION_MISMATCH'); }
  async function verifyExecutionSource(ctx) {
    if (inline) verifyTemplate();
    else verifyRemoteGraph(await transport.request({ path: '/api/openapi/getJsonApiFormat', secret: secret(ctx),
      body: { apiKey: secret(ctx), workflowId: descriptor.workflowId } }), descriptor);
  }
  function admitMedia(binding, item, raw) {
    const bytes = raw instanceof Uint8Array ? Buffer.from(raw) : undefined;
    const role = descriptor.portTable.ports.find(p => p.name === binding.port)?.value.accepts?.[0];
    const allowed = v2 && role === 'audio' ? ['audio/mpeg', 'audio/wav'] : ['image/png', 'image/jpeg', 'image/webp'];
    if (!bytes || v2 && !bytes.length || bytes.length !== item.artifact.size || bytes.length > 30 * 1024 * 1024
      || !allowed.includes(item.artifact.mediaType) || v2 && item.role !== role) fail('UNSUPPORTED_REFERENCE_MEDIA');
    if (v2 && role === 'audio') {
      const valid = item.artifact.mediaType === 'audio/wav'
        ? bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE'
        : bytes.length >= 3 && (bytes.subarray(0, 3).toString('ascii') === 'ID3'
          || bytes[0] === 255 && (bytes[1] & 0xe0) === 0xe0 && (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 6) !== 0);
      if (!valid) fail('REFERENCE_SIGNATURE_MISMATCH');
    }
    if (v2 && role === 'image') {
      const valid = item.artifact.mediaType === 'image/png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : item.artifact.mediaType === 'image/jpeg' ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
      if (!valid) fail('REFERENCE_SIGNATURE_MISMATCH');
    }
    return bytes;
  }
  function effectiveGraphFor(nodeInfoList, ports) {
    if (!Array.isArray(nodeInfoList)) fail('PREPARATION_IDENTITY_MISMATCH');
    const uploads = new Map();
    for (const binding of descriptor.bindings) for (const target of binding.targets) {
      if (binding.transport !== 'legacy-filename' || ports[binding.port]?.[target.itemIndex] === undefined) continue;
      const value = nodeInfoList.find(m => m.nodeId === target.nodeId && m.fieldName === target.fieldName)?.fieldValue;
      if (typeof value !== 'string' || !value) fail('PREPARATION_IDENTITY_MISMATCH');
      const key = `${binding.port}/${target.itemIndex}`;
      if (uploads.has(key) && uploads.get(key) !== value) fail('PREPARATION_IDENTITY_MISMATCH');
      uploads.set(key, value);
    }
    if (digest(mapNodes(descriptor, ports, uploads)) !== digest(nodeInfoList)) fail('PREPARATION_IDENTITY_MISMATCH');
    const effectiveGraph = structuredClone(template);
    for (const mapping of nodeInfoList) effectiveGraph[mapping.nodeId].inputs[mapping.fieldName] = mapping.fieldValue;
    return effectiveGraph;
  }
  const transport = createJsonTransport({ baseUrl: config.baseUrl, family: 'native-workflow', fetch, clock,
    timeoutMs: config.http.requestTimeoutMs, maxResponseBytes: config.http.maxResponseBytes });
  const journal = (operation, suffix = '') => openJournal({ dataRoot, instance, operation,
    journalDirectory: config.paths.journalDirectory + suffix });
  const receipt = taskId => ({ id: taskId });
  const handle = taskId => ({ contract: 'hypit.runninghub.native@1', taskId, descriptorDigest: digest(descriptor) });
  const ensureFresh = admission => {
    if (admission && (clock.now() < admission.observedAt || clock.now() - admission.observedAt > 60_000
      || clock.now() >= admission.expiresAt)) fail('ACCOUNT_PREFLIGHT_STALE');
  };
  const secret = ctx => {
    const key = ctx.credentials?.apiKey?.secret;
    if (typeof key !== 'string' || !key) fail('CREDENTIAL_MISSING');
    return key;
  };
  const validateHandle = ctx => {
    if (ctx.handle?.contract !== 'hypit.runninghub.native@1' || !validTaskId(ctx.handle.taskId)
      || ctx.handle.descriptorDigest !== digest(descriptor)) fail('HANDLE_MISMATCH');
    return ctx.handle.taskId;
  };
  async function validateOwnedTask(ctx, taskId) {
    const record = await (await journal(ctx.operation)).read();
    if (record?.action !== 'submit' || !record.taskIds?.includes(taskId)) fail('TASK_NOT_IN_OPERATION_JOURNAL');
  }
  async function upload(ctx, binding, index, item, admission) {
    const bytes = admitMedia(binding, item, await ctx.resources.get(item.artifact.resource));
    const fingerprint = digest({ resource: item.artifact, bytesSha256: createHash('sha256').update(bytes).digest('hex'), descriptor: digest(descriptor), port: binding.port, index });
    const result = await runJournaledAction({ journal: await journal(ctx.operation, `/uploads/${digest([binding.port, index])}`),
      fingerprint, action: 'upload', policy: config.retry.upload, clock,
      beforeAttempt: async () => ensureFresh(admission),
      invoke: async () => {
        const form = new FormData(); form.set('apiKey', secret(ctx)); form.set('fileType', 'input');
        const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' }[item.artifact.mediaType];
        form.set('file', new Blob([bytes], { type: item.artifact.mediaType }), `reference.${extension}`);
        const response = await transport.request({ path: '/task/openapi/upload', secret: secret(ctx), form });
        if (response.code !== 0 || typeof response.data?.fileName !== 'string' || !response.data.fileName
          || response.data.fileType !== 'input') fail('UPLOAD_RESPONSE_UNKNOWN');
        return { uploadResult: response.data.fileName };
      },
    });
    return result.uploadResult;
  }
  return {
    async start(ctx) {
      sdk.verifyRequestAgainstPorts(descriptor.portTable, ctx.need.constraints);
      if (digest(ctx.need.capability) !== digest(descriptor.capability)) fail('CAPABILITY_MISMATCH');
      verifyTemplate();
      const ports = ctx.need.constraints.ports;
      const fingerprint = digest({ descriptor, ports, apiKeyReference: config.apiKey, baseUrl: config.baseUrl,
        credentialSha256: createHash('sha256').update(secret(ctx)).digest('hex') });
      const preparation = await journal(ctx.operation, '/preparation'), submit = await journal(ctx.operation);
      const release = await acquirePreparation(preparation, submit, fingerprint);
      try {
        const existing = await submit.read();
        // Resume a durable acknowledgement before any upload or new submit.
        // Network preparation is outside the submit retry budget. Upload uses
        // its own durable budget; once prepared each attempt only calls create.
        let preparedBody;
        const savedPreparation = await preparation.read();
        if (savedPreparation && (savedPreparation.version !== 1 || savedPreparation.fingerprint !== fingerprint)) fail('JOURNAL_IDENTITY_MISMATCH');
        if (release === undefined && (savedPreparation?.state !== 'ready' || acknowledgedTaskId(existing, fingerprint) === undefined)) fail('JOURNAL_IDENTITY_MISMATCH');
        if (v2 && savedPreparation?.state === 'ready') {
          const body = savedPreparation.preparedBody;
          if (!body || savedPreparation.preparedBodyDigest !== digest(body) || savedPreparation.sourceMode !== descriptor.sourceMode
            || savedPreparation.templateGraphDigest !== descriptor.graphDigest.value || body.workflowId !== descriptor.workflowId
            || Object.keys(body).some(k => !(inline ? ['workflowId', 'nodeInfoList', 'workflow'] : ['workflowId', 'nodeInfoList']).includes(k))) fail('PREPARATION_IDENTITY_MISMATCH');
          const effectiveGraph = effectiveGraphFor(body.nodeInfoList, ports);
          for (const binding of descriptor.bindings) {
            if (binding.transport !== 'legacy-filename') continue;
            for (const [index] of (ports[binding.port] ?? []).entries()) {
              const uploaded = await (await journal(ctx.operation, `/uploads/${digest([binding.port, index])}`)).read();
              if (uploaded?.action !== 'upload' || uploaded.state !== 'completed' || typeof uploaded.uploadResult !== 'string'
                || binding.targets.filter(target => target.itemIndex === index).some(target =>
                  body.nodeInfoList.find(mapping => mapping.nodeId === target.nodeId && mapping.fieldName === target.fieldName)?.fieldValue !== uploaded.uploadResult)) fail('PREPARATION_IDENTITY_MISMATCH');
            }
          }
          if (inline && (typeof body.workflow !== 'string' || body.workflow !== JSON.stringify(effectiveGraph)
            || savedPreparation.effectiveGraphDigest !== digest(effectiveGraph))) fail('PREPARATION_IDENTITY_MISMATCH');
        }
        // Persist credential/request identity before the first preparation
        // effect. Partial upload recovery can never adopt a rotated key.
        if (!savedPreparation && !existing?.taskIds?.length) await preparation.write({ version: 1, fingerprint, state: 'preparing' });
        if (!existing?.taskIds?.length && !existing) {
          const admission = await beforePrepare?.(ctx);
          await verifyExecutionSource(ctx);
          // Admit every media reference before the first upload. Never fabricate
          // bytes for planning slots or a missing ResourceStore entry.
          for (const binding of descriptor.bindings) {
            if (binding.transport !== 'legacy-filename') continue;
            for (const item of ports[binding.port] ?? []) {
              admitMedia(binding, item, await ctx.resources.get(item.artifact.resource));
            }
          }
          const uploads = new Map();
          for (const binding of descriptor.bindings) {
            if (binding.transport !== 'legacy-filename') continue;
            for (const [index, item] of (ports[binding.port] ?? []).entries()) uploads.set(`${binding.port}/${index}`, await upload(ctx, binding, index, item, admission));
          }
          preparedBody = { workflowId: descriptor.workflowId, nodeInfoList: mapNodes(descriptor, ports, uploads) };
          let effectiveGraphDigest;
          if (inline) {
            const effectiveGraph = effectiveGraphFor(preparedBody.nodeInfoList, ports);
            preparedBody.workflow = JSON.stringify(effectiveGraph); effectiveGraphDigest = digest(effectiveGraph);
          }
          await preparation.write({ version: 1, fingerprint, state: 'ready', preparedBody,
            ...(v2 ? { preparedBodyDigest: digest(preparedBody), sourceMode: descriptor.sourceMode, templateGraphDigest: descriptor.graphDigest.value,
              ...(inline ? { effectiveGraphDigest } : {}) } : {}) });
        } else preparedBody = savedPreparation?.preparedBody;
        const result = await runJournaledAction({ journal: submit, fingerprint, policy: config.retry.submit, clock, resumeOnly: release === undefined,
          beforeAttempt: async () => {
            const admission = await beforeSubmit?.(ctx);
            await verifyExecutionSource(ctx);
            ensureFresh(admission);
          },
          invoke: async () => {
            if (!preparedBody) fail('PREPARATION_MISSING');
            const response = await transport.request({ path: '/task/openapi/create', secret: secret(ctx),
              body: { apiKey: secret(ctx), ...preparedBody }, extractTaskIds: data => [data.data?.taskId] });
            if (response.code !== 0 || !validTaskId(response.data?.taskId)) fail('SUBMIT_RESPONSE_UNKNOWN');
            return { taskId: response.data.taskId };
          },
          checkpoint: async value => { await ctx.checkpoint?.({ handle: handle(value.handle.taskId), receipt: receipt(value.handle.taskId) }); },
        });
        return { status: 'pending', handle: handle(result.taskId), receipt: receipt(result.taskId), wakeAt: clock.now() + config.polling.intervalMs };
      } finally { await release?.(); }
    },
    async poll(ctx) {
      const taskId = validateHandle(ctx); await validateOwnedTask(ctx, taskId);
      const budget = await journal(ctx.operation, '/poll');
      await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling });
      let response;
      try { response = await transport.request({ path: '/openapi/v2/query', secret: secret(ctx), body: { taskId } }); }
      catch (error) {
        if (!safeError(error).retryable) throw error;
        const next = await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling, event: 'transient-failure' });
        return { status: 'pending', handle: handle(taskId), receipt: receipt(taskId), wakeAt: next.wakeAt };
      }
      // Native public docs enumerate these common states, not Model API's
      // complete enum. Other values remain unimplemented and fail closed.
      if (response.taskId !== taskId || !['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED'].includes(response.status)) fail('QUERY_RESPONSE_UNKNOWN');
      const next = await updatePollBudget({ journal: budget, taskId, now: clock.now(), limits: config.polling, event: 'observed' });
      const usage = safeUsage(response.usage);
      const observationJournal = await journal(ctx.operation, '/observations');
      const releaseObservation = await observationJournal.acquire();
      try { await observationJournal.write({ taskId, status: response.status, ...(usage === undefined ? {} : { usage }),
        resultCount: Array.isArray(response.results) ? response.results.length : 0 }); }
      finally { await releaseObservation(); }
      if (usage) {
        for (const field of ['consumeMoney', 'thirdPartyConsumeMoney']) {
          const value = usage[field];
          if (value !== null && value !== undefined && Number(value) > 0) fail('BILLING_MISMATCH');
        }
      }
      if (response.status === 'FAILED') return { status: 'failed', receipt: receipt(taskId), failure: { code: 'REMOTE_TASK_FAILED', message: 'RunningHub task ended without a usable result.' } };
      if (response.status !== 'SUCCESS') return { status: 'pending', handle: handle(taskId), receipt: receipt(taskId), wakeAt: next.wakeAt };
      const selectedResults = selectNativeResults(response.results, descriptor);
      const resultJournal = await journal(ctx.operation, '/results');
      const release = await resultJournal.acquire();
      try { await resultJournal.write({ taskId, status: response.status, ...(usage === undefined ? {} : { usage }),
        results: selectedResults.map(r => ({ url: r.url, outputType: r.outputType })),
        ...(v2 ? { rawResults: response.results.map(r => ({ url: r.url, outputType: r.outputType })),
          selectedCount: selectedResults.length, ignoredCount: response.results.length - selectedResults.length } : {}) }); }
      finally { await release(); }
      // Signed URLs never enter public handles, receipts or diagnostics.
      return { status: 'ready', handle: handle(taskId), receipt: receipt(taskId) };
    },
    async collect(ctx) {
      const taskId = validateHandle(ctx); await validateOwnedTask(ctx, taskId);
      const results = await (await journal(ctx.operation, '/results')).read();
      if (results?.taskId !== taskId || !Array.isArray(results.results)) fail('RESULT_JOURNAL_MISSING');
      const artifacts = [];
      for (const result of results.results) {
        let url; try { url = new URL(result.url); } catch { fail('UNSAFE_RESULT_URL'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
          || !config.http.allowedDownloadHosts.includes(url.hostname)) fail('UNSAFE_RESULT_URL');
        const timer = clock.timeout(config.http.requestTimeoutMs);
        try {
          const response = await boundedBySignal(timer.signal, () => fetch(url.href, { redirect: 'error', signal: timer.signal }));
          if (!response.ok) fail('DOWNLOAD_HTTP_ERROR');
          const mediaType = response.headers.get('content-type')?.split(';')[0];
          if (mediaType !== RESULT_TYPES[result.outputType] || !mediaType?.startsWith(`${descriptor.portTable.result}/`)) fail('DOWNLOAD_MEDIA_MISMATCH');
          const bytes = await boundedBySignal(timer.signal, () => boundedBytes(response, config.http.maxDownloadBytes));
          verifyMediaBytes(bytes, mediaType);
          artifacts.push(await ctx.resources.put(bytes, mediaType, { signal: timer.signal }));
        } finally { timer.cancel(); }
      }
      const value = descriptor.portTable.result === 'video' ? sdk.sealGeneratedVideoSet({ videos: artifacts }) : sdk.sealGeneratedImageSet({ images: artifacts });
      return { status: 'completed', receipt: receipt(taskId), result: { value: { kind: 'inline', value } } };
    },
  };
}
