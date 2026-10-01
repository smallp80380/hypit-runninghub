// FREE normal installed Hypit proof; all service IO intercepted, /tmp only.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,writeFile,cp,lstat,readdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const archive=resolve(process.argv[2]??'artifacts/local-provider-runninghub-0.0.4.tgz');
const directory=await mkdtemp(join(tmpdir(),'hypit-rh-v004-proof-'));
const quote=value=>"'"+value.replaceAll("'","'\"'\"'")+"'";
async function run(command,args,name,{mock=false}={}){
 const out=join(directory,name+'.json'),err=join(directory,name+'.stderr');
 const parts=mock?['env',`NODE_OPTIONS=--import=${join(directory,'mock-preload.mjs')}`,command,...args]:[command,...args];
 try{await promisify(execFile)('/bin/sh',['-c',parts.map(quote).join(' ')+` >${quote(out)} 2>${quote(err)}`],{cwd:directory,timeout:120000});}
 catch(error){throw Error(`${name}: ${error.message}\n${await readFile(err,'utf8')}\n${await readFile(out,'utf8')}`);}
 const text=await readFile(out,'utf8');return text?JSON.parse(text):undefined;
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
const config=JSON.parse(await readFile(join(provider,'examples/generic-config.json')));config.apiKey={store:'env',key:'INERT_GENERIC_MEMBER_KEY'};config.keyType='Consumer-Member';config.submissionEnabled=true;config.http.allowedDownloadHosts=['cdn.example.invalid'];config.polling.intervalMs=10;
const secret='offline-v004-fixture-not-real';
await save('profile.json',{format:'hypit.runtime-local@1',dataRoot:'./state',credentials:{env:{use:'@hypit/credential-store-env',config:{}}},endpoints:{'runninghub.account':{use:'@local/provider-runninghub',config}},bindings:{'@local/provider-runninghub@1#run-workflow':'runninghub.account'}});
const counts=[0,1,3,12,35],cases=[];
for(const [caseIndex,count]of counts.entries()){
 const id=`demo${count}`,node=`custom${caseIndex}`,graph={[node]:{class_type:`NeverRegisteredClass${caseIndex}`,inputs:{literal:[false,null,0,{nested:['x','y']}],staticObject:{a:0}}}};
 const request={format:'hypit-runninghub.request@1',workflowId:`unseen-native-workflow-${count}`,...(count===0?{}:{workflowJson:JSON.stringify(graph)}),nodeInfoList:[{nodeId:node,fieldName:'optionalNew',fieldValue:{list:[false,null,0],text:'<inert & exact>'}}],files:[],bindings:Array.from({length:count},(_,i)=>({fileKey:i===0?'result':`arbitrary key ${i} 🖼`,nodeId:node,fieldName:`file${i}`})),review:`reviews/${id}.json`};
 const fileMetadata=Array.from({length:count},(_,i)=>({key:request.bindings[i].fileKey,mediaType:types[i%types.length].mediaType,size:types[i%types.length].bytes.length}));
 const {review,...content}=request;
 await save(`state/reviews/${id}.json`,{format:'REVIEWED_WORKFLOW_OPERATION@1',credential:{reference:config.apiKey,sha256:hash(secret)},baseUrl:config.baseUrl,requestDigest:hash(sorted({...content,files:fileMetadata})),graphDigest:hash(sorted(graph)),fileDigests:fileMetadata.map((file,i)=>({key:file.key,sha256:hash(types[i%types.length].bytes)})),scope:'reviewed-native-only-no-external-money',source:{url:'https://www.runninghub.ai/enterprise-api/consumerApi',noteSha256:'becf0e9cb51ceee2460b77ebeddc394343e7e982f9fdbb029a3e6e4055386097'},humanReview:{kind:'project-owner-reviewed-membership-key-and-native-workflow',recordId:'INERT-OFFLINE-FIXTURE',reviewer:'MOCK-ONLY',reviewedAt:new Date(Date.now()-10000).toISOString()},expiresAt:new Date(Date.now()+3600000).toISOString()});
 const author='<?svml using="@hypit/markup@1"?>\n<svml>\n<import as="workflow" from="@local/provider-runninghub@1"/>\n'+`<workflow:Workflow id="${id}"><Request>${xml(JSON.stringify(request))}</Request>`+fileMetadata.map((file,i)=>`<File key="${xml(file.key)}" src="${types[i%types.length].src}" media-type="${file.mediaType}"/>`).join('')+(count===0?'':Array.from({length:5},(_,i)=>`<Output name="file${i}" index="${i}"/>`).join(''))+'</workflow:Workflow>\n</svml>\n';
 await writeFile(join(directory,`${id}.svml`),author);
 // Exercise the shipped pure Node import/request/author/review pipeline. It
 // carries future File edges without loading Hypit's development test loader.
 await save(`${id}-values.json`,{nodeInfoList:request.nodeInfoList,files:[],bindings:request.bindings,review:request.review});
 await save(`${id}-assets.json`,fileMetadata.map((file,i)=>({key:file.key,src:types[i%types.length].src,mediaType:file.mediaType})));
 await save(`${id}-review-files.json`,fileMetadata.map((file,i)=>({key:file.key,path:types[i%types.length].src,mediaType:file.mediaType})));
 await save(`${id}-outputs.json`,count===0?[]:Array.from({length:5},(_,i)=>({name:`file${i}`,index:i})));
 await save(`${id}-api.json`,graph);await save('account-config.json',config);
 const cli=join(provider,'bin/rh-workflow.js');
 await run(process.execPath,[cli,'import-native','--input',`${id}-api.json`,'--output',`${id}-document.json`],`${id}-import`);
 if(count>0){await run(process.execPath,[cli,'request-from-document','--input',`${id}-document.json`,'--workflow-id',request.workflowId,'--values',`${id}-values.json`,'--output',`${id}-request.json`],`${id}-prepare-request`);}
 else await save(`${id}-request.json`,request);
 // Replace only this new synthetic Source file; originals imported above are
 // independently checked for exact preservation.
 await run(process.execPath,[cli,'author-from-request','--input',`${id}-request.json`,'--id',id,'--files',`${id}-assets.json`,'--outputs',`${id}-outputs.json`,'--output',`${id}-prepared.svml`],`${id}-prepare-author`);
 await cp(join(directory,`${id}-prepared.svml`),join(directory,`${id}.svml`));
 await run(process.execPath,[cli,'review-candidate','--input',`${id}-request.json`,'--config','account-config.json','--graph',`${id}-api.json`,'--credential-sha256',hash(secret),'--files',`${id}-review-files.json`,'--output',`${id}-candidate.json`],`${id}-prepare-review`);
 const candidate=JSON.parse(await readFile(join(directory,`${id}-candidate.json`)));assert.equal(candidate.record.humanReview.kind,'UNREVIEWED_OWNER_MUST_CHECK');
 const approved=JSON.parse(await readFile(join(directory,`state/reviews/${id}.json`)));assert.equal(candidate.record.requestDigest,approved.requestDigest);assert.deepEqual(candidate.record.fileDigests,approved.fileDigests);assert.deepEqual(JSON.parse(await readFile(join(directory,`${id}-api.json`))),graph);
 await writeFile(join(directory,`${id}.svrun`),'<?svml using="@hypit/run-markup@1"?>\n<svrun version="1"><author source="./'+id+'.svml"/><target output="'+id+'.result"/>'+(count===0?'':Array.from({length:5},(_,i)=>`<target output="${id}.file${i}"/>`).join(''))+'</svrun>\n');
 cases.push({id,count,graph,request});
}
await save('mock-cases.json',cases);
await writeFile(join(directory,'mock-preload.mjs'),`import{readFileSync,appendFileSync}from'node:fs';\nconst root=${JSON.stringify(directory)},cases=JSON.parse(readFileSync(root+'/mock-cases.json'));process.env.INERT_GENERIC_MEMBER_KEY=${JSON.stringify(secret)};const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});globalThis.fetch=async(input,init={})=>{const url=new URL(typeof input==='string'?input:input.url);appendFileSync(root+'/calls.jsonl',JSON.stringify({path:url.pathname,method:init.method??'GET'})+'\\n');if(url.hostname==='cdn.example.invalid'){if(init.headers)throw Error('CREDENTIAL_FORWARDING');const i=Number(url.pathname.split('/').at(-1))%5;const f=[['image.png','image/png'],['audio.wav','audio/wav'],['video.mp4','video/mp4'],['data.csv','text/csv'],['data.bin','application/octet-stream']][i];return new Response(readFileSync(root+'/assets/'+f[0]),{headers:{'content-type':f[1]}});}if(url.origin!=='https://www.runninghub.ai')throw Error('UNEXPECTED_ORIGIN');if(url.pathname==='/enterprise-api/consumerApi')return new Response('Offline fixture price page, no live quote');if(url.pathname==='/uc/openapi/accountStatus')return json({code:0,data:{apiType:'NORMAL',remainCoins:'1000'}});if(url.pathname==='/api/openapi/getJsonApiFormat'){const body=JSON.parse(init.body),c=cases.find(c=>c.request.workflowId===body.workflowId);return json({code:0,data:{prompt:JSON.stringify(c.graph)}});}if(url.pathname==='/task/openapi/upload'){const file=init.body.get('file');appendFileSync(root+'/uploads.jsonl',JSON.stringify({name:file.name,type:file.type,size:file.size})+'\\n');return json({code:0,data:{fileName:'api/exact-'+file.name,fileType:'input'}});}if(url.pathname==='/task/openapi/create'){const body=JSON.parse(init.body),c=cases.find(c=>c.request.workflowId===body.workflowId);if(!c)throw Error('UNKNOWN_FIXTURE');if(body.nodeInfoList.length!==1+c.count)throw Error('MISSING_BINDINGS');if(body.workflow){const graph=JSON.parse(body.workflow);for(const m of body.nodeInfoList)if(JSON.stringify(graph[m.nodeId].inputs[m.fieldName])!==JSON.stringify(m.fieldValue))throw Error('MAPPING_DIVERGENCE');}appendFileSync(root+'/wire.jsonl',JSON.stringify({...body,apiKey:'[fixture-redacted]'})+'\\n');return json({code:0,data:{taskId:'task-'+c.id}});}if(url.pathname==='/openapi/v2/query'){const body=JSON.parse(init.body),c=cases.find(c=>'task-'+c.id===body.taskId),count=c.count===0?0:c.count===35?25:5;return json({taskId:body.taskId,status:'SUCCESS',results:Array.from({length:count},(_,i)=>({url:'https://cdn.example.invalid/'+c.id+'/'+i+'?private=signed',outputType:['png','wav','mp4','csv','novel'][i%5],index:i})),usage:{consumeCoins:'1',consumeMoney:null,thirdPartyConsumeMoney:null,taskCostTime:'1'}});}throw Error('UNEXPECTED_PATH');};\n`);
const common=['--runtime','./profile.json','--workspace','.','--json'],proofs=[];
const doctor=await run('hypit',['doctor',...common],'doctor',{mock:true});assert.equal(doctor.ok,true);
for(const c of cases){
 const check=await run('hypit',['check',`./${c.id}.svml`,'--workspace','.','--json'],`${c.id}-check`,{mock:true});assert.equal(check.ok,true);
 const plan=await run('hypit',['plan',`./${c.id}.svrun`,...common],`${c.id}-plan`,{mock:true});assert.equal(plan.ok,true);assert.equal(plan.providerRequestCount,1);
 const pricing=await run('hypit',['pricing',`./${c.id}.svrun`,...common],`${c.id}-pricing`,{mock:true});assert.equal(pricing.groups.length,1);assert.equal(pricing.groups[0].status,'resolved');
 const build=await run('hypit',['build',`./${c.id}.svrun`,'--follow',...common],`${c.id}-build`,{mock:true});assert.equal(build.build.work.outcome,'complete');assert.equal(build.build.result.state,'complete');
 await run('hypit',['inspect',build.build.id,'--workspace','.','--verbose','--json'],`${c.id}-inspect`,{mock:true});
 await run('hypit',['get',build.build.id,'--output',`${c.id}.result`,'--to',`./${c.id}-result.json`,'--workspace','.','--json'],`${c.id}-get-result`,{mock:true});
 const document=JSON.parse(await readFile(join(directory,`${c.id}-result.json/value.json`))),result=document.value;
 assert.equal(result.outputs.length,c.count===0?0:c.count===35?25:5);assert.equal(document.resources.length,result.outputs.length);assert.ok(!JSON.stringify(result).includes('signed'));assert.ok(!JSON.stringify(result).includes(secret));
 for(const[index,resource]of document.resources.entries()){const expected=[png,wav,mp4,csv,binary][index%5];assert.deepEqual(await readFile(join(directory,`${c.id}-result.json`,resource.file.path)),expected);}
 const exports=[];if(c.count>0)for(const[i,item]of[png,wav,mp4,csv,binary].entries()){await run('hypit',['get',build.build.id,'--output',`${c.id}.file${i}`,'--to',`./${c.id}-file${i}`,'--workspace','.','--json'],`${c.id}-get-${i}`,{mock:true});const bytes=await readFile(join(directory,`${c.id}-file${i}`));assert.deepEqual(bytes,item);exports.push({index:i,bytes:bytes.length,sha256:hash(bytes),mediaType:document.resources[i].file.mediaType});}
 proofs.push({fileCount:c.count,workflowId:c.request.workflowId,source:c.count===0?'saved-id':'inline-json',check:true,plan:true,pricing:true,build:build.build.id,outcome:build.build.work.outcome,resultCount:result.outputs.length,exports});
}
const calls=(await readFile(join(directory,'calls.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.path==='/task/openapi/create').length,5);assert.equal(calls.filter(c=>c.path==='/task/openapi/upload').length,51);
assert.equal((await lstat(provider)).isSymbolicLink(),false);assert.ok(!(await readdir(join(directory,'node_modules'))).includes('@hypit'));
await run('hypit',['runtime','down',...common],'runtime-down',{mock:true});
const report={format:'hypit-runninghub.installed-v004-proof@1',directory,archive,archiveSha256:hash(await readFile(archive)),doctor:doctor.ok,cases:proofs,uploadCount:51,createCount:5,sdkTestLoader:false,sdkCopiedOrInstalledLocally:false,liveCalls:0,realCredentials:false,limitations:['All service IO intercepted with isolated synthetic authority; valid local media fixtures, no RunningHub generation/backend availability claim.','Doctor verifies configuration, pricing resolves a source page without a numeric quote.']};await save('proof.json',report);console.log(JSON.stringify(report,null,2));
