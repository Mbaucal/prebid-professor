import test from 'node:test';
import assert from 'node:assert/strict';
import {adminAuditStore} from '../support/admin-audit-store.mjs';
import {defaultUserIdSettings, getUserIdConfig, initializeMissingUserSync, readRequiredUserIdModules, updateUserIdConfig, USER_ID_CATALOG} from '../../worker/user-id-config.ts';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {previewInput} from '../../worker/runtime-3212/snapshot.mjs';
import {compileRuntime3212} from '../../worker/runtime-3212/compiler.mjs';
import {descriptor} from '../../.generated/runtime-3212-manifest.mjs';

const fixtures=[];
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const fixture=()=>{const f=adminAuditStore();fixtures.push(f);return f;};
const config=params=>({...defaultUserIdSettings().userIdConfig,modules:[{
  id:'lotame',name:'lotamePanoramaId',moduleCode:'lotamePanoramaIdSystem',enabled:true,
  ...(params===undefined?{}:{params}),
}]});
const save=(f,value)=>updateUserIdConfig(new Request('https://test.invalid/user-id-config',{
  method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(value),
}),f.env,'audit-site');

test('Lotame preset and save/reload accept omitted params without inventing a client ID',async()=>{
  assert.deepEqual(USER_ID_CATALOG.find(row=>row.name==='lotamePanoramaId').defaultParams,{});
  const f=fixture(),response=await save(f,config());
  assert.equal(response.status,200,await response.clone().text());
  const loaded=await getUserIdConfig(f.env,'audit-site').then(r=>r.json());
  assert.deepEqual(loaded.userIdConfig.modules[0].params,{});
  assert.deepEqual(loaded.userSyncPreview.userIds,[{name:'lotamePanoramaId'}]);
  assert.deepEqual(loaded.requiredModules,['lotamePanoramaIdSystem','userId']);
  assert(loaded.warnings.some(w=>w.includes('clientId is omitted')));
  const snapshot=await readPreviewSnapshot(f.env.DB,'audit-site');
  const input=previewInput(snapshot,descriptor,'20261116_120000');
  assert.deepEqual(input.core.userSync.userIds,[{name:'lotamePanoramaId'}]);
  const source=compileRuntime3212(input).adsJs;
  assert.match(source,/"name"\s*:\s*"lotamePanoramaId"/);
  assert.doesNotMatch(source,/clientId/);
});

test('a supplied Lotame client ID and unrelated module settings survive save/reload unchanged',async()=>{
  const f=fixture(),value=config({clientId:'1001',custom:'retained'});
  const response=await save(f,value);assert.equal(response.status,200,await response.clone().text());
  const loaded=await getUserIdConfig(f.env,'audit-site').then(r=>r.json());
  assert.deepEqual(loaded.userSyncPreview.userIds,[{name:'lotamePanoramaId',params:{clientId:'1001',custom:'retained'}}]);
  assert(!loaded.warnings.some(w=>w.includes('clientId is omitted')));
});

test('provided blank or malformed client IDs fail before any config or audit write',async()=>{
  const f=fixture();
  for(const clientId of ['', '   ', null, 1001, true, {}, []]){
    const before=f.readConfig(),batches=f.log.batches;
    const response=await save(f,config({clientId}));
    assert.equal(response.status,422,JSON.stringify(clientId));
    assert.match(await response.text(),/clientId must be a nonempty string when supplied/);
    assert.deepEqual(f.readConfig(),before);assert.equal(f.log.batches,batches);
  }
});

test('a disabled Lotame row retains its unfinished settings and produces no User ID module',async()=>{
  const f=fixture(),value=config({clientId:''});value.modules[0].enabled=false;
  const response=await save(f,value);assert.equal(response.status,200);
  const loaded=await getUserIdConfig(f.env,'audit-site').then(r=>r.json());
  assert.deepEqual(loaded.userIdConfig.modules[0].params,{clientId:''});
  assert.deepEqual(loaded.userSyncPreview.userIds,[]);assert.deepEqual(loaded.requiredModules,[]);
});

test('reading a legacy malformed Lotame ID preserves all saved modules and never repairs data implicitly',async()=>{
  const f=fixture(),stored=f.readConfig(),legacy=config({clientId:1001});
  legacy.modules.push({id:'criteo',name:'criteo',moduleCode:'criteoIdSystem',enabled:true,params:{}});
  stored.userIdConfig=legacy;f.writeConfig(stored);const before=f.readConfig(),batches=f.log.batches;
  const loaded=await getUserIdConfig(f.env,'audit-site').then(r=>r.json());
  assert.deepEqual(loaded.userSyncPreview.userIds,[{name:'lotamePanoramaId',params:{clientId:1001}},{name:'criteo'}]);
  assert(loaded.warnings.some(w=>w.includes('saved Lotame clientId must be corrected')));
  assert.deepEqual(await readRequiredUserIdModules(f.env.DB,'audit-site'),['criteoIdSystem','lotamePanoramaIdSystem','userId']);
  assert.deepEqual(initializeMissingUserSync(before).userSync.userIds,loaded.userSyncPreview.userIds);
  assert.deepEqual(f.readConfig(),before);assert.equal(f.log.batches,batches);
  assert.equal((await save(f,loaded.userIdConfig)).status,422);
  assert.deepEqual(f.readConfig(),before);
});
