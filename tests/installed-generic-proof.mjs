// FREE normal installed Hypit proof; all service IO intercepted, /tmp only.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,cp,lstat,readdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { credentialSha256, accessPasswordSha256, assertPublicSafe } from './installed-generic-mock-preload.mjs';
const archive=resolve(process.argv[2]??'artifacts/local-provider-runninghub-0.0.4.tgz');
const directory=await mkdtemp(join(tmpdir(),'hypit-rh-v004-proof-'));
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
async function run(command,args,name,{mock=false,allowFailure=false}={}){
 const out=join(directory,name+'.json'),err=join(directory,name+'.stderr');
 const parts=mock?['env',`NODE_OPTIONS=--import=${join(directory,'mock-preload.mjs')}`,command,...args]:[command,...args];
 try{await promisify(execFile)('/bin/sh',['-c',parts.map(quote).join(' ')+` >${quote(out)} 2>${quote(err)}`],{cwd:directory,timeout:120000});}
 catch(error){const errorText=await readFile(err,'utf8'),outputText=await readFile(out,'utf8');assertPublicSafe(errorText);assertPublicSafe(outputText);if(!allowFailure)throw Error(`${name}: ${error.message}\n${errorText}\n${outputText}`);}
 const text=await readFile(out,'utf8');assertPublicSafe(text);assertPublicSafe(await readFile(err,'utf8'));return text?JSON.parse(text):undefined;
}
const save=(file,value)=>writeFile(join(directory,file),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sorted=value=>value===null||typeof value!=='object'?JSON.stringify(value):Array.isArray(value)?`[${value.map(sorted).join(',')}]`:`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+sorted(value[key])).join(',')}}`;
const xml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
await save('package.json',{private:true,type:'module'});
await run('npm',['install','--offline','--cache',join(directory,'cache'),'--ignore-scripts','--legacy-peer-deps','--omit=dev','--no-audit','--no-fund','--json',archive],'install-provider');
const provider=join(directory,'node_modules/@local/provider-runninghub');
await mkdir(join(directory,'assets'));await mkdir(join(directory,'state/reviews'),{recursive:true,mode:0o700});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');await writeFile(join(directory,'assets/image.png'),png);
const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);await writeFile(join(directory,'assets/audio.wav'),wav);
await run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=black:s=32x32:r=10:d=0.2','-an','-c:v','libx264','-pix_fmt','yuv420p',join(directory,'assets/video.mp4')],'fixture-video');
const mp4=await readFile(join(directory,'assets/video.mp4')),csv=Buffer.from('a,b\n1,2\n'),binary=Buffer.from([0,255,1,2]);await writeFile(join(directory,'assets/data.csv'),csv);await writeFile(join(directory,'assets/data.bin'),binary);
const types=[{src:'./assets/image.png',mediaType:'image/png',bytes:png},{src:'./assets/audio.wav',mediaType:'audio/wav',bytes:wav},{src:'./assets/video.mp4',mediaType:'video/mp4',bytes:mp4}];
const config=JSON.parse(await readFile(join(provider,'examples/generic-config.json')));config.apiKey={store:'env',key:'INERT_GENERIC_MEMBER_KEY'};config.accessPassword={store:'env',key:'INERT_GENERIC_ACCESS_PASSWORD'};config.keyType='Consumer-Member';config.submissionEnabled=true;config.http.allowedDownloadHosts=['cdn.example.invalid'];config.polling.intervalMs=10;
await save('profile.json',{format:'hypit.runtime-local@1',dataRoot:'./state',credentials:{env:{use:'@hypit/credential-store-env',config:{}}},endpoints:{'runninghub.account':{use:'@local/provider-runninghub',config}},bindings:{'@local/provider-runninghub@1#run-workflow':'runninghub.account','@local/provider-runninghub@1#run-ai-app':'runninghub.account'}});
await save('account-config.json',config);
const cli=join(provider,'bin/rh-workflow.js');
const counts=[0,1,3,12,35],cases=[];
for(const [caseIndex,count]of counts.entries()){
 const id=`demo${count}`,node=`custom${caseIndex}`,graph={[node]:{class_type:`NeverRegisteredClass${caseIndex}`,inputs:{literal:[false,null,0,{nested:['x','y']}],staticObject:{a:0}}}};
 const request={format:'hypit-runninghub.request@1',workflowId:`unseen-native-workflow-${count}`,...(count===0?{}:{workflowJson:JSON.stringify(graph)}),nodeInfoList:[{nodeId:node,fieldName:'optionalNew',fieldValue:{list:[false,null,0],text:'<inert & exact>'}}],files:[],bindings:Array.from({length:count},(_,i)=>({fileKey:i===0?'result':`arbitrary key ${i} 🖼`,nodeId:node,fieldName:`file${i}`})),review:`reviews/${id}.json`};
 if(count===12)request.instanceType='plus';
 const fileMetadata=Array.from({length:count},(_,i)=>({key:request.bindings[i].fileKey,mediaType:types[i%types.length].mediaType,size:types[i%types.length].bytes.length}));
 const {review,...content}=request;
 await save(`state/reviews/${id}.json`,{format:'REVIEWED_WORKFLOW_OPERATION@1',credential:{reference:config.apiKey,sha256:credentialSha256},accessPasswordCredential:{reference:config.accessPassword,sha256:accessPasswordSha256},baseUrl:config.baseUrl,requestDigest:hash(sorted({...content,files:fileMetadata})),graphDigest:hash(sorted(graph)),fileDigests:fileMetadata.map((file,i)=>({key:file.key,sha256:hash(types[i%types.length].bytes)})),scope:'reviewed-native-only-no-external-money',source:{url:'https://www.runninghub.ai/enterprise-api/consumerApi',noteSha256:'becf0e9cb51ceee2460b77ebeddc394343e7e982f9fdbb029a3e6e4055386097'},humanReview:{kind:'project-owner-reviewed-membership-key-and-native-workflow',recordId:'INERT-OFFLINE-FIXTURE',reviewer:'MOCK-ONLY',reviewedAt:new Date(Date.now()-10000).toISOString()},expiresAt:new Date(Date.now()+3600000).toISOString()});
 const author='<?svml using="@hypit/markup@1"?>\n<svml>\n<import as="workflow" from="@local/provider-runninghub@1"/>\n'+`<workflow:Workflow id="${id}"><Request>${xml(JSON.stringify(request))}</Request>`+fileMetadata.map((file,i)=>`<File key="${xml(file.key)}" src="${types[i%types.length].src}" media-type="${file.mediaType}"/>`).join('')+(count===0?'':Array.from({length:5},(_,i)=>`<Output name="file${i}" index="${i}"/>`).join(''))+'</workflow:Workflow>\n</svml>\n';
 await writeFile(join(directory,`${id}.svml`),author);
 // Exercise the shipped pure Node import/request/author/review pipeline. It
 // carries future File edges without loading Hypit's development test loader.
 await save(`${id}-values.json`,{nodeInfoList:request.nodeInfoList,files:[],bindings:request.bindings,review:request.review,...(request.instanceType?{instanceType:request.instanceType}:{})});
 await save(`${id}-assets.json`,fileMetadata.map((file,i)=>({key:file.key,src:types[i%types.length].src,mediaType:file.mediaType})));
 await save(`${id}-review-files.json`,fileMetadata.map((file,i)=>({key:file.key,path:types[i%types.length].src,mediaType:file.mediaType})));
 await save(`${id}-outputs.json`,count===0?[]:Array.from({length:5},(_,i)=>({name:`file${i}`,index:i})));
 await save(`${id}-api.json`,graph);
 await run(process.execPath,[cli,'import-native','--input',`${id}-api.json`,'--output',`${id}-document.json`],`${id}-import`);
 if(count>0){await run(process.execPath,[cli,'request-from-document','--input',`${id}-document.json`,'--workflow-id',request.workflowId,'--values',`${id}-values.json`,'--output',`${id}-request.json`],`${id}-prepare-request`);}
 else await save(`${id}-request.json`,request);
 // Replace only this new synthetic Source file; originals imported above are
 // independently checked for exact preservation.
 await run(process.execPath,[cli,'author-from-request','--input',`${id}-request.json`,'--id',id,'--files',`${id}-assets.json`,'--outputs',`${id}-outputs.json`,'--output',`${id}-prepared.svml`],`${id}-prepare-author`);
 await cp(join(directory,`${id}-prepared.svml`),join(directory,`${id}.svml`));
 await run(process.execPath,[cli,'review-candidate','--input',`${id}-request.json`,'--config','account-config.json','--graph',`${id}-api.json`,'--credential-sha256',credentialSha256,'--access-password-sha256',accessPasswordSha256,'--files',`${id}-review-files.json`,'--output',`${id}-candidate.json`],`${id}-prepare-review`);
 const candidate=JSON.parse(await readFile(join(directory,`${id}-candidate.json`)));assert.equal(candidate.record.humanReview.kind,'UNREVIEWED_OWNER_MUST_CHECK');
 const approved=JSON.parse(await readFile(join(directory,`state/reviews/${id}.json`)));assert.equal(candidate.record.requestDigest,approved.requestDigest);assert.deepEqual(candidate.record.fileDigests,approved.fileDigests);assert.deepEqual(JSON.parse(await readFile(join(directory,`${id}-api.json`))),graph);
 await writeFile(join(directory,`${id}.svrun`),'<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./'+id+'.svml"/><target output="'+id+'.result"/>'+(count===0?'':Array.from({length:5},(_,i)=>`<target output="${id}.file${i}"/>`).join(''))+'</svrun>\n');
 cases.push({id,count,graph,request,resultCount:count===0?0:count===35?25:5});
}
// The preload is a shipped proof fixture, never a development loader or SDK copy.
await cp(new URL('./installed-generic-mock-preload.mjs',import.meta.url),join(directory,'mock-preload.mjs'));
const metadataNode=(fieldName,fieldValue,fieldType='STRING',fieldData='')=>({nodeId:'input',nodeName:'Literal editable input',fieldName,fieldValue,fieldType,fieldData,description:'Fixture interface only',descriptionEn:'No hidden graph claim'});
for(const [index,id]of ['appmixed','appempty','appencrypted','appinvalid','appmoney'].entries()){
 const empty=id==='appempty';
 const metadata={webappName:`Mock-only ${id}`,accessEncrypted:id==='appencrypted',nodeInfoList:empty?[]:[
  ...['image','audio','video'].map(field=>metadataNode(field,'',field.toUpperCase())),
  metadataNode('mode','one','LIST','["one","two"]'),metadataNode('prompt','literal default','STRING','not a universal schema')]};
 const webappId=String(1937084629516193794n+BigInt(index));
 cases.push({id,kind:'ai-app',count:empty?0:3,metadata,request:{webappId},resultCount:empty?0:5,...(id==='appinvalid'?{failure:'invalid-review'}:id==='appmoney'?{failure:'money'}:{})});
}
await save('mock-cases.json',cases);
for(const c of cases.filter(item=>item.kind==='ai-app')){
 const fetchConfig={format:'hypit-runninghub.ai-app-fetch@1',baseUrl:config.baseUrl,webappId:c.request.webappId,apiKey:config.apiKey,requestTimeoutMs:config.http.requestTimeoutMs,maxResponseBytes:config.http.maxResponseBytes};
 await save(`${c.id}-fetch.json`,fetchConfig);
 await run(process.execPath,[cli,'fetch-app','--config',`${c.id}-fetch.json`,'--output',`${c.id}-document.json`],`${c.id}-fetch-id`,{mock:true});
 await save(`${c.id}-fetch-url.json`,{...fetchConfig,webappId:`https://www.runninghub.cn/ai-detail/${c.request.webappId}/?ignored=1#fragment`});
 await run(process.execPath,[cli,'fetch-app','--config',`${c.id}-fetch-url.json`,'--output',`${c.id}-url-document.json`],`${c.id}-fetch-url-report`,{mock:true});
 const app=JSON.parse(await readFile(join(directory,`${c.id}-document.json`))),viaUrl=JSON.parse(await readFile(join(directory,`${c.id}-url-document.json`)));
 assert.deepEqual(app,viaUrl);assert.equal(app.appDigest,viaUrl.appDigest);assert.deepEqual(app.nodeInfoList,c.metadata.nodeInfoList);
 assertPublicSafe(JSON.stringify(app));assert.ok(!Object.hasOwn(app,'curl'));
 const inspected=await run(process.execPath,[cli,'inspect-app','--input',`${c.id}-document.json`],`${c.id}-inspect-app`);
 assert.equal(inspected.webappId,c.request.webappId);assert.equal(inspected.webappName,c.metadata.webappName);assert.equal(inspected.accessEncrypted,c.metadata.accessEncrypted);assert.equal(inspected.appDigest,app.appDigest);assert.deepEqual(inspected.nodeInfoList,app.nodeInfoList);
 const values={files:[],bindings:c.count?['image','audio','video'].map(field=>({fileKey:field,nodeId:'input',fieldName:field})):[],nodeInfoList:c.count?[{nodeId:'input',fieldName:'prompt',fieldValue:{literal:[false,null,0],text:'<exact & uncoerced>'}}]:[],review:`reviews/${c.id}.json`,...(c.id==='appencrypted'?{instanceType:'ultra'}:{})};
 await save(`${c.id}-values.json`,values);
 await run(process.execPath,[cli,'request-from-app','--input',`${c.id}-document.json`,'--values',`${c.id}-values.json`,'--output',`${c.id}-request.json`],`${c.id}-prepare-request`);
 c.request=JSON.parse(await readFile(join(directory,`${c.id}-request.json`)));
 assert.equal(c.request.webappId,app.webappId);assert.deepEqual(c.request.bindings,values.bindings);assert.deepEqual(c.request.nodeInfoList,c.count?[{nodeId:'input',fieldName:'mode',fieldValue:'one'},values.nodeInfoList[0]]:[]);
 const files=types.slice(0,c.count).map((type,i)=>({key:['image','audio','video'][i],src:type.src,mediaType:type.mediaType}));
 const outputs=Array.from({length:c.resultCount},(_,index)=>({name:`file${index}`,index}));
 await save(`${c.id}-assets.json`,files);await save(`${c.id}-outputs.json`,outputs);
 await save(`${c.id}-review-files.json`,files.map(({src,...file})=>({...file,path:src})));
 await run(process.execPath,[cli,'author-from-request','--input',`${c.id}-request.json`,'--id',c.id,'--files',`${c.id}-assets.json`,'--outputs',`${c.id}-outputs.json`,'--output',`${c.id}.svml`],`${c.id}-prepare-author`);
 // Author drafts carry future File edges; review input must carry the actual file intent.
 await save(`${c.id}-review-request.json`,{...c.request,files:files.map((file,i)=>({key:file.key,blob:{kind:'blob',resource:`res_review_${i}`,mediaType:file.mediaType,size:types[i].bytes.length}}))});
 await run(process.execPath,[cli,'review-candidate','--input',`${c.id}-review-request.json`,'--config','account-config.json','--app',`${c.id}-document.json`,'--credential-sha256',credentialSha256,'--access-password-sha256',accessPasswordSha256,'--files',`${c.id}-review-files.json`,'--output',`${c.id}-candidate.json`],`${c.id}-prepare-review`);
 const candidate=JSON.parse(await readFile(join(directory,`${c.id}-candidate.json`)));
 assert.equal(candidate.reviewRequired,true);assert.equal(candidate.semanticValidation,'UNVERIFIED');assert.equal(candidate.record.humanReview.kind,'UNREVIEWED_OWNER_MUST_CHECK');assert.equal(candidate.record.expiresAt,null);assert.equal(candidate.record.appDigest,app.appDigest);
 // Explicit synthetic authority is confined to this isolated test project.
 const record={...candidate.record,humanReview:{kind:'project-owner-reviewed-membership-key-and-ai-app',recordId:'INERT-OFFLINE-FIXTURE',reviewer:'MOCK-ONLY',reviewedAt:new Date(Date.now()-10000).toISOString()},expiresAt:new Date(Date.now()+3600000).toISOString()};
 if(c.failure==='invalid-review')record.requestDigest='0'.repeat(64);
 await save(`state/reviews/${c.id}.json`,record);
 await writeFile(join(directory,`${c.id}.svrun`),'<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./'+c.id+'.svml"/><target output="'+c.id+'.result"/>'+outputs.map(output=>`<target output="${c.id}.${output.name}"/>`).join('')+'</svrun>\n');
}
await save('mock-cases.json',cases);
const common=['--runtime','./profile.json','--workspace','.','--json'],proofs=[];
const doctor=await run('hypit',['doctor',...common],'doctor',{mock:true});assert.equal(doctor.ok,true);
const readCalls=async()=>{try{return(await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return[];throw error;}};
const absent=async path=>{try{await lstat(path);return false;}catch(error){if(error.code==='ENOENT')return true;throw error;}};
const mediaTypes=['image/png','audio/wav','video/mp4','text/csv','application/octet-stream'];
for(const c of cases){
 const check=await run('hypit',['check',`./${c.id}.svml`,'--workspace','.','--json'],`${c.id}-check`,{mock:true});assert.equal(check.ok,true);
 const plan=await run('hypit',['plan',`./${c.id}.svrun`,...common],`${c.id}-plan`,{mock:true});assert.equal(plan.ok,true);assert.equal(plan.providerRequestCount,1);
 const capability=`@local/provider-runninghub@1#${c.kind==='ai-app'?'run-ai-app':'run-workflow'}`;
 assert.ok(plan.providers.some(provider=>provider.capability===capability&&provider.endpoint==='runninghub.account'&&provider.status==='resolved'),'Plan must select the nominal operation capability on the shared Endpoint');
 const pricing=await run('hypit',['pricing',`./${c.id}.svrun`,...common],`${c.id}-pricing`,{mock:true});assert.equal(pricing.groups.length,1);assert.equal(pricing.groups[0].status,'resolved');assert.equal(pricing.groups[0].capability,capability);assert.deepEqual(pricing.groups[0].pricing,{kind:'page',url:'https://www.runninghub.ai/enterprise-api/consumerApi'});
 const before=await readCalls();
 const build=await run('hypit',['build',`./${c.id}.svrun`,'--follow',...common],`${c.id}-build`,{mock:true,allowFailure:!!c.failure});
 const inspected=await run('hypit',['inspect',build.build.id,'--workspace','.','--verbose','--json'],`${c.id}-inspect`,{mock:true});
 if(c.failure){
  assert.equal(build.build.work.outcome,'failed');assert.equal(inspected.build.outcome,'failed');assert.equal(inspected.build.outputCount,0);
  const code=c.failure==='money'?'BILLING_MISMATCH':'MEMBER_BINDING_APP_MISMATCH';
  assert.ok((inspected.build.operations??[]).some(operation=>operation.failure?.code===code),`Missing failure ${code}`);
  const delta=(await readCalls()).slice(before.length);
  if(c.failure==='invalid-review')assert.equal(delta.filter(call=>['/task/openapi/upload','/task/openapi/create','/task/openapi/ai-app/run'].includes(call.path)||call.download).length,0);
  else{
   assert.ok(inspected.build.operations.some(operation=>operation.receipt?.id===`task-${c.id}`),'Money failure must preserve the remote task receipt');
   assert.equal(delta.filter(call=>call.path==='/task/openapi/ai-app/run').length,1);assert.equal(delta.filter(call=>call.download).length,0);
  }
  await run('hypit',['get',build.build.id,'--output',`${c.id}.result`,'--to',`./${c.id}-blocked-export`,'--workspace','.','--json'],`${c.id}-get-blocked`,{mock:true,allowFailure:true});
  assert.equal(await absent(join(directory,`${c.id}-blocked-export`)),true,'A failed operation must not export any result');
  proofs.push({kind:c.kind,webappId:c.request.webappId,check:true,plan:true,pricing:'source-page',build:build.build.id,outcome:'failed',failure:code,zeroEffects:c.failure==='invalid-review',receipt:c.failure==='money'?`task-${c.id}`:undefined,resultCount:0});continue;
 }
 assert.equal(build.build.work.outcome,'complete');assert.equal(build.build.result.state,'complete');assert.equal(inspected.build.outcome,'complete');
 await run('hypit',['get',build.build.id,'--output',`${c.id}.result`,'--to',`./${c.id}-result.json`,'--workspace','.','--json'],`${c.id}-get-result`,{mock:true});
 const document=JSON.parse(await readFile(join(directory,`${c.id}-result.json/value.json`))),result=document.value;
 assert.equal(result.format,'hypit-runninghub.result@1');assert.equal(result.outputs.length,c.resultCount);assert.equal(document.resources.length,result.outputs.length);assertPublicSafe(JSON.stringify(document));
 for(const[index,resource]of document.resources.entries()){const expected=[png,wav,mp4,csv,binary][index%5];assert.deepEqual(resource.at,['outputs',index,'blob']);assert.deepEqual(await readFile(join(directory,`${c.id}-result.json`,resource.file.path)),expected);assert.equal(resource.file.mediaType,mediaTypes[index%5]);assert.equal(resource.file.size,expected.length);assert.equal(result.outputs[index].outputType,['png','wav','mp4','csv','novel'][index%5]);}
 const exports=[];if(c.resultCount>0)for(const[i,item]of[png,wav,mp4,csv,binary].entries()){await run('hypit',['get',build.build.id,'--output',`${c.id}.file${i}`,'--to',`./${c.id}-file${i}`,'--workspace','.','--json'],`${c.id}-get-${i}`,{mock:true});const bytes=await readFile(join(directory,`${c.id}-file${i}`));assert.deepEqual(bytes,item);exports.push({index:i,bytes:bytes.length,sha256:hash(bytes),mediaType:document.resources[i].file.mediaType});}
 proofs.push({kind:c.kind??'workflow',fileCount:c.count,workflowId:c.request.workflowId,webappId:c.request.webappId,instanceType:c.request.instanceType,encrypted:c.metadata?.accessEncrypted,source:c.kind==='ai-app'?'fetched-interface':c.count===0?'saved-id':'inline-json',check:true,plan:true,pricing:'source-page',build:build.build.id,outcome:build.build.work.outcome,resultCount:result.outputs.length,exports});
}
const calls=await readCalls(),workflowSubmits=calls.filter(c=>c.path==='/task/openapi/create'),appSubmits=calls.filter(c=>c.path==='/task/openapi/ai-app/run'),uploads=calls.filter(c=>c.path==='/task/openapi/upload');
assert.equal(workflowSubmits.length,counts.length);assert.equal(uploads.length,cases.filter(c=>c.failure!=='invalid-review').reduce((total,c)=>total+c.count,0));assert.equal(appSubmits.length,cases.filter(c=>c.kind==='ai-app'&&c.failure!=='invalid-review').length);
assert.ok(workflowSubmits.some(c=>c.fixture==='demo12'&&c.instanceType==='plus'&&c.passwordSent));assert.ok(appSubmits.some(c=>c.fixture==='appencrypted'&&c.instanceType==='ultra'&&c.passwordSent));assert.ok(appSubmits.filter(c=>c.fixture!=='appencrypted').every(c=>!c.passwordSent));
for(const c of cases.filter(c=>c.kind==='ai-app'))assert.ok(calls.filter(call=>call.path==='/api/webapp/apiCallDemo'&&call.fixture===c.id&&call.webappId===c.request.webappId).length>=2);
assert.equal((await lstat(provider)).isSymbolicLink(),false);assert.ok(!(await readdir(join(directory,'node_modules'))).includes('@hypit'));
await run('hypit',['runtime','down',...common],'runtime-down',{mock:true});
// Scan public repository files, including saved execution reports; private
// native observations live under state and are intentionally not public.
async function scanPublic(path){for(const entry of await readdir(path,{withFileTypes:true})){const file=join(path,entry.name);if(entry.isDirectory())await scanPublic(file);else if(entry.isFile())assertPublicSafe((await readFile(file)).toString('utf8'));}}
await scanPublic(join(directory,'.hypit'));
for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isFile()&&['.json','.svml','.svrun','.stderr'].some(extension=>entry.name.endsWith(extension)))assertPublicSafe(await readFile(join(directory,entry.name),'utf8'));
const report={format:'hypit-runninghub.installed-v004-proof@1',directory,archive,archiveSha256:hash(await readFile(archive)),doctor:doctor.ok,cases:proofs,uploadCount:uploads.length,createCount:workflowSubmits.length,appSubmitCount:appSubmits.length,sdkTestLoader:false,sdkCopiedOrInstalledLocally:false,liveCalls:0,realCredentials:false,limitations:['All service IO intercepted with explicit isolated synthetic owner authority; valid local media fixtures, no live credentials, paid generation or RunningHub backend availability claim.','App interface identity, installed ABI, transport and exact exported bytes are checked; hidden app implementation, real account access, generation quality and actual billing are not verified.','Doctor verifies configuration, pricing resolves a source page without a numeric quote.']};assertPublicSafe(JSON.stringify(report));await save('proof.json',report);console.log(JSON.stringify(report,null,2));
