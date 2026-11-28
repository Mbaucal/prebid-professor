/** Static original-build check plus the official builder's data-only import.
 * Usage: node scripts/verify-prebid-builder-roundtrip.mjs download-source.js prebid.js
 * No auction, external fetch, hosted session or user database access.
 */
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {workspaceStore} from '../tests/support/test-workspace-store.mjs';
import {initializeTestSchema} from '../worker/test-workspace/schema.mjs';
import {readRuntimeSelectionSettings,saveRuntimeSelectionSettings,selectedWorkspaceRuntime} from '../worker/test-workspace/runtime-selection.mjs';
import {getPrebidSettings,previewBuildPlan,savePrebidSettings,prebidStore} from '../worker/test-workspace/prebid-settings.mjs';
import {storePrebidFile,inspectUpload} from '../worker/test-workspace/prebid-files.mjs';
import {readPreviewSnapshot} from '../worker/runtime/builtin-preview-service.mjs';
import {buildArtifactCandidate} from '../worker/runtime/artifact-candidate.mjs';
const [sourcePath,filePath]=process.argv.slice(2);
if(!sourcePath||!filePath)throw Error('Supply the original official download.js and returned prebid.js paths.');
const source=readFileSync(sourcePath,'utf8'),original=new Uint8Array(readFileSync(filePath)),header=await inspectUpload(original);
const f=workspaceStore({prebidFiles:true}),actor='tester@example.invalid';
globalThis.fetch=()=>assert.fail('No network inside static round-trip');
try{
  await initializeTestSchema(f.env.DB,actor);
  const runtime=await readRuntimeSelectionSettings(f.env);
  await saveRuntimeSelectionSettings(f.env,actor,{expectedRevision:runtime.revision,selection:{runtime:runtime.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
  const state=await getPrebidSettings(f.env),request={expectedRevision:state.revision,version:header.version,options:state.options,draft:{...state.draft,enablePrebid:true,bidders:[{bidder:'openx',enabled:true,params:{unit:'fixture',delDomain:'example.invalid'}}]}};
  const plan=await previewBuildPlan(f.env,request);
  const declarations=[];
  function visit(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration'&&['applyConfig','get_form_data'].includes(node.id.name))declarations.push(source.slice(node.start,node.end));for(const item of Object.values(node))if(Array.isArray(item))item.forEach(visit);else if(item&&typeof item==='object')visit(item);}
  visit(parse(source,{ecmaVersion:'latest'}));assert.equal(declarations.length,2);
  const boxes=[...plan.configuration.modules,'unwantedModule'].map(id=>({id,checked:true,getAttribute(key){return key==='moduleCode'?id:null;}}));
  const option={selected:false},searchParams=new URLSearchParams();
  const context={document:{querySelector(selector){return selector==='#version_selector option[value="'+header.version+'"]'?option:null;},querySelectorAll(selector){return selector==='.module-check-box'?boxes:boxes.filter(b=>b.checked);},getElementById(id){return boxes.find(b=>b.id===id);}},
    window:{location:{pathname:'/download.html'},history:{replaceState(){}}},searchParams,
    $:()=>({val:()=>option.selected?header.version:'wrong-version'}),renameModules:(_version,modules)=>modules};
  vm.createContext(context);vm.runInContext(declarations.join('\n')+'\nthis.applyConfig=applyConfig;this.get_form_data=get_form_data;',context,{timeout:1000});
  context.cfg=JSON.parse(JSON.stringify(plan.configuration));vm.runInContext('applyConfig(cfg);this.form=get_form_data();',context,{timeout:1000});
  const form=JSON.parse(JSON.stringify(context.form));assert.deepEqual(form,{version:header.version,modules:plan.configuration.modules,removedModules:[]});
  assert.equal(option.selected,true);assert.equal(boxes.at(-1).checked,false);
  assert.deepEqual(header.modules,plan.configuration.modules);
  request.draft.buildId=(await storePrebidFile(prebidStore(f.env),original,actor)).file.id;
  await savePrebidSettings(f.env,actor,{...request,acknowledge:true});
  const snapshot=await readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true}),resolved=await selectedWorkspaceRuntime(snapshot,f.env.BUILDS),{prebidBuilds,...settings}=snapshot;
  const candidate=await buildArtifactCandidate({snapshot:settings,pin:resolved.pin,buildTimestamp:'20260913_220000',takeOver:{enabled:false},prebid:resolved.prebid});
  assert.deepEqual(candidate.files['prebid.js'],original);assert.equal(Object.keys(candidate.files).length,10);
  const report={scope:'Official data-only import function + real returned Prebid file + local SQLite/fake R2 generation; no JS auction or hosted session',configuration:plan.configuration,source:'https://github.com/prebid/prebid.github.io/blob/master/assets/js/download.js',sourceSha256:createHash('sha256').update(source).digest('hex'),prebidSha256:header.sha256,prebidByteSize:header.byteSize,fileCount:10,exactBytesPreserved:true,passed:true};
  mkdirSync('.generated/prebid-config-evidence',{recursive:true});writeFileSync('.generated/prebid-config-evidence/official-roundtrip.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{f.close();}
