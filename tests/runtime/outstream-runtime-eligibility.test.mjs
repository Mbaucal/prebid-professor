import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeOutstream, outstreamContext} from '../../shared/outstream/selected-settings.mjs';
import {outstreamSettingsResponse} from '../../worker/site-runtime/outstream-settings.mjs';
import {workspaceStore} from '../support/test-workspace-store.mjs';

const fixed={format:'banner-outstream',playerSize:[300,250],minDuration:1,maxDuration:30,playbackMethod:2,placement:3,plcmt:4,
  partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'fixture',activationConfirmed:true},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache'};
const {playerSize,...common}=fixed;
const responsive={...common,playerSizing:'size-map',playerSizes:{}};
const settings=(code,value=responsive)=>({schemaVersion:1,units:Object.fromEntries([[code,structuredClone(value)]])});
const pin=version=>({runtimeId:version.includes('preview')?'tessera-revenue-preview-'+version.at(-1):'tessera-'+version,runtimeVersion:version});
function snapshot(version,code='Billboard') {
  return {units:[{code,media_type:'banner',type:'BTF',enabled:1,size_map_key:'display'}],
    maps:[{name:'display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])}],
    bidders:[{bidder:'pubmatic',enabled:1}],prebidBuilds:[{version:'11.34.0',modules_json:'["pubmaticBidAdapter"]'}],
    config:{config_json:JSON.stringify({enablePrebid:true,runtimeControls:{sticky:{bottomAdUnitId:''}},
      ...(version?{builtinRuntimeSelection:{runtime:pin(version)}}:{})})}};
}

test('sites without saved Outstream settings remain editable under code-compatible versions',()=>{
  for(const version of ['3.19.1','3.20.0','3.20.1','3.21.0','3.22.0']){
    const context=outstreamContext(snapshot(version));
    assert.deepEqual(normalizeOutstream(undefined,context),{schemaVersion:1,units:{}});
    for(const invalid of [null,{}, {schemaVersion:2,units:{}}])assert.throws(()=>normalizeOutstream(invalid,context),/Unsupported outstream settings version/);
  }
});

test('3.20.1 and 3.21.0 retain 3.19.1 exact-code fixed and responsive Outstream behavior',()=>{
  for(const version of ['3.20.1','3.21.0','3.22.0'])for(const code of ['m.box_3','123_banner','__proto__'])for(const value of [fixed,responsive]){
    const before=snapshot('3.19.1',code),combined=snapshot(version,code),saved=structuredClone(combined);
    const context=outstreamContext(combined);
    assert.equal(context.gamCodeCompatibility,true);assert.equal(context.responsiveSizing,true);assert.equal(context.positionScoped,true);
    assert.deepEqual(normalizeOutstream(settings(code,value),context),normalizeOutstream(settings(code,value),outstreamContext(before)));
    assert.deepEqual(combined,saved,'validation does not change the selected version or saved metadata');
  }
});

test('3.20 uses supported responsive dimensions but does not imply extended GAM-code support',()=>{
  const context=outstreamContext(snapshot('3.20.0'));
  assert.equal(context.responsiveSizing,true);assert.equal(context.gamCodeCompatibility,undefined);
  assert.deepEqual(normalizeOutstream(settings('Billboard'),context),settings('Billboard'));
  assert.throws(()=>normalizeOutstream(settings('m.box_3'),outstreamContext(snapshot('3.20.0','m.box_3'))),/Invalid outstream position/);
});

test('legacy and unselected versions keep their prior Outstream restrictions',()=>{
  for(const version of [undefined,'3.15.0','3.16.0-revenue.preview.1','3.16.0-revenue.preview.2']){
    const context=outstreamContext(snapshot(version));
    assert.equal(context.responsiveSizing,undefined);assert.equal(context.gamCodeCompatibility,undefined);
    assert.throws(()=>normalizeOutstream(settings('Billboard'),context),/Responsive video sizes require Script version 3\.16\.0/);
    assert.deepEqual(normalizeOutstream(settings('Billboard',fixed),context),settings('Billboard',fixed));
  }
  const invalid=snapshot('3.20.1'),config=JSON.parse(invalid.config.config_json);
  config.builtinRuntimeSelection.runtime.runtimeId='tessera-3.20.0';invalid.config.config_json=JSON.stringify(config);
  assert.equal(outstreamContext(invalid).gamCodeCompatibility,undefined,'an inconsistent version pair cannot select the new validator');
});

test('3.20.1 and 3.21.0 keep width-only video, partner and display validation',()=>{
  for(const version of ['3.20.1','3.21.0','3.22.0'])for(const modify of [
    s=>s.maps[0].map_json=JSON.stringify([{viewport:[0,600],sizes:[[300,250]]}]),
    s=>s.bidders[0].enabled=0,
    s=>{const c=JSON.parse(s.config.config_json);c.runtimeControls.sticky.bottomAdUnitId='m.box_3';s.config.config_json=JSON.stringify(c);},
  ]){
    const s=snapshot(version,'m.box_3');modify(s);
    assert.throws(()=>normalizeOutstream(settings('m.box_3'),outstreamContext(s)),/width breakpoints only|enable the verified PubMatic|configured as bottom Sticky/);
  }
});

function store(version,code='Billboard') {
  const f=workspaceStore(),saved=snapshot(version,code);
  f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
  f.sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('first','First','first.invalid','/123/first/')").run();
  f.sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg','first',?)").run(saved.config.config_json);
  f.sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,enabled,sort_order) VALUES('unit','first',?,'BTF','display',1,0)").run(code);
  f.sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('map','first','display',?)").run(saved.maps[0].map_json);
  f.sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES('bidder','first','pubmatic','{}',1)").run();
  f.sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('pb','first','11.34.0','unused','[\"pubmaticBidAdapter\"]','current')").run();
  f.request=body=>outstreamSettingsResponse(new Request('https://fixture.invalid/api/publishers/first/outstream-settings',{
    method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined}),f.env,'first','tester');
  return f;
}

test('Formats API exposes new versions, saves exact responsive choices and preserves explicit selection',async()=>{
  for(const [version,code] of [['3.22.0','m.box_3'],['3.21.0','m.box_3'],['3.20.0','Billboard'],['3.20.1','m.box_3'],['3.19.1','m.box_3']]){
    const f=store(version,code);
    try{
      const before=await (await f.request()).json();
      assert.equal(before.runtimeEligible,true);assert.equal(before.responsiveSizing,true);
      const result=await f.request({revision:before.revision,outstream:settings(code)});
      assert.equal(result.status,200,await result.clone().text());
      const after=await (await f.request()).json();assert.deepEqual(after.outstream,settings(code));
      assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json).builtinRuntimeSelection.runtime,pin(version));
      assert.equal((await f.request({revision:before.revision,outstream:settings(code,fixed)})).status,409,'stale writes remain blocked');
      assert.deepEqual((await (await f.request()).json()).outstream,settings(code));
      assert.equal(f.sqlite.prepare('SELECT current_release_id FROM publishers').get().current_release_id,null);
    }finally{f.close();}
  }
  for(const version of [undefined,'3.15.0']){
    const f=store(version);
    try{const state=await (await f.request()).json();assert.equal(state.runtimeEligible,false);assert.equal(state.responsiveSizing,false);}
    finally{f.close();}
  }
});
