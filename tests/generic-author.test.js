import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importWorkflowDocument, importWorkflowFile, editWorkflowDocument, validateWorkflowDocument, requestFromDocument, writeNewWorkflowFile } from '../generic/document.js';
import { renderWorkflowAuthor } from '../generic/author-source.js';
import { createWorkflowInputFragment, decodeWorkflowSurface, workflowAuthorContribution } from '../generic/author.js';
import { requestDigest } from '../generic/request.js';
const graph={ A:{class_type:'CustomNeverRegistered',inputs:{list:[1,2,{a:false}],object:{x:null}}},B:{class_type:'AnotherCustom',inputs:{}} };
const draft={format:'hypit-runninghub.request@1',workflowId:'explicit-service-id',workflowJson:JSON.stringify(graph),nodeInfoList:[],files:[],bindings:[],review:'reviews/owner.json'};
const range={source:'fixture',start:0,end:1};
const text=value=>({kind:'text',value,range});
const element=(name,attributes={},children=[])=>({kind:'element',name,attributes,children,range});
test('API import preserves original bytes and arbitrary literals, full digest and immutable edit chain',async t=>{
 const root=await mkdtemp(join(tmpdir(),'rh-generic-doc-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=JSON.stringify(graph,null,3)+'\n';const input=join(root,'original.json');await writeFile(input,source);
 const doc=await importWorkflowFile(input);assert.equal(doc.sourceText,source);assert.equal(doc.executionReady,true);assert.deepEqual(doc.graph,graph);
 const next=editWorkflowDocument(doc,[{op:'setInput',nodeId:'A',fieldName:'new',value:[false,null,0,{nested:['x']}]},{op:'connect',nodeId:'B',fieldName:'input',source:'A',outputIndex:123}],doc.revisionDigest);
 assert.equal(next.parentDigest,doc.revisionDigest);assert.equal(next.sourceText,source);assert.deepEqual(next.graph.A.inputs.new,[false,null,0,{nested:['x']}]);assert.deepEqual(next.graph.B.inputs.input,['A',123]);assert.equal(await readFile(input,'utf8'),source);
 assert.throws(()=>editWorkflowDocument(next,[{op:'remove',nodeId:'A'}],doc.revisionDigest),{code:'REVISION_CONFLICT'});assert.throws(()=>editWorkflowDocument(next,[{op:'setInput',nodeId:'A',fieldName:'__proto__',value:{}}],next.revisionDigest));
 await writeNewWorkflowFile(join(root,'revision.json'),next);await assert.rejects(writeNewWorkflowFile(input,next),{code:'EEXIST'});
 const request=requestFromDocument(next,{workflowId:'caller-provided-id'});assert.equal(request.workflowId,'caller-provided-id');assert.deepEqual(JSON.parse(request.workflowJson),next.graph);assert.equal(request.review,undefined);
 const bad=structuredClone(next);bad.graph.A.inputs.list=[9];assert.throws(()=>validateWorkflowDocument(bad),{code:'REVISION_DIGEST_MISMATCH'});
});
test('UI JSON is retained immutable and cannot execute without verified conversion/API export',()=>{
 const source=JSON.stringify({nodes:[{id:1,type:'Custom',widgets_values:[1,'unknown-positional']}],links:[]});const doc=importWorkflowDocument(source);assert.equal(doc.sourceFormat,'comfyui-ui');assert.equal(doc.executionReady,false);assert.equal(doc.sourceText,source);assert.throws(()=>requestFromDocument(doc,{workflowId:'caller-id'}),{code:'API_EXPORT_REQUIRED'});assert.throws(()=>editWorkflowDocument(doc,[{op:'remove',nodeId:'1'}],doc.revisionDigest),{code:'API_EXPORT_REQUIRED'});
});
test('generic node add/replace/remove and disconnect preserve unrelated literal arrays',()=>{
 const doc=importWorkflowDocument(JSON.stringify(graph));const next=editWorkflowDocument(doc,[{op:'add',nodeId:'C',node:{class_type:'New',inputs:{}}},{op:'replace',nodeId:'B',node:{class_type:'Replacement',inputs:{x:['A',0]}}},{op:'disconnect',nodeId:'B',fieldName:'x',value:{literal:[1,2]}},{op:'remove',nodeId:'C'}],doc.revisionDigest);
 assert.deepEqual(next.graph.A.inputs.list,graph.A.inputs.list);assert.deepEqual(next.graph.B.inputs.x,{literal:[1,2]});assert.equal(next.graph.C,undefined);
});
test('review request digest ignores ephemeral ResourceStore identity but pins file intent/order/value',()=>{
 const blob={kind:'blob',resource:'res_A',size:8,mediaType:'image/png'};const request={...draft,files:[{key:'arbitrary key 🖼',blob}]};const changed=structuredClone(request);changed.files[0].blob.resource='res_B';assert.equal(requestDigest(request),requestDigest(changed));
 for(const field of ['mediaType','size']){const bad=structuredClone(changed);bad.files[0].blob[field]=field==='size'?9:'image/jpeg';assert.notEqual(requestDigest(request),requestDigest(bad));}
 const bad=structuredClone(request);bad.files[0].key='other';assert.notEqual(requestDigest(request),requestDigest(bad));bad.files[0].key=request.files[0].key;bad.nodeInfoList=[{nodeId:'A',fieldName:'new',fieldValue:false}];assert.notEqual(requestDigest(request),requestDigest(bad));
});
test('dynamic public Fragment supports zero/many file edges and arbitrary Blob projections',()=>{
 for(const n of [0,1,3,12,35]){const fragment=createWorkflowInputFragment(Array.from({length:n},()=>({name:'result'})),[{name:'csv',index:0},{name:'video',index:1}]);assert.equal(fragment.inputs.filter(input=>input.type.name==='BlobArtifact').length,n);assert.equal(fragment.exports.length,3);}
 assert.ok(workflowAuthorContribution.hostFacets.length);assert.throws(()=>createWorkflowInputFragment([],[{name:'result'}]));
});
test('Surface preserves repeated file order and arbitrary keys, attaches actual Blob edges',async()=>{
 const request={...draft,bindings:[{fileKey:'result',nodeId:'A',fieldName:'first'},{fileKey:'arbitrary key 🖼',nodeId:'A',fieldName:'second'}]};
 const decoded=await decodeWorkflowSurface({element:element('Workflow',{id:'task'},[element('Request',{},[text(JSON.stringify(request))]),element('File',{key:'result',source:{kind:'reference',path:'upstream'}}),element('File',{key:'arbitrary key 🖼',src:'./local.png','media-type':'image/png'}),element('Output',{name:'file',index:'0'})]),resolveReference:()=>({type:{module:{name:'@hypit/artifact',version:'1'},name:'BlobArtifact'},ref:{kind:'record',id:'upstream-record'}}),resolveAsset:async()=>({artifact:{kind:'blob',resource:'res_local',size:8,mediaType:'image/png'}})});
 assert.equal(decoded.components[0].inputs.file0.id,'upstream-record');assert.ok(decoded.records.find(record=>record.value.kind==='inline'&&record.value.value==='arbitrary key 🖼'));assert.equal(decoded.components[0].outputs.file,'task.file');assert.equal(decoded.components[0].outputs.result,'task.result');
});
test('author generator keeps literal JSON and arbitrary file keys, explicit outputs and XML escapes',()=>{
 const request={...draft,bindings:[{fileKey:'key & 🖼',nodeId:'A',fieldName:'new'}]};const source=renderWorkflowAuthor(request,{id:'demo',files:[{key:'key & 🖼',src:'./a & b.png',mediaType:'image/png'}],outputs:[{name:'first',index:0}]});assert.ok(source.includes('key &amp; 🖼'));assert.ok(source.includes('a &amp; b.png'));assert.ok(source.includes('name="first" index="0"'));assert.ok(!source.includes('prompt='));
});
test('review-candidate helper produces unreviewed record and matches runtime semantic digest',async t=>{
 const {prepareWorkflowReviewCandidate}=await import('../generic/review-candidate.js');const root=await mkdtemp(join(tmpdir(),'rh-review-candidate-'));t.after(()=>rm(root,{recursive:true,force:true}));const png=Buffer.from([137,80,78,71,13,10,26,10]);const path=join(root,'image.png');await writeFile(path,png);
 const config=JSON.parse(await readFile(new URL('../examples/generic-config.json',import.meta.url)));const request={...draft,bindings:[{fileKey:'result',nodeId:'A',fieldName:'new'}]};
 const candidate=await prepareWorkflowReviewCandidate({config,request,credentialSha256:'a'.repeat(64),files:[{key:'result',path,mediaType:'image/png'}]});assert.equal(candidate.reviewRequired,true);assert.equal(candidate.record.humanReview.kind,'UNREVIEWED_OWNER_MUST_CHECK');assert.equal(candidate.record.expiresAt,null);
 const actual={...request,files:[{key:'result',blob:{kind:'blob',resource:'res_actual_runtime',size:png.length,mediaType:'image/png'}}]};assert.equal(candidate.record.requestDigest,requestDigest(actual));assert.equal(candidate.record.fileDigests.length,1);
});
test('internal Surface record IDs cannot collide with arbitrary projected public output names',async()=>{
 const decoded=await decodeWorkflowSurface({element:element('Workflow',{id:'task'},[element('Request',{},[text(JSON.stringify(draft))]),element('Output',{name:'__rh.draft',index:'0'})]),resolveReference:()=>undefined,resolveAsset:async()=>{throw Error('unexpected');}});
 const publicId=decoded.components[0].outputs['__rh.draft'];assert.ok(!decoded.records.some(record=>record.id===publicId));
});
test('copyable pure Node CLI guide pipeline prepares future File bindings without SDK',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');const root=await mkdtemp(join(tmpdir(),'rh-guide-cli-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const cli=new URL('../bin/rh-workflow.js',import.meta.url).pathname;const input=join(root,'api.json'),doc=join(root,'document.json'),values=join(root,'values.json'),request=join(root,'request.json'),assets=join(root,'assets.json'),reviewFiles=join(root,'review-files.json'),author=join(root,'author.svml'),candidate=join(root,'candidate.json');
 const source=JSON.stringify(graph);await writeFile(input,source);await writeFile(values,JSON.stringify({files:[],bindings:[{fileKey:'portrait',nodeId:'A',fieldName:'newFile'}],review:'reviews/owner.json'}));
 const png=Buffer.from([137,80,78,71,13,10,26,10]),image=join(root,'image.png');await writeFile(image,png);await writeFile(assets,JSON.stringify([{key:'portrait',src:image,mediaType:'image/png'}]));await writeFile(reviewFiles,JSON.stringify([{key:'portrait',path:image,mediaType:'image/png'}]));
 const run=args=>promisify(execFile)(process.execPath,[cli,...args],{cwd:root,env:{...process.env,NODE_OPTIONS:''}});
 await run(['import-native','--input',input,'--output',doc]);await run(['request-from-document','--input',doc,'--workflow-id','explicit-owner-id','--values',values,'--output',request]);
 await run(['author-from-request','--input',request,'--files',assets,'--output',author]);await run(['review-candidate','--input',request,'--config',new URL('../examples/generic-config.json',import.meta.url).pathname,'--credential-sha256','a'.repeat(64),'--files',reviewFiles,'--output',candidate]);
 assert.equal(JSON.parse(await readFile(request)).bindings[0].fileKey,'portrait');assert.ok((await readFile(author,'utf8')).includes('<File key="portrait"'));assert.equal(JSON.parse(await readFile(candidate)).record.humanReview.kind,'UNREVIEWED_OWNER_MUST_CHECK');assert.equal(await readFile(input,'utf8'),source);
 await writeFile(values,JSON.stringify({duration:3}));await assert.rejects(run(['request-from-document','--input',doc,'--workflow-id','explicit-owner-id','--values',values,'--output',join(root,'bad.json')]));
});
