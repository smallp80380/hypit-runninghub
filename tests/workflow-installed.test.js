import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('archive installed ordinary CLI and exported workflow SDK operate offline without Hypit or test loader', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rh-workflow-installed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('..', import.meta.url));
  let serial = 0;
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  async function run(command, args, cwd = directory) {
    const stdout = join(directory, `stdout-${++serial}`), stderr = join(directory, `stderr-${serial}`);
    try {
      await promisify(execFile)('/bin/sh', ['-c', [command, ...args].map(quote).join(' ') + ` >${quote(stdout)} 2>${quote(stderr)}`], { cwd });
    } catch (error) { error.stderr = await readFile(stderr, 'utf8'); error.message += '\n' + error.stderr; throw error; }
    return JSON.parse(await readFile(stdout, 'utf8'));
  }
  const cache = join(directory, 'npm-cache');
  const packed = await run('npm', ['pack', '--cache', cache, '--ignore-scripts', '--json', '--pack-destination', directory], source);
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await run('npm', ['install', '--cache', cache, '--offline', '--ignore-scripts', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--json', join(directory, packed[0].filename)]);
  const installed = join(directory, 'node_modules/@local/provider-runninghub');
  const cli = join(directory, 'node_modules/.bin/rh-workflow');
  assert.equal(await realpath(cli), join(installed, 'bin/rh-workflow.js'));
  assert.ok(packed[0].files.some(file => file.path === 'workflow/index.js'));
  assert.ok(!packed[0].files.some(file => file.path.startsWith('tests/')));
  const graph = { '1': { class_type: 'Text', inputs: { text: 'private fixture' } }, '2': { class_type: 'Sampler', inputs: { prompt: ['1', 0], seed: 1 } } };
  const input = join(directory, 'graph.json'), operations = join(directory, 'operations.json');
  await writeFile(input, JSON.stringify(graph));
  await writeFile(operations, JSON.stringify([{ op: 'setInput', nodeId: '2', fieldName: 'seed', value: 2 }]));
  const project = join(directory, 'project'); await mkdir(project);
  const first = await run(cli, ['import', '--input', input, '--directory', project, '--expected-head', 'none']);
  const second = await run(cli, ['apply', '--input', first.revisionFile, '--operations', operations, '--expected-digest', first.digest, '--directory', project, '--expected-head', first.digest]);
  assert.notEqual(first.digest, second.digest);
  const inspected = await run(cli, ['inspect', '--input', second.revisionFile]);
  assert.equal(inspected.links, 1); assert.equal(inspected.semanticValidation, 'UNVERIFIED');
  assert.ok(!JSON.stringify(inspected).includes('private fixture'));
  assert.equal((await run(cli, ['diff', '--before', first.revisionFile, '--after', second.revisionFile])).changes.length, 1);
  const output = join(directory, 'export.json');
  await run(cli, ['export', '--input', second.revisionFile, '--output', output]);
  assert.equal(JSON.parse(await readFile(output, 'utf8'))['2'].inputs.seed, 2);
  await assert.rejects(run(cli, ['apply', '--input', first.revisionFile, '--operations', operations, '--expected-digest', first.digest, '--directory', project, '--expected-head', first.digest]), error => error.stderr.includes('REVISION_CAS_CONFLICT'));
  await assert.rejects(run(cli, ['export', '--input', second.revisionFile, '--output', output]), error => error.stderr.includes('OUTPUT_EXISTS'));
  const sdkProof = join(directory, 'sdk-proof.mjs');
  await writeFile(sdkProof, "import {importWorkflow, inspectWorkflow} from '@local/provider-runninghub/workflow'; console.log(JSON.stringify(inspectWorkflow(importWorkflow({'1':{class_type:'Text',inputs:{text:'fixture'}}}))));\n");
  assert.equal((await run(process.execPath, [sdkProof])).nodeCount, 1);
  const config = join(directory, 'fetch-config.json'), preload = join(directory, 'fetch-mock.mjs');
  await writeFile(config, JSON.stringify({ format: 'hypit-runninghub.fetch@1', baseUrl: 'https://www.runninghub.ai', workflowId: '123',
    apiKey: { store: 'env', key: 'INERT_OFFLINE_FETCH_KEY' }, requestTimeoutMs: 1000, maxResponseBytes: 1048576 }));
  await writeFile(preload, "globalThis.fetch=async(url,init)=>{ if(url!=='https://www.runninghub.ai/api/openapi/getJsonApiFormat'||init.redirect!=='error'||JSON.parse(init.body).workflowId!=='123'||init.headers.authorization!=='Bearer offline-fixture')throw Error('unexpected mock request'); return new Response(JSON.stringify({code:0,data:{prompt:JSON.stringify({'1':{class_type:'Text',inputs:{text:'fixture'}}})}})); };\n");
  const fetched = join(directory, 'fetched.json');
  const fetchResult = await run('env', ['INERT_OFFLINE_FETCH_KEY=offline-fixture', process.execPath, '--import', preload, cli, 'fetch', '--config', config, '--output', fetched]);
  assert.ok(fetchResult.digest); const fetchedRevision = JSON.parse(await readFile(fetched, 'utf8'));
  assert.equal(fetchedRevision.provenance.kind, 'fetched-workflow');
  assert.ok(!JSON.stringify(fetchedRevision).includes('offline-fixture'));
  const unsupportedConfig = join(directory, 'unsupported-store.json');
  const invalid = JSON.parse(await readFile(config, 'utf8')); invalid.apiKey.store = 'custom'; await writeFile(unsupportedConfig, JSON.stringify(invalid));
  await assert.rejects(run(process.execPath, ['--import', preload, cli, 'fetch', '--config', unsupportedConfig, '--output', join(directory, 'refused-fetch.json')]), error => error.stderr.includes('UNSUPPORTED_CLI_CREDENTIAL_STORE'));
  const nativeDescriptor = JSON.parse(await readFile(new URL('../examples/v0.0.3/mock-inline-descriptor.json', import.meta.url)));
  const revisionFile = join(directory, 'inline-revision.json'), descriptorFile = join(directory, 'descriptor.json');
  const graphFile = join(directory, 'inline-graph.json');
  await writeFile(graphFile, await readFile(new URL('../examples/v0.0.3/mock-image-audio-graph.json', import.meta.url)));
  await writeFile(descriptorFile, JSON.stringify(nativeDescriptor));
  await run(cli, ['import', '--input', graphFile, '--output', revisionFile]);
  const rebuilt = join(directory, 'rebuilt-descriptor.json');
  const rebuiltResult = await run(cli, ['descriptor-rebuild', '--input', revisionFile, '--descriptor', descriptorFile, '--graph-file', 'graphs/rebuilt.json', '--output', rebuilt]);
  assert.equal(rebuiltResult.reviewRequired, true);
  assert.equal(JSON.parse(await readFile(rebuilt, 'utf8')).graphFile, 'graphs/rebuilt.json');
});
