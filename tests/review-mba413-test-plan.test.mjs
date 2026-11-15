import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceStore} from './support/test-workspace-store.mjs';
import {initializeTestSchema} from '../worker/test-workspace/schema.mjs';
import {readRuntimeSelectionSettings,saveRuntimeSelectionSettings,selectedWorkspaceRuntime} from '../worker/test-workspace/runtime-selection.mjs';
import {getPrebidSettings,saveBuildPlan,savePrebidSettings,prebidStore} from '../worker/test-workspace/prebid-settings.mjs';
import {storePrebidFile} from '../worker/test-workspace/prebid-files.mjs';
import {readPreviewSnapshot} from '../worker/runtime/builtin-preview-service.mjs';
import {buildArtifactCandidate} from '../worker/test-workspace/runtime-catalog.mjs';

test('TEST pending-plan reload exposes a new alias without changing active bidders',async()=>{
  const f=workspaceStore({prebidFiles:true});
  try {
    const actor='reviewer@example.invalid';
    await initializeTestSchema(f.env.DB,actor);
    const initial=await readRuntimeSelectionSettings(f.env);
    await saveRuntimeSelectionSettings(f.env,actor,{expectedRevision:initial.revision,selection:{runtime:initial.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
    const settings=await getPrebidSettings(f.env);
    const alias={bidder:'adf_ag',baseAdapter:'adf',displayName:'Agency pending account',params:{mid:222},enabled:false,schain:{mode:'none'}};
    const before=f.sqlite.prepare('SELECT * FROM bidders').all();
    await saveBuildPlan(f.env,actor,{
      expectedRevision:settings.revision,acknowledge:true,version:'11.11.0',options:settings.options,
      draft:{...settings.draft,enablePrebid:true,bidders:[{bidder:'openx',params:{unit:'fixture',delDomain:'fixture.invalid'},enabled:true},alias]}
    });
    const loaded=await getPrebidSettings(f.env);
    assert.deepEqual(loaded.plan.draft.bidders.find(row=>row.bidder===alias.bidder),alias);
    assert.deepEqual(f.sqlite.prepare('SELECT * FROM bidders').all(),before,'A saved plan must not activate pending account settings');
    assert(loaded.supportedBidders.includes(alias.bidder),'The UI renders the pending plan; its bidder selector must contain that alias instead of becoming blank');
  } finally { f.close(); }
});

test('TEST account plan, activation and regeneration preserve distinct account chains and exact file bytes',async()=>{
  const f=workspaceStore({prebidFiles:true});
  try {
    const actor='reviewer@example.invalid';await initializeTestSchema(f.env.DB,actor);
    const initial=await readRuntimeSelectionSettings(f.env),runtime=initial.runtimes.find(row=>row.version==='3.22.1');assert(runtime);
    await saveRuntimeSelectionSettings(f.env,actor,{expectedRevision:initial.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
    const config=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
    config.runtimeControls??={};config.runtimeControls.schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'site-seller.example',sid:'site-42',hp:1}]};
    f.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
    const settings=await getPrebidSettings(f.env),accounts=[
      {bidder:'adf_smn',baseAdapter:'adf',displayName:'SMN',params:{mid:111},enabled:true,schain:{mode:'inherit'}},
      {bidder:'adf_ag',baseAdapter:'adf',displayName:'Agency',params:{mid:222},enabled:true,schain:{mode:'none'}},
      {bidder:'adf_partner',baseAdapter:'adf',displayName:'Partner',params:{mid:333},enabled:true,schain:{mode:'custom',config:{ver:'1.0',complete:1,nodes:[{asi:'partner.example',sid:'partner-43',hp:1}]}}}
    ];
    const request={expectedRevision:settings.revision,acknowledge:true,version:'11.11.0',options:settings.options,draft:{...settings.draft,enablePrebid:true,bidders:accounts,overrides:[{bidder:'adf_ag',scopeType:'slot',scopeKey:'ATF',params:{mid:224},enabled:true}]}};
    const saved=await saveBuildPlan(f.env,actor,request);assert.equal(saved.plan.configuration.modules.filter(name=>name==='adfBidAdapter').length,1);
    const bytes=new TextEncoder().encode('/* prebid.js v11.11.0\nModules: '+saved.plan.configuration.modules.join(', ')+' */\nvoid 0;');
    const uploaded=await storePrebidFile(prebidStore(f.env),bytes,actor);
    request.expectedRevision=(await getPrebidSettings(f.env)).revision;request.draft.buildId=uploaded.file.id;
    await savePrebidSettings(f.env,actor,request);
    const active=await getPrebidSettings(f.env);assert.equal(active.plan,null);
    assert.deepEqual(active.draft.bidders.map(row=>[row.bidder,row.params.mid,row.schain.mode]),[['adf_ag',222,'none'],['adf_partner',333,'custom'],['adf_smn',111,'inherit']]);
    const settingsSnapshot=await readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true}),resolved=await selectedWorkspaceRuntime(settingsSnapshot,f.env.BUILDS),{prebidBuilds,...snapshot}=settingsSnapshot;
    const first=await buildArtifactCandidate({snapshot,pin:resolved.pin,buildTimestamp:'20261115_040000',takeOver:{enabled:false},prebid:resolved.prebid});
    const out=JSON.parse(new TextDecoder().decode(first.files['config.json']));
    assert.deepEqual(out.bidderAccounts.map(account=>[account.bidder,account.baseAdapter,account.schain.mode]),[['adf_ag','adf','none'],['adf_partner','adf','custom'],['adf_smn','adf','inherit']]);
    assert.deepEqual(out.bidderAccounts.find(row=>row.bidder==='adf_partner').schain.config.nodes,accounts[2].schain.config.nodes);
    assert.deepEqual(first.files['prebid.js'],bytes,'Generation retains the selected original Prebid file');
    const firstCopy=structuredClone(Object.entries(first.files));
    const second=await buildArtifactCandidate({snapshot,pin:resolved.pin,buildTimestamp:'20261115_040001',takeOver:{enabled:false},prebid:resolved.prebid});
    assert.deepEqual(Object.entries(first.files),firstCopy,'Regeneration never mutates a previously generated package');
    assert.deepEqual(second.files['prebid.js'],bytes);
    assert.deepEqual(await readPreviewSnapshot(f.env.DB,'test-site',{includePrebid:true}),settingsSnapshot,'Generation does not rewrite saved account settings or active pins');
  } finally { f.close(); }
});
