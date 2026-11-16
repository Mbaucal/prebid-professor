// The TEST site with Prebid turned on through the TEST Prebid editor, as an operator does it: one
// synthetic bidder and an inert Prebid file whose header names the planned modules. Local only.
import {getPrebidSettings,previewBuildPlan,savePrebidSettings,prebidStore} from '../../worker/test-workspace/prebid-settings.mjs';
import {storePrebidFile} from '../../worker/test-workspace/prebid-files.mjs';
import {TEST_EMAIL} from './test-workspace-store.mjs';
/** req(path, body) sends GET without a body and POST with one, and resolves to {status, data}. */
export async function selectTestRuntime(req,version,enablePrebid){
 const state=(await req('/test-api/runtime-selection')).data;
 const runtime=state.runtimes.find(item=>item.version===version);if(!runtime)throw Error(version+' must be selectable');
 const saved=await req('/test-api/runtime-selection',{expectedRevision:state.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid,prebidBuildId:enablePrebid?state.prebidBuildId:null}});
 if(saved.status!==200)throw Error(JSON.stringify(saved.data));
}
export async function enableTestPrebid(env,req){
 await selectTestRuntime(req,'3.23.0',false);
 const settings=await getPrebidSettings(env);
 const request={expectedRevision:settings.revision,version:'11.34.0',options:settings.options,draft:{...settings.draft,enablePrebid:true,bidders:[{bidder:'openx',enabled:true,params:{unit:'synthetic-unit',delDomain:'synthetic.example.invalid'}}]}};
 const plan=await previewBuildPlan(env,request);
 const file=new TextEncoder().encode(`/* prebid.js v${plan.configuration.version}\nModules: ${plan.configuration.modules.join(', ')} */\n// inert fixture\n`);
 request.draft.buildId=(await storePrebidFile(prebidStore(env),file,TEST_EMAIL)).file.id;
 await savePrebidSettings(env,TEST_EMAIL,{...request,acknowledge:true});
}
