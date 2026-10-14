#!/usr/bin/env node
import { readDocument, writeNewDocument, persistRevision, importWorkflow, validateRevision, inspectWorkflow, editWorkflow, diffWorkflows,
  fetchWorkflow, rebuildDescriptor } from '../workflow/index.js';
import { safeError, fail } from '../core/errors.js';
import { importWorkflowFile, validateWorkflowDocument, editWorkflowDocument, requestFromDocument, writeNewWorkflowFile, readBoundedFile } from '../generic/document.js';
import { parseJson, exact } from '../generic/request.js';
import { renderWorkflowAuthor } from '../generic/author-source.js';
import { open } from 'node:fs/promises';
import { prepareWorkflowReviewCandidate } from '../generic/review-candidate.js';
import { fetchAiApp, validateAiAppDocument, requestFromAiAppDocument } from '../ai-app/document.js';
import { renderAiAppAuthor } from '../ai-app/author-source.js';
import { prepareAiAppReviewCandidate } from '../ai-app/review-candidate.js';
const genericRead = async path => parseJson((await readBoundedFile(path, 32 * 1024 * 1024)).toString('utf8'), 32 * 1024 * 1024);
const resolveCredential = ref => {
  if (ref.store !== 'env' || !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(ref.key)) fail('UNSUPPORTED_CLI_CREDENTIAL_STORE');
  const secret = process.env[ref.key]; if (!secret) fail('CREDENTIAL_MISSING'); return secret;
};
function requestKind(request) {
  if (request?.format === 'hypit-runninghub.request@1') return 'workflow';
  if (request?.format === 'hypit-runninghub.ai-app-request@1') return 'ai-app';
  fail('INVALID_OPERATION_REQUEST');
}
const [command, ...args] = process.argv.slice(2);
const allowed = { import: ['input', 'output', 'directory', 'expected-head'], inspect: ['input'], diff: ['before', 'after'],
  apply: ['input', 'operations', 'expected-digest', 'node-contracts', 'output', 'directory', 'expected-head'], export: ['input', 'output'],
  fetch: ['config', 'output', 'directory', 'expected-head'], 'descriptor-rebuild': ['input', 'descriptor', 'graph-file', 'output'],
  'import-native': ['input', 'output'], 'edit-native': ['input', 'operations', 'expected-digest', 'output'],
  'inspect-native': ['input'], 'export-native': ['input', 'output'], 'request-from-file': ['input', 'workflow-id', 'values', 'output'],
  'request-from-document': ['input', 'workflow-id', 'values', 'output'], 'author-from-request': ['input', 'id', 'files', 'outputs', 'output'],
  'fetch-app': ['config', 'output'], 'inspect-app': ['input'], 'request-from-app': ['input', 'values', 'output'],
  'review-candidate': ['input', 'config', 'graph', 'app', 'credential-sha256', 'access-password-sha256', 'files', 'output'] };
