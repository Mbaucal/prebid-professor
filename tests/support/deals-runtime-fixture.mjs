import {positionFixture} from './position-runtime-fixture.mjs';
/** Only synthetic demand. Consumed by the new explicit-version package preparer. */
export function dealsRuntimeFixture(prebid=true){
 const snapshot=positionFixture(prebid),config=JSON.parse(snapshot.config.config_json);
 delete config.runtimeControls.adPositions;
 config.timeout=1000;
 config.runtimeControls.deals={schemaVersion:1,entries:[{id:'fixture-deal',name:'Synthetic deal',bidder:'pubmatic',dealId:'0000199',positions:[],startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',enabled:true,mode:'contract-priority'}]};
 snapshot.units=snapshot.units.filter(u=>u.code!=='Overlay');snapshot.overrides=[];
 snapshot.bidders=prebid?[{bidder:'pubmatic',params_json:'{"publisherId":"fixture","adSlot":"fixture"}',enabled:1},{bidder:'ix',params_json:'{"siteId":"fixture"}',enabled:1}]:[];
 snapshot.rules.forEach(row=>{const rule=JSON.parse(row.rule_json);rule.timeout=1000;rule.refresh={enabled:true,minSeconds:30,minViewPct:50,maxRefreshes:10};row.rule_json=JSON.stringify(rule);});
 snapshot.config.config_json=JSON.stringify(config);return snapshot;
}
