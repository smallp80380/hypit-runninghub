// Reproducible FREE offline installed Hypit proof. Creates only /tmp state.
// Pass a sealed archive as argv[2]. The normal official CLI owns SDK loading.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const archive = resolve(process.argv[2] ?? 'artifacts/local-provider-runninghub-0.0.3.tgz');
const directory = await mkdtemp(join(tmpdir(), 'hypit-rh-v003-proof-'));
const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
async function run(command, args, name, options = {}) {
  const stdout = join(directory, name + '.json'), stderr = join(directory, name + '.stderr');
  const commandParts = options.mock ? ['env', `NODE_OPTIONS=--import=${join(directory, 'mock-preload.mjs')}`, command, ...args] : [command, ...args];
  try { await promisify(execFile)('/bin/sh', ['-c', commandParts.map(quote).join(' ') + ` >${quote(stdout)} 2>${quote(stderr)}`], { cwd: directory, timeout: 120000 }); }
  catch (error) { throw Error(`${name}: ${error.message}\n${await readFile(stderr, 'utf8')}\n${await readFile(stdout, 'utf8')}`); }
  const text = await readFile(stdout, 'utf8'); return text ? JSON.parse(text) : undefined;
}
const json = async (file, value) => writeFile(join(directory, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
await json('package.json', { private: true, type: 'module' });
await run('npm', ['install', '--offline', '--cache', join(directory, 'npm-cache'), '--ignore-scripts', '--legacy-peer-deps', '--omit=dev', '--no-audit', '--no-fund', '--json', archive], 'install-provider');
const provider = join(directory, 'node_modules/@local/provider-runninghub');
await cp(join(provider, 'scaffold'), directory, { recursive: true });
await run('npm', ['install', '--offline', '--cache', join(directory, 'npm-cache'), '--ignore-scripts', '--legacy-peer-deps', '--install-links', '--no-audit', '--no-fund', '--json', './consumer-model'], 'install-model');
const descriptor = JSON.parse(await readFile(join(directory, 'consumer-model/descriptor.json')));
// This conversion and authority exist ONLY for an entirely intercepted inert
// fixture. The shipped scaffold retains fixtureOnly=true and execution=false.
descriptor.fixtureOnly = false;
descriptor.resultSelection = { kind: 'extensions', selectedOutputTypes: ['mp4'], ignoredOutputTypes: ['png', 'wav'], maxSelected: 1, maxIgnored: 2 };
await json('consumer-model/descriptor.json', descriptor);
await json('node_modules/@example/image-audio-workflow/descriptor.json', descriptor);
const graph = JSON.parse(await readFile(join(directory, 'consumer-model/graph.json')));
await mkdir(join(directory, 'state/descriptors'), { recursive: true }); await mkdir(join(directory, 'state/private'), { mode: 0o700 });
await json('state/descriptors/descriptor.json', descriptor); await json('state/descriptors/graph.json', graph);
const profile = JSON.parse(await readFile(join(directory, 'profile.json')));
const config = profile.endpoints['runninghub.native'].config;
config.apiKey = { store: 'env', key: 'INERT_OFFLINE_MEMBER_KEY' }; config.submissionEnabled = true;
config.liveBillingEvidence = { kind: 'private-file', path: 'private/member.json' }; config.http.allowedDownloadHosts = ['cdn.example.invalid'];
config.polling.intervalMs = 10;
await json('profile.json', profile);
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inertSecret = 'offline-mock-v003-not-real';
await json('state/private/member.json', { format: 'REVIEWED_MEMBER_BINDING@2', family: 'native-workflow', baseUrl: config.baseUrl,
  credential: { reference: config.apiKey, sha256: hash(inertSecret) },
  workflow: { workflowId: descriptor.workflowId, graphDigest: descriptor.graphDigest.value, descriptorDigest: hash(canonical(descriptor)), sourceMode: descriptor.sourceMode,
    mappingPolicy: 'declared-port-inputs-only', scope: 'reviewed-native-only-no-external-money' },
  source: { url: 'https://www.runninghub.ai/enterprise-api/consumerApi', noteSha256: 'becf0e9cb51ceee2460b77ebeddc394343e7e982f9fdbb029a3e6e4055386097' },
  humanReview: { kind: 'project-owner-reviewed-membership-key-and-native-workflow', reviewer: 'OFFLINE-MOCK-ONLY', recordId: 'INERT-FIXTURE-NO-LIVE-AUTHORITY', reviewedAt: new Date(Date.now() - 10000).toISOString() },
  expiresAt: new Date(Date.now() + 3600000).toISOString() });
await mkdir(join(directory, 'assets'));
await writeFile(join(directory, 'assets/reference.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
const wav = Buffer.alloc(44 + 1600); wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(1600, 40);
await writeFile(join(directory, 'assets/reference.wav'), wav);
await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=10:d=0.2', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(directory, 'mock-result.mp4')], 'fixture-mp4');
await writeFile(join(directory, 'mock-preload.mjs'), `import {readFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(directory)}; process.env.INERT_OFFLINE_MEMBER_KEY=${JSON.stringify(inertSecret)};
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,init={})=>{const url=new URL(typeof input==='string'?input:input.url);
appendFileSync(root+'/mock-calls.jsonl',JSON.stringify({path:url.pathname,method:init.method??'GET'})+'\\n');
if(url.hostname==='cdn.example.invalid'){if(init.headers)throw Error('CREDENTIAL_FORWARDING');return new Response(readFileSync(root+'/mock-result.mp4'),{headers:{'content-type':'video/mp4'}});}
if(url.origin!=='https://www.runninghub.ai')throw Error('UNEXPECTED_OFFLINE_ORIGIN');
if(url.pathname==='/enterprise-api/consumerApi')return new Response('Offline mock price document; no live cost quote.');
if(url.pathname==='/uc/openapi/accountStatus')return json({code:0,data:{apiType:'NORMAL',remainCoins:'1000'}});
if(url.pathname==='/task/openapi/upload'){const file=init.body.get('file');appendFileSync(root+'/upload-evidence.jsonl',JSON.stringify({name:file.name,type:file.type,size:file.size})+'\\n');return json({code:0,data:{fileName:'api/exact-'+file.name,fileType:'input'}});}
if(url.pathname==='/task/openapi/create'){const body=JSON.parse(init.body),graph=JSON.parse(body.workflow);for(const mapping of body.nodeInfoList)if(graph[mapping.nodeId].inputs[mapping.fieldName]!==mapping.fieldValue)throw Error('MAPPING_DIVERGENCE');appendFileSync(root+'/wire-evidence.jsonl',JSON.stringify(body)+'\\n');return json({code:0,data:{taskId:'offline-v003-installed-task',taskStatus:'RUNNING'}});}
if(url.pathname==='/openapi/v2/query')return json({taskId:'offline-v003-installed-task',status:'SUCCESS',results:['png','wav','mp4'].map(outputType=>({url:'https://cdn.example.invalid/result.'+outputType,outputType})),usage:{consumeCoins:'1',consumeMoney:null,thirdPartyConsumeMoney:null,taskCostTime:'1'}});
throw Error('UNEXPECTED_OFFLINE_PATH');};\n`);
const common = ['--runtime', './profile.json', '--workspace', '.', '--json'];
const check = await run('hypit', ['check', './author.svml', '--workspace', '.', '--json'], 'check', { mock: true }); assert.equal(check.ok, true);
const plan = await run('hypit', ['plan', './run.svrun', ...common], 'plan', { mock: true }); assert.equal(plan.ok, true); assert.equal(plan.providerRequestCount, 1);
const doctor = await run('hypit', ['doctor', ...common], 'doctor', { mock: true }); assert.equal(doctor.ok, true);
const pricing = await run('hypit', ['pricing', './run.svrun', ...common], 'pricing', { mock: true });
assert.equal(pricing.groups.length, 1); assert.equal(pricing.groups[0].status, 'resolved'); assert.equal(pricing.groups[0].pricing.kind, 'page');
const build = await run('hypit', ['build', './run.svrun', '--follow', ...common], 'build', { mock: true });
assert.equal(build.build.work.outcome, 'complete'); assert.equal(build.build.result.state, 'complete');
await run('hypit', ['inspect', build.build.id, '--workspace', '.', '--verbose', '--json'], 'inspect', { mock: true });
await run('hypit', ['get', build.build.id, '--output', 'demo.video', '--to', './exported.mp4', '--workspace', '.', '--json'], 'get', { mock: true });
const exported = await readFile(join(directory, 'exported.mp4')); assert.deepEqual(exported, await readFile(join(directory, 'mock-result.mp4')));
const probe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', './exported.mp4'], 'ffprobe'); assert.equal(probe.streams[0].codec_type, 'video');
const calls = (await readFile(join(directory, 'mock-calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
assert.equal(calls.filter(call => call.path === '/task/openapi/create').length, 1); assert.equal(calls.filter(call => call.path === '/task/openapi/upload').length, 2);
assert.equal(calls.filter(call => call.path === '/api/openapi/getJsonApiFormat').length, 0);
assert.equal((await lstat(provider)).isSymbolicLink(), false);
assert.ok(!(await readdir(join(directory, 'node_modules'))).includes('@hypit'));
await run('hypit', ['runtime', 'down', ...common], 'runtime-down', { mock: true });
const report = { format: 'hypit-runninghub.installed-v003-proof@1', directory, archive, archiveSha256: hash(await readFile(archive)),
  check: check.ok, plan: plan.ok, doctor: doctor.ok, pricing: true, build, exportedArtifact: { output: 'demo.video', mediaType: 'video/mp4', bytes: exported.length, sha256: hash(exported), codec: probe.streams[0].codec_name },
  uploadCount: 2, createCount: 1, sdkTestLoader: false, sdkCopiedOrInstalledLocally: false, realCredentials: false, liveCalls: 0,
  limitations: ['Fully intercepted mock transport and local valid fixture MP4; no RunningHub backend execution or generated media quality claim.'] };
await json('proof.json', report);
console.log(JSON.stringify(report, null, 2));