async function main() {
  if (command === '--help' || command === 'help' || command === undefined) {
    console.log('rh-workflow import|inspect|diff|apply|export|fetch|descriptor-rebuild\nGeneric own JSON: import-native|inspect-native|edit-native|export-native|request-from-file|request-from-document|author-from-request|review-candidate.\nAI Apps: fetch-app --config <ai-app-fetch.json> --output <new-app-document.json>; inspect-app --input <app-document.json>; request-from-app --input <app-document.json> [--values <json>] --output <new-request.json>.\nfetch/fetch-app resolve only explicit env CredentialRefs and read documented metadata endpoints; workflow targets accept decimal IDs or official /post/<id> URLs, App targets accept decimal IDs or official /ai-detail/<id> URLs. No upload or generation occurs.\nGeneric writes require --input <file> --output <new-file>; workflow requests require explicit --workflow-id <service-id>. Optional --values <json> holds exactly nodeInfoList/files/bindings/review/instanceType; App defaults are retained except explicit overrides or file bindings.\nauthor-from-request dispatches Workflow or AiApp requests; optional --id, --files <json>, --outputs <json>.\nreview-candidate requires --input <request.json> --config <endpoint.json> --credential-sha256 <hash> --output <new-file>; Workflow accepts --graph <json>, App requires --app <app-document.json> instead. Optional --access-password-sha256 <hash> binds the Endpoint password reference; never supply actual keys/passwords as CLI flags. Optional --files <json> binds ordered local file bytes. Candidates remain UNREVIEWED: owner must manually review Membership key, service, chosen parameters and absence of external-money charges.\nedit-native requires --operations <json> --expected-digest <document-digest>. API graph literals are preserved; UI JSON needs API export or verified conversion.\nLegacy writes require explicit --output <new-file> OR --directory <existing-project> --expected-head <digest|none>.\napply requires --operations <json> --expected-digest <digest>; optional --node-contracts <json>.\ndescriptor-rebuild requires --input <revision> --descriptor <json> --graph-file <relative-file> --output <new-file>.\nSemantic validation remains UNVERIFIED. New requests require fresh owner billing review.'); return;
  }
  if (!allowed[command]) fail('UNKNOWN_WORKFLOW_COMMAND');
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.startsWith('--') ? args[i].slice(2) : '';
    if (!allowed[command].includes(key) || Object.hasOwn(flags, key) || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_CLI_ARGUMENT');
    flags[key] = args[i + 1];
  }
  const input = key => { if (!flags[key]) fail('MISSING_CLI_ARGUMENT'); return readDocument(flags[key]); };
  if (command === 'fetch-app') {
    if (!flags.config) fail('MISSING_CLI_ARGUMENT');
    if (!flags.output) fail('EXPLICIT_OUTPUT_REQUIRED');
    const app = await fetchAiApp(await genericRead(flags.config), { fetch: globalThis.fetch, resolveCredential });
    await writeNewWorkflowFile(flags.output, app);
    console.log(JSON.stringify({ output: flags.output, webappId: app.webappId, appDigest: app.appDigest, semanticValidation: 'UNVERIFIED' })); return;
  }
  if (command === 'inspect-app') {
    if (!flags.input) fail('MISSING_CLI_ARGUMENT');
    const app = validateAiAppDocument(await genericRead(flags.input));
    console.log(JSON.stringify({ webappId: app.webappId, webappName: app.webappName, accessEncrypted: app.accessEncrypted,
      appDigest: app.appDigest, nodeInfoList: app.nodeInfoList }, null, 2)); return;
  }
  if (command === 'request-from-app') {
    if (!flags.input || !flags.output) fail('EXPLICIT_OUTPUT_REQUIRED');
    const values = flags.values ? await genericRead(flags.values) : {};
    exact(values, ['nodeInfoList', 'files', 'bindings', 'review', 'instanceType'], 'UNKNOWN_REQUEST_VALUES_FIELD');
    const request = requestFromAiAppDocument(await genericRead(flags.input), { ...values, draft: true });
    await writeNewWorkflowFile(flags.output, request);
    console.log(JSON.stringify({ output: flags.output, reviewRequired: true, semanticValidation: 'UNVERIFIED' })); return;
  }
  if (['import-native', 'inspect-native', 'edit-native', 'export-native', 'request-from-file', 'request-from-document', 'author-from-request', 'review-candidate'].includes(command)) {
    if (!flags.input || command !== 'inspect-native' && !flags.output) fail('EXPLICIT_OUTPUT_REQUIRED');
    let value;
    if (command === 'review-candidate') {
      if (!flags.config || !flags['credential-sha256']) fail('MISSING_CLI_ARGUMENT');
      const request = await genericRead(flags.input), kind = requestKind(request);
      if (kind === 'ai-app' ? Boolean(flags.graph) : Boolean(flags.app)) fail('INVALID_CLI_ARGUMENT');
      if (kind === 'ai-app' && !flags.app) fail('REVIEW_APP_REQUIRED');
      const options = { config: await genericRead(flags.config), request, credentialSha256: flags['credential-sha256'],
        accessPasswordSha256: flags['access-password-sha256'], files: flags.files ? await genericRead(flags.files) : [] };
      value = kind === 'ai-app'
        ? await prepareAiAppReviewCandidate({ ...options, app: await genericRead(flags.app) })
        : await prepareWorkflowReviewCandidate({ ...options, graph: flags.graph ? await genericRead(flags.graph) : undefined });
      await writeNewWorkflowFile(flags.output, value); console.log(JSON.stringify({ output: flags.output, reviewRequired: true })); return;
    }
    if (command === 'author-from-request') {
      const request = await genericRead(flags.input), render = requestKind(request) === 'ai-app' ? renderAiAppAuthor : renderWorkflowAuthor;
      const source = render(request, { ...(flags.id ? { id: flags.id } : {}),
        files: flags.files ? await genericRead(flags.files) : [], outputs: flags.outputs ? await genericRead(flags.outputs) : [] });
      const output = await open(flags.output, 'wx', 0o600); try { await output.writeFile(source); await output.sync(); } finally { await output.close(); }
      console.log(JSON.stringify({ output: flags.output, reviewRequired: true })); return;
    }
    if (command === 'import-native') value = await importWorkflowFile(flags.input);
    else if (command.startsWith('request-')) {
      if (!flags['workflow-id']) fail('WORKFLOW_ID_REQUIRED');
      const doc = command === 'request-from-file' ? await importWorkflowFile(flags.input) : validateWorkflowDocument(await genericRead(flags.input));
      const values = flags.values ? await genericRead(flags.values) : {};
      exact(values, ['nodeInfoList', 'files', 'bindings', 'review', 'instanceType'], 'UNKNOWN_REQUEST_VALUES_FIELD');
      value = requestFromDocument(doc, { ...values, workflowId: flags['workflow-id'], draft: true });
    } else {
      const doc = validateWorkflowDocument(await genericRead(flags.input));
      if (command === 'inspect-native') { console.log(JSON.stringify({ digest: doc.revisionDigest, sourceFormat: doc.sourceFormat, executionReady: doc.executionReady, graphDigest: doc.graphDigest,
        conversion: doc.conversion, semanticValidation: doc.semanticValidation })); return; }
      if (command === 'export-native') { if (!doc.executionReady) fail('API_EXPORT_REQUIRED'); value = doc.graph; }
      else { if (!flags.operations || !flags['expected-digest']) fail('MISSING_CLI_ARGUMENT'); value = editWorkflowDocument(doc, await genericRead(flags.operations), flags['expected-digest']); }
    }
    await writeNewWorkflowFile(flags.output, value);
    console.log(JSON.stringify({ output: flags.output, digest: value.revisionDigest, executionReady: value.executionReady, reviewRequired: true })); return;
  }
  if (command === 'inspect') { console.log(JSON.stringify(inspectWorkflow(await input('input')), null, 2)); return; }
  if (command === 'diff') { console.log(JSON.stringify(diffWorkflows(await input('before'), await input('after')), null, 2)); return; }
  if (command === 'export') { if (!flags.output) fail('EXPLICIT_OUTPUT_REQUIRED'); await writeNewDocument(flags.output, validateRevision(await input('input')).graph); console.log(JSON.stringify({ output: flags.output, semanticValidation: 'UNVERIFIED' })); return; }
  if (command === 'descriptor-rebuild') {
    if (!flags.output || !flags['graph-file']) fail('EXPLICIT_OUTPUT_REQUIRED');
    const candidate = rebuildDescriptor(await input('descriptor'), await input('input'), flags['graph-file']);
    await writeNewDocument(flags.output, candidate.descriptor);
    console.log(JSON.stringify({ output: flags.output, reviewRequired: true, semanticValidation: 'UNVERIFIED' })); return;
  }
  if (Boolean(flags.output) === Boolean(flags.directory)) fail('EXPLICIT_OUTPUT_REQUIRED');
  if (flags.directory && !flags['expected-head'] || flags.output && flags['expected-head']) fail('EXPECTED_HEAD_REQUIRED');
  const revision = command === 'fetch' ? await fetchWorkflow(await input('config'), {
    fetch: globalThis.fetch,
    resolveCredential,
  }) : command === 'import' ? importWorkflow(await input('input')) : editWorkflow(await input('input'), await input('operations'), flags['expected-digest'], flags['node-contracts'] ? await input('node-contracts') : undefined);
  if (flags.output) { await writeNewDocument(flags.output, revision); console.log(JSON.stringify({ output: flags.output, digest: revision.revisionDigest, graphDigest: revision.graphDigest.value, semanticValidation: 'UNVERIFIED' })); }
  else console.log(JSON.stringify(await persistRevision(flags.directory, revision, flags['expected-head'] === 'none' ? null : flags['expected-head'])));
}
try { await main(); } catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error).code })); process.exitCode = 1; }
