import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDeals,activeDeals,buildDealInput,assertDealTargetingKeys} from '../../shared/deals/contract.mjs';
import {dealPlan} from '../../shared/deals/gam-plan.mjs';
import {applyDealParams} from '../../worker/runtime-deals-v1/browser-deals.mjs';
const context={bidders:[{bidder:'pubmatic',enabled:1},{bidder:'ix',enabled:1}],units:[{code:'P1',enabled:1},{code:'P2',enabled:1}]};
const entry={id:'deal-1',name:'Agreed deal',bidder:'pubmatic',dealId:'0000123',positions:['P1'],startsAt:'2026-10-01T00:00:00.000Z',endsAt:'2026-11-01T00:00:00.000Z',enabled:true,mode:'contract-priority'};
const value=(rows=[entry])=>({schemaVersion:1,entries:rows});
test('Deal IDs remain strings, periods use strict UTC and exclusive end',()=>{
 const s=normalizeDeals(value(),context);assert.equal(s.entries[0].dealId,'0000123');
 assert.equal(activeDeals(s,{code:'P1',now:Date.parse(entry.startsAt)}).length,1);
 assert.equal(activeDeals(s,{code:'P1',now:Date.parse(entry.endsAt)}).length,0);
 for(const patch of [{dealId:123},{startsAt:'2026-02-30T00:00:00.000Z'},{startsAt:'2026-10-01T01:00:00+01:00'},{endsAt:entry.startsAt},{dealId:'123'}])assert.throws(()=>normalizeDeals(value([{...entry,...patch}]),context));
});
test('Unknown aliases and key collisions fail closed; disable keeps metadata editable',()=>{
 assert.throws(()=>normalizeDeals(value([{...entry,bidder:'pubmatic_alias'}]),{...context,bidders:[{bidder:'pubmatic_alias',enabled:1}]}),/aliases/);
 assert.throws(()=>assertDealTargetingKeys(['abcdefghijklm-one','abcdefghijklm-two']),/collide/);
 assert.equal(normalizeDeals(value([{...entry,bidder:'unsupported',enabled:false}]),context).entries.length,1);
});
test('Same-bidder overlapping position/time denied, distinct positions and adjacent times supported',()=>{
 assert.throws(()=>normalizeDeals(value([entry,{...entry,id:'two',dealId:'other'}]),context),/overlap/);
 for(const patch of [{positions:['P2']},{startsAt:entry.endsAt,endsAt:'2026-12-01T00:00:00.000Z'},{bidder:'ix'}])assert.equal(normalizeDeals(value([entry,{...entry,id:'two',...patch}]),context).entries.length,2);
});
test('Only documented PubMatic field is applied after overrides, evaluated afresh and no mutation',()=>{
 const settings=normalizeDeals(value(),context),unit={code:'P1',bids:[{bidder:'pubmatic',params:{adSlot:'override'}},{bidder:'ix',params:{siteId:'42'}}]};
 const before=structuredClone(unit),first=applyDealParams(unit,settings,Date.parse(entry.startsAt));
 assert.deepEqual(first.bids[0].params,{adSlot:'override',deals:['0000123']});assert.equal(first.bids[1],unit.bids[1]);assert.deepEqual(unit,before);
 const late=applyDealParams(unit,settings,Date.parse(entry.endsAt));assert.equal(Object.hasOwn(late.bids[0].params,'deals'),false);
 assert.equal(applyDealParams({...unit,code:'P2'},settings,Date.parse(entry.startsAt)).bids[0],unit.bids[0]);
 assert.equal(Object.hasOwn(first.bids[0].params,'dealId'),false);
});
test('Browser helper is self-contained and handles GAM-only without modification',()=>{
 const fn=Function('return ('+applyDealParams.toString()+')')(),unit={code:'P1',bids:[]};
 assert.equal(fn(unit,null,0),unit);assert.deepEqual(fn(unit,value(),Date.parse(entry.startsAt)),unit);
 const snapshot={...context,config:{config_json:JSON.stringify({enablePrebid:false,runtimeControls:{deals:value()}})}};
 assert.equal(buildDealInput(snapshot),null);
 snapshot.config.config_json=JSON.stringify({enablePrebid:false,runtimeControls:{deals:{invalid:true}}});assert.equal(buildDealInput(snapshot),null);
 const manual={...context,overrides:[],bidders:[{bidder:'pubmatic',enabled:1,params_json:'{"deals":["manual"]}'}],config:{config_json:JSON.stringify({enablePrebid:true,runtimeControls:{deals:value()}})}};
 assert.throws(()=>buildDealInput(manual),/Move existing/);
 assert.deepEqual(fn({code:'P1',bids:[{bidder:'pubmatic',params:{deals:['manual']}}]},value([{...entry,enabled:false}]),Date.parse(entry.startsAt)).bids[0].params.deals,['manual']);
});
test('GAM plan is stable site/network scoped, uses bidder-specific real-ad macro, never claims eligibility or writes',()=>{
 const snapshot={...context,units:[{code:'P1',enabled:1,size_map_key:'display'}],maps:[{name:'display',map_json:'[{"viewport":[0,0],"sizes":[[300,250]]}]'}],site:{id:'site-a',gam_path:'/123,456/site/'}},settings=normalizeDeals(value(),context),plan=dealPlan(snapshot,settings);
 assert.deepEqual(plan,dealPlan(snapshot,settings));assert.equal(plan.writeEnabled,false);assert.equal(plan.network,'123,456');assert.deepEqual(plan.entries[0].inventory,[{code:'P1',adUnitPath:'/123,456/site/P1',sizeMap:[{viewport:[0,0],sizes:[[300,250]]}]}]);
 assert.deepEqual(plan.entries[0].targeting,{key:'hb_deal_pubmatic',value:'0000123'});assert.equal(plan.entries[0].creativeAdIdMacro,'%%PATTERN:hb_adid_pubmatic%%');assert.match(plan.entries[0].eligibility,/No matching bid/);
 assert.notEqual(plan.entries[0].id,dealPlan({...snapshot,site:{...snapshot.site,id:'site-b'}},settings).entries[0].id);
});
