#!/usr/bin/env node
import { readDocument, writeNewDocument, persistRevision, importWorkflow, validateRevision, inspectWorkflow, editWorkflow, diffWorkflows,
  fetchWorkflow, rebuildDescriptor } from '../workflow/index.js';
import { safeError, fail } from '../core/errors.js';
import { importWorkflowFile, validateWorkflowDocument, editWorkflowDocument, requestFromDocument, writeNewWorkflowFile, readBoundedFile } from '../generic/document.js';
import { parseJson, exact } from '../generic/request.js';
import { renderWorkflowAuthor } from '../generic/author-source.js';
import { open } from 'node:fs/promises';
import { prepareWorkflowReviewCandidate } from '../generic/review-candidate.js';
const [command, ...args] = process.argv.slice(2);
const allowed = { import: ['input', 'output', 'directory', 'expected-head'], inspect: ['input'], diff: ['before', 'after'],
  apply: ['input', 'operations', 'expected-digest', 'node-contracts', 'output', 'directory', 'expected-head'], export: ['input', 'output'],
  fetch: ['config', 'output', 'directory', 'expected-head'], 'descriptor-rebuild': ['input', 'descriptor', 'graph-file', 'output'],
  'import-native': ['input', 'output'], 'edit-native': ['input', 'operations', 'expected-digest', 'output'],
  'inspect-native': ['input'], 'export-native': ['input', 'output'], 'request-from-file': ['input', 'workflow-id', 'values', 'output'],
  'request-from-document': ['input', 'workflow-id', 'values', 'output'], 'author-from-request': ['input', 'id', 'files', 'outputs', 'output'],
  'review-candidate': ['input', 'config', 'graph', 'credential-sha256', 'files', 'output'] };
async function main() {
  if (command === '--help' || command === 'help' || command === undefined) {
    console.log('rh-workflow import|inspect|diff|apply|export|fetch|descriptor-rebuild\nGeneric own JSON: import-native|inspect-native|edit-native|export-native|request-from-file|request-from-document|author-from-request|review-candidate.\nGeneric writes require --input <file> --output <new-file>; requests require explicit --workflow-id <service-id>; optional --values <json> holds nodeInfoList/files/bindings/review.\nedit-native requires --operations <json> --expected-digest <document-digest>. API graph literals are preserved; UI JSON is retained but needs API export or verified conversion.\nLegacy local writes require explicit --output <new-file> OR --directory <existing-project> --expected-head <digest|none>.\napply requires --operations <json> --expected-digest <digest>; optional --node-contracts <json>.\nfetch requires --config <json> with explicit env CredentialRef; reads only the documented workflow endpoint.\ndescriptor-rebuild requires --input <revision> --descriptor <json> --graph-file <relative-file> --output <new-file>.\nSemantic validation remains UNVERIFIED. New requests require fresh owner billing review.'); return;
  }
  if (!allowed[command]) fail('UNKNOWN_WORKFLOW_COMMAND');
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.startsWith('--') ? args[i].slice(2) : '';
    if (!allowed[command].includes(key) || Object.hasOwn(flags, key) || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_CLI_ARGUMENT');
    flags[key] = args[i + 1];
  }
  const input = key => { if (!flags[key]) fail('MISSING_CLI_ARGUMENT'); return readDocument(flags[key]); };
  if (['import-native', 'inspect-native', 'edit-native', 'export-native', 'request-from-file', 'request-from-document', 'author-from-request', 'review-candidate'].includes(command)) {
    if (!flags.input || command !== 'inspect-native' && !flags.output) fail('EXPLICIT_OUTPUT_REQUIRED');
    const genericRead = async path => parseJson((await readBoundedFile(path, 32 * 1024 * 1024)).toString('utf8'), 32 * 1024 * 1024);
    let value;
    if (command === 'review-candidate') {
      if (!flags.config || !flags['credential-sha256']) fail('MISSING_CLI_ARGUMENT');
      value = await prepareWorkflowReviewCandidate({ config: await genericRead(flags.config), request: await genericRead(flags.input),
        graph: flags.graph ? await genericRead(flags.graph) : undefined, credentialSha256: flags['credential-sha256'], files: flags.files ? await genericRead(flags.files) : [] });
      await writeNewWorkflowFile(flags.output, value); console.log(JSON.stringify({ output: flags.output, reviewRequired: true })); return;
    }
    if (command === 'author-from-request') {
      const source = renderWorkflowAuthor(await genericRead(flags.input), { ...(flags.id ? { id: flags.id } : {}),
        files: flags.files ? await genericRead(flags.files) : [], outputs: flags.outputs ? await genericRead(flags.outputs) : [] });
      const output = await open(flags.output, 'wx', 0o600); try { await output.writeFile(source); await output.sync(); } finally { await output.close(); }
      console.log(JSON.stringify({ output: flags.output, reviewRequired: true })); return;
    }
    if (command === 'import-native') value = await importWorkflowFile(flags.input);
    else if (command.startsWith('request-')) {
      if (!flags['workflow-id']) fail('WORKFLOW_ID_REQUIRED');
      const doc = command === 'request-from-file' ? await importWorkflowFile(flags.input) : validateWorkflowDocument(await genericRead(flags.input));
      const values = flags.values ? await genericRead(flags.values) : {};
      exact(values, ['nodeInfoList', 'files', 'bindings', 'review'], 'UNKNOWN_REQUEST_VALUES_FIELD');
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
    resolveCredential: ref => {
      if (ref.store !== 'env' || !/^[A-Za-z_][A-Za-z0-9_]{0,199}$/.test(ref.key)) fail('UNSUPPORTED_CLI_CREDENTIAL_STORE');
      const secret = process.env[ref.key]; if (!secret) fail('CREDENTIAL_MISSING'); return secret;
    },
  }) : command === 'import' ? importWorkflow(await input('input')) : editWorkflow(await input('input'), await input('operations'), flags['expected-digest'], flags['node-contracts'] ? await input('node-contracts') : undefined);
  if (flags.output) { await writeNewDocument(flags.output, revision); console.log(JSON.stringify({ output: flags.output, digest: revision.revisionDigest, graphDigest: revision.graphDigest.value, semanticValidation: 'UNVERIFIED' })); }
  else console.log(JSON.stringify(await persistRevision(flags.directory, revision, flags['expected-head'] === 'none' ? null : flags['expected-head'])));
}
try { await main(); } catch (error) { console.error(JSON.stringify({ ok: false, code: safeError(error).code })); process.exitCode = 1; }
