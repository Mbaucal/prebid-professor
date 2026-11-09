import test from 'node:test';
import assert from 'node:assert/strict';
import {validateAdUnitCode, escapeCssId, escapeHtml} from '../../shared/gam/ad-unit-code.mjs';
import {normalizeOutstream} from '../../shared/outstream/selected-settings.mjs';
import {readPositions, defaultOverlay} from '../../worker/site-runtime/position-settings.mjs';
import {previewInput} from '../../worker/runtime-3191/snapshot.mjs';
import {descriptor} from '../../.generated/runtime-3191-manifest.mjs';
import {fixture,configure} from './artifact-fixture.mjs';

test('GAM character validation preserves legal literal identities and rejects invalid codes',()=>{
  for(const code of ['m.box_3','m.InText_1','1Banner','slot.*"\\/!<:()','Članak','投放','__proto__','constructor','A'.repeat(100)]) assert.deepEqual(validateAdUnitCode(code),[],code);
  for(const code of ['',null,'/leading','white space','x=y','x>y','A'.repeat(101),'x\n']) assert.ok(validateAdUnitCode(code).length,String(code));
  assert.equal(escapeCssId('m.box_3'),'#m\\.box_3');
  assert.equal(escapeCssId('1Banner'),'#\\31 Banner');
  assert.equal(escapeCssId('-1Banner'),'#-\\31 Banner');
  assert.equal(escapeHtml('slot"<'),'slot&quot;&lt;');
});

test('normalization preserves exact references and unrelated values without mutating input',()=>{
  const s=fixture();s.units[0].code='m.box_3';s.overrides[0].scope_key='m.box_3';s.overrides[0].params_json='{"siteId":"m.box_3"}';
  s.units.push({code:'legacy invalid ignored',enabled:0,type:'DRAFT'});
  s.rules.push({rule_key:'m.box_3',rule_json:'{"timeout":1700}'});
  configure(s,c=>{c.runtimeControls.floors.rules={'m.box_3':0.2};});
  const before=JSON.stringify(s);const input=previewInput(s,descriptor,'20261109_230000');
  assert.equal(input.core.explicitUnits[0].id,'m.box_3');
  assert.equal(input.core.adUnitRules['m.box_3'].timeout,1700);
  assert.equal(input.core.bidderAdUnitParams.ix['m.box_3'].siteId,'m.box_3');
  assert.equal(input.options.floors.rules['m.box_3'],0.2);
  assert.equal(JSON.stringify(s),before);
});

test('editor TakeOver reads literal prototype-shaped codes as own data',()=>{
  for(const code of ['m.Overlay','__proto__','constructor','toString']) {
    const config={runtimeControls:{adPositions:Object.fromEntries([[code,defaultOverlay()]])}};
    const positions=readPositions(config,[{code}]);
    assert.equal(Object.getPrototypeOf(positions),null);assert.deepEqual(positions[code],defaultOverlay());
    assert.equal(Object.prototype.demand,undefined);
  }
});

test('selected Outstream validator preserves legal codes while keeping partner and sizing checks',()=>{
  const settings={format:'banner-outstream',playerSize:[640,360],minDuration:5,maxDuration:30,playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'literal_partner_id',activationConfirmed:true},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache'};
  for(const code of ['m.box_3','1Video','__proto__','slot"\\<']) {
    const value={schemaVersion:1,units:Object.fromEntries([[code,settings]])};
    const context={gamCodeCompatibility:true,units:[{code,type:'BTF',media_type:'banner',enabled:1,size_map_key:'video'}],maps:[{name:'video',map_json:'[{"viewport":[0,0],"sizes":[[640,360]]}]'}],enablePrebid:true,prebidVersion:'11.34.0',modules:['pubmaticBidAdapter'],bidders:[{bidder:'pubmatic',enabled:1}],blockedCodes:[]};
    const result=normalizeOutstream(value,context);assert.deepEqual(result,value);
    assert.throws(()=>normalizeOutstream(value,{...context,modules:[]}));
    assert.throws(()=>normalizeOutstream(value,{...context,blockedCodes:[code]}));
  }
});
