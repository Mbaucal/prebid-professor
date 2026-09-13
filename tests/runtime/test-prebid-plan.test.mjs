import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceStore} from '../support/test-workspace-store.mjs';
import {initializeTestSchema} from '../../worker/test-workspace/schema.mjs';
import {readRuntimeSelectionSettings,saveRuntimeSelectionSettings,selectedWorkspaceRuntime} from '../../worker/test-workspace/runtime-selection.mjs';
import {getPrebidSettings,previewBuildPlan,saveBuildPlan,savePrebidSettings,preparePrebidSettings,commitPrebidSettings,prebidStore} from '../../worker/test-workspace/prebid-settings.mjs';
import {storePrebidFile} from '../../worker/test-workspace/prebid-files.mjs';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {buildArtifactCandidate} from '../../worker/runtime/artifact-candidate.mjs';
import {prebidRequirements,prebidFailureMessage} from '../../worker/runtime/prebid-artifact-check.mjs';
import {generatedLiteral} from '../support/generated-literal.mjs';
const actor='tester@example.invalid',active=[];
test.before(()=>{globalThis.fetch=()=>assert.fail('No external request while planning, saving or generating');});
test.afterEach(()=>{while(active.length)active.pop().close();});
async function ready(){const f=workspaceStore({prebidFiles:true});active.push(f);await initializeTestSchema(f.env.DB,actor);const s=await readRuntimeSelectionSettings(f.env);await saveRuntimeSelectionSettings(f.env,actor,{expectedRevision:s.revision,selection:{runtime:s.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});return f;}
const snap=f=>readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true});
async function request(f){const s=await getPrebidSettings(f.env);return {expectedRevision:s.revision,version:'11.11.0',options:s.options,draft:{...s.draft,enablePrebid:true,bidders:[{bidder:'openx',enabled:true,params:{unit:'private-placement',delDomain:'private-domain'}}]}};}
const file=(config,extra='')=>new TextEncoder().encode(`/* prebid.js v${config.version}\nModules: ${config.modules.join(', ')} */\n// inert round-trip fixture ${extra}\n`);
const plan=(f,r)=>previewBuildPlan(f.env,r);
async function upload(f,configuration){return (await storePrebidFile(prebidStore(f.env),file(configuration),actor)).file.id;}
const activate=(f,r)=>savePrebidSettings(f.env,actor,{...r,acknowledge:true});
test('export before any file: normalized options, deterministic modules, no private values or writes',async()=>{
  const f=await ready(),r=await request(f),before=await snap(f),puts=f.log.puts.length,gets=f.log.gets.length,p=await plan(f,r);
  assert.deepEqual(p.configuration,{version:'11.11.0',modules:['consentManagementTcf','currency','openxBidAdapter','tcfControl']});
  assert.equal(p.persisted,false);assert.deepEqual(Object.keys(p.configuration),['version','modules']);assert(!JSON.stringify(p.configuration).includes('private'));
  assert.deepEqual(await snap(f),before);assert.equal(f.log.puts.length,puts);assert.equal(f.log.gets.length,gets);
  const url=new URL(p.builderUrl);assert.deepEqual(url.searchParams.get('modules').split(','),p.configuration.modules);assert(!p.builderUrl.includes('private'));
});
test('pending plan survives reload while all active rows and exact pin stay unchanged',async()=>{
  const f=await ready(),r=await request(f),p=await plan(f,r);r.draft.buildId=await upload(f,p.configuration);await activate(f,r);
  const current=await request(f),before=await snap(f),rows=f.sqlite.prepare('SELECT * FROM bidders').all();current.draft.bidders.push({bidder:'pubmatic',params:{publisherId:'secret'},enabled:true});current.options.floorsEnabled=true;
  await saveBuildPlan(f.env,actor,{...current,acknowledge:true});const after=await snap(f),saved=JSON.parse(after.config.config_json),original=JSON.parse(before.config.config_json);
  assert.deepEqual(saved.builtinRuntimeSelection,original.builtinRuntimeSelection);delete saved.testPrebidPlan;assert.deepEqual(saved,original);
  assert.deepEqual(after.bidders,before.bidders);assert.deepEqual(after.prebidBuilds,before.prebidBuilds);assert.deepEqual(f.sqlite.prepare('SELECT * FROM bidders').all(),rows);
  const loaded=await getPrebidSettings(f.env);assert(loaded.plan.configuration.modules.includes('pubmaticBidAdapter'));assert(loaded.plan.configuration.modules.includes('priceFloors'));assert.equal(loaded.draft.bidders.length,1);
  assert.equal((await saveBuildPlan(f.env,actor,{...current,expectedRevision:loaded.revision,acknowledge:true})).changed,false);
});
test('round-trip activates original bytes and uses identical features in generated package',async()=>{
  const f=await ready(),r=await request(f);r.options.floorsEnabled=true;r.options.currencyConversionEnabled=false;r.options.hardFloor=0.08;
  const id=r.options.userIds.find(x=>x.name==='id5Id');id.enabled=true;id.settings.params.partner=1355;
  const p=await plan(f,r);assert.deepEqual(p.configuration.modules,['consentManagementTcf','id5IdSystem','openxBidAdapter','priceFloors','tcfControl','userId']);
  await saveBuildPlan(f.env,actor,{...r,acknowledge:true});r.expectedRevision=(await getPrebidSettings(f.env)).revision;r.draft.buildId=await upload(f,p.configuration);await activate(f,r);
  const settings=await snap(f),resolved=await selectedWorkspaceRuntime(settings,f.env.BUILDS),{prebidBuilds,...snapshot}=settings;
  const out=await buildArtifactCandidate({snapshot,pin:resolved.pin,buildTimestamp:'20260913_210000',takeOver:{enabled:false},prebid:resolved.prebid});
  assert.equal(Object.keys(out.files).length,10);assert.deepEqual(out.files['prebid.js'],file(p.configuration));
  const source=new TextDecoder().decode(out.files['ads.js']);assert.equal(generatedLiteral(source,'ENABLE_CURRENCY_CONVERSION'),false);assert.equal(generatedLiteral(source,'HARD_FLOOR_EUR'),0.08);assert.match(source,/var userIds\s*=\s*\[\s*\{\s*name:\s*"id5Id",\s*params:\s*\{\s*partner:\s*1355/);
  assert.equal((await getPrebidSettings(f.env)).plan,null);
});
test('changed bidder requires new build, gives exact reason and preserves pending/active settings',async()=>{
  const f=await ready(),r=await request(f),p=await plan(f,r);r.draft.buildId=await upload(f,p.configuration);await activate(f,r);
  const next=await request(f);next.draft.bidders.push({bidder:'pubmatic',params:{publisherId:'hidden'},enabled:true});const before=await snap(f);
  await assert.rejects(activate(f,next),e=>e.status===422&&e.message.includes('pubmaticBidAdapter (Bidder: pubmatic)')&&!e.message.includes('hidden'));
  assert.deepEqual(await snap(f),before);
});
test('returned version mismatch never activates the file',async()=>{const f=await ready(),r=await request(f),p=await plan(f,r);r.draft.buildId=await upload(f,{...p.configuration,version:'11.12.0'});const before=await snap(f);await assert.rejects(activate(f,r),e=>e.status===422&&/requires 11.11.0.*11.12.0/.test(e.message));assert.deepEqual(await snap(f),before);});
test('same plan checks current revision; stale tabs cannot export, save a plan or activate',async()=>{const f=await ready(),r=await request(f);await saveBuildPlan(f.env,actor,{...r,acknowledge:true});await assert.rejects(plan(f,r),e=>e.status===409);await assert.rejects(saveBuildPlan(f.env,actor,{...r,acknowledge:true}),e=>e.status===409);await assert.rejects(activate(f,r),e=>e.status===409);});
test('concurrent mutation after byte verification rolls back option and selection changes',async()=>{const f=await ready(),r=await request(f),p=await plan(f,r);r.draft.buildId=await upload(f,p.configuration);const prepared=await preparePrebidSettings(f.env,{...r,acknowledge:true});f.sqlite.exec("UPDATE publishers SET name='Other tab'");const before=await snap(f);await assert.rejects(commitPrebidSettings(prebidStore(f.env),prepared,actor),e=>e.status===409);assert.deepEqual(await snap(f),before);});
test('disabled IDs retain parameters but require no modules; re-enable restores same settings',async()=>{const f=await ready(),r=await request(f),id=r.options.userIds.find(x=>x.name==='id5Id');id.settings.params.partner=1355;const p=await plan(f,r);assert(!p.configuration.modules.includes('userId'));r.draft.buildId=await upload(f,p.configuration);await activate(f,r);const s=await getPrebidSettings(f.env);assert.equal(s.options.userIds.find(x=>x.name==='id5Id').settings.params.partner,1355);});
test('supply chain and all supported User IDs derive requirements from actual normalized input',()=>{const p=prebidRequirements({core:{bidders:[{bidder:'ix'}],userSync:{userIds:['sharedId','id5Id','teadsId','criteo','lotamePanoramaId'].map(name=>({name}))}},options:{enablePrebid:true,floors:{enabled:false},currencyConversion:{enabled:false},schain:{nodes:[{}]}}});assert.deepEqual(p.modules,['consentManagementTcf','criteoIdSystem','id5IdSystem','ixBidAdapter','lotamePanoramaIdSystem','schain','sharedIdSystem','tcfControl','teadsIdSystem','userId']);});
test('public verification messages drop raw storage failures and unknown issue content',()=>{const s=prebidFailureMessage({missingModules:['openxBidAdapter'],issues:[{code:'storage_read_failed',message:'secret key'},{code:'unknown',message:'private error'}]});assert(!/secret|private/.test(s));assert.match(s,/openxBidAdapter.*Bidder: openx/);});
for(const change of [r=>r.version='latest',r=>r.options.userIds[0].settings={name:'evil'},r=>r.options.userIds[0].settings=JSON.parse('{"__proto__":{"x":1}}'),r=>r.options.currencyConversionEnabled='false'])test('invalid plan never writes: '+change,async()=>{const f=await ready(),r=await request(f),before=await snap(f);change(r);await assert.rejects(plan(f,r));assert.deepEqual(await snap(f),before);});
