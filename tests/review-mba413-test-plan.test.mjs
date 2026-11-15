import test from 'node:test';
import assert from 'node:assert/strict';
import {workspaceStore} from './support/test-workspace-store.mjs';
import {initializeTestSchema} from '../worker/test-workspace/schema.mjs';
import {readRuntimeSelectionSettings,saveRuntimeSelectionSettings} from '../worker/test-workspace/runtime-selection.mjs';
import {getPrebidSettings,saveBuildPlan} from '../worker/test-workspace/prebid-settings.mjs';

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
