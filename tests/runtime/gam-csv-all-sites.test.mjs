import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGamCsv,summarizeGamCsv,GAM_REPORTS,GAM_CSV_BYTES} from '../../src/measurement/gam-csv.ts';
import {siteCsv,siteRows,sites,headings} from '../support/gam-csv-fixture.mjs';
import {fixtureCsv} from '../support/politika-gam-csv-fixture.mjs';
const context=site=>({siteName:sites[site].name,gamPath:'/90000000000/parent-route/',expectedNetwork:sites[site].networkCode,expectedAdUnitRoot:sites[site].root,expectedAdUnitId:sites[site].adUnitId,prebidOrderIds:sites[site].orders});
test('all five native header sets work on three sites with unrelated names, networks, currencies and time zones',()=>{
 for(const site of Object.keys(sites))for(const spec of GAM_REPORTS){
  const report=parseGamCsv(siteCsv(spec.id,{site,headers:[...headings[spec.id]].reverse()}),context(site));
  assert.equal(report.id,spec.id);assert.equal(report.name,`My chosen ${site} report name ${spec.id}`);
  assert.equal(report.currency,sites[site].currency);assert.equal(report.timeZone,sites[site].timeZone);
  assert.equal(report.scope.networkVerified,true);assert.equal(report.scope.inventoryVerified,true);
  if(spec.id==='02')assert.equal(report.scope.prebidVerified,true);
 }
});
test('the original five Politika export formats remain supported without being site defaults',()=>{
 for(const id of ['01','02','03','04','05']){const r=parseGamCsv(fixtureCsv(id));assert.equal(r.id,id);assert.equal(r.currency,'EUR');assert.equal(r.timeZone,'Europe/Belgrade');}
 const bare=parseGamCsv(siteCsv('01',{properties:false}));assert.equal(bare.currency,null);assert.equal(bare.timeZone,null);assert.equal(bare.scope.networkVerified,false);assert.equal(bare.scope.inventoryVerified,false);
 assert(bare.warnings.some(x=>x.includes('remain unknown')));assert(bare.warnings.some(x=>x.includes('Completed-day')));
});
test('MCM names and parent/child numeric network differences cannot become false site verification',()=>{
 const report=parseGamCsv(siteCsv('01'),{gamPath:'/9999999999/saved-parent-route/'});
 assert.equal(report.scope.networkVerified,false);assert.equal(report.scope.inventoryVerified,false);
 assert(report.warnings.some(x=>x.includes('parent/child MCM')));
 const nameOnly=siteCsv('01').replace(/Network code,[^\r\n]+\r?\n/,'');
 const unknown=parseGamCsv(nameOnly,{expectedNetwork:'9999999999'});assert.equal(unknown.scope.networkVerified,false);
 assert.equal(parseGamCsv(nameOnly,{expectedNetwork:sites.tanjug.network}).scope.networkVerified,true);
 assert.throws(()=>parseGamCsv(siteCsv('01'),{expectedNetwork:sites.third.networkCode}),/Publisher network/);
 assert.throws(()=>parseGamCsv(nameOnly,{expectedNetwork:sites.third.network}),/Publisher network/);
});
test('explicit inventory roots and filter IDs reject wrong sites and substring collisions',()=>{
 assert.throws(()=>parseGamCsv(siteCsv('01'),context('third')),/Publisher network/);
 assert.throws(()=>parseGamCsv(siteCsv('01'),{expectedAdUnitId:'333'}),/Ad unit ID filter/);
 assert.throws(()=>parseGamCsv(siteCsv('01'),{expectedAdUnitRoot:'Tanjug.rs'}),/outside/);
 const rows=siteRows('01');rows[0]['Ad unit (all levels)']=sites.tanjug.root+'2 » wrong';
 assert.throws(()=>parseGamCsv(siteCsv('01',{rows}),{expectedAdUnitRoot:sites.tanjug.root}),/outside/);
 assert.throws(()=>parseGamCsv(siteCsv('02'),{prebidOrderIds:['601','602']}),/Order filter/);
 assert.throws(()=>parseGamCsv(siteCsv('02'),{prebidOrderIds:['601','601']}),/distinct positive/);
 assert.throws(()=>parseGamCsv(siteCsv('02'),{prebidLineItemIds:['900001']}),/Line item filter/);
});
test('delivery and request scopes remain separate, duplicate/ambiguous filters fail closed',()=>{
 const inventory=sites.tanjug.adUnitId;
 for(const Filters of [`Ad unit ID (all levels) = ${inventory} AND Order ID = 601`,`Ad unit ID (all levels) = ${inventory} OR Ad unit ID (all levels) = 333`,`Ad unit ID (all levels) = ${inventory} AND Country = Serbia`,`Ad unit ID (all levels) = ${inventory}, ${inventory}`])assert.throws(()=>parseGamCsv(siteCsv('01',{propertyPatch:{Filters}})));
 assert.throws(()=>parseGamCsv(siteCsv('03',{propertyPatch:{Filters:`Ad unit ID (all levels) = ${inventory} AND Key-values ID = 1001`}})),/unlabeled requests/);
 const unverified=parseGamCsv(siteCsv('02',{propertyPatch:{Filters:`Ad unit ID (all levels) = ${inventory}`}}));
 assert.equal(unverified.scope.prebidVerified,false);assert(unverified.warnings.some(x=>x.includes('Do not interpret')));
});
test('contradictory case-variant source properties cannot acquire verified scope',()=>{
 for(const line of ['filters,"Ad unit ID (all levels) = 999"','publisher network,Wrong network','network code,999','time zone,Europe/Belgrade','report currency,EUR']){
  assert.throws(()=>parseGamCsv(line+'\r\n'+siteCsv('01'),context('tanjug')),/repeated report properties/);
 }
});
test('reported line-item filters are verified against every detail row',()=>{
 const base='Ad unit ID (all levels) = 222 AND Line item ID = ';
 assert.throws(()=>parseGamCsv(siteCsv('02',{propertyPatch:{Filters:base+'601'}}),{prebidLineItemIds:['601']}),/outside the declared report filter/);
 const accepted=parseGamCsv(siteCsv('02',{propertyPatch:{Filters:base+'900001'}}),{prebidLineItemIds:['900001']});assert.equal(accepted.scope.prebidVerified,true);
 for(const id of ['0','01','900000000000000000000','-1'])assert.throws(()=>parseGamCsv(siteCsv('02',{rows:[{...siteRows('02')[0],'Line item ID':id}]})),/invalid Line item ID/);
});
test('independent expected numbers preserve counts, micros, unfilled denominator and separate overlap families',()=>{
 const a=summarizeGamCsv(parseGamCsv(siteCsv('01')),'Variant')[0];
 assert.deepEqual({requests:a.totals.requests,revenue:a.totals.revenue,ecpm:a.ecpm,viewability:a.viewability},{requests:150,revenue:1250000,ecpm:12.5,viewability:75});
 assert.equal(a.requestRpm,1000*1.25/150);assert(Math.abs(a.responseRate-100*100/150)<1e-12);assert(Math.abs(a.unfilledRate-100*50/150)<1e-12);
 const prebid=parseGamCsv(siteCsv('02'));assert.equal('versionId' in prebid,false);assert.equal('testId' in prebid,false);
 assert.equal(summarizeGamCsv(prebid,'Variant').reduce((n,g)=>n+g.totals.impressions,0),200);
 assert.equal(summarizeGamCsv(prebid,'aq_bid_origin').reduce((n,g)=>n+g.totals.impressions,0),200);
 assert.throws(()=>summarizeGamCsv(prebid,'Variant',{VersionId:'example'}),/Unknown breakdown/);
 assert.throws(()=>parseGamCsv(siteCsv('02',{rows:[{...siteRows('02')[0],'Key-values':'VersionId=example'}]})),/unsupported Key-values/);
});
test('refresh intervals belong to each site, not a hardcoded30second list',()=>{
 for(const interval of ['15','45','60','2.5']){
  const rows=siteRows('04').map(row=>row['Key-values']==='refresh_interval=45'?{...row,'Key-values':'refresh_interval='+interval}:row);
  const report=parseGamCsv(siteCsv('04',{rows}));assert(report.rows.some(r=>r.family==='refresh_interval'&&r.value===interval));
 }
 for(const interval of ['0','-1','1e3','Infinity','2.1234567'])assert.throws(()=>parseGamCsv(siteCsv('04',{rows:[{...siteRows('04')[0],'Key-values':'refresh_interval='+interval}]})),/unsupported Key-values/);
});
test('anomalous raw Active View counters never produce percentages above100',()=>{
 const rows=siteRows('01');rows[0]['Total Active View eligible impressions']='70';
 const report=parseGamCsv(siteCsv('01',{rows})),[a,b]=summarizeGamCsv(report,'Variant');
 assert.equal(a.totals.eligible,70);assert.equal(a.totals.measurable,80);assert.equal(a.measurability,null);assert.equal(a.viewability,75);assert.equal(b.measurability,80/90*100);
 assert(report.warnings.some(x=>x.includes('measurable impressions above eligible')));
});
test('report declarations validate currency/time zone and absent metadata can use explicit report settings',()=>{
 assert.throws(()=>parseGamCsv(siteCsv('01'),{currency:'EUR'}),/currency does not match/);
 assert.throws(()=>parseGamCsv(siteCsv('01'),{timeZone:'Europe/Belgrade'}),/Time zone does not match/);
 assert.throws(()=>parseGamCsv(siteCsv('01',{propertyPatch:{'Time zone':'Not/a-zone'}})),/IANA/);
 const report=parseGamCsv(siteCsv('01',{properties:false}),{currency:'GBP',timeZone:'Europe/London'});assert.equal(report.currency,'GBP');assert.equal(report.timeZone,'Europe/London');
});
test('bounded detail imports do not truncate or accept unsupported columns',()=>{
 assert.throws(()=>parseGamCsv('x'.repeat(GAM_CSV_BYTES+1)),/20 MiB/);
 assert.throws(()=>parseGamCsv(siteCsv('01',{headers:[...headings['01'],'Ad Exchange revenue']})),/Columns do not match/);
 const sample=siteRows('02')[0],rows=Array.from({length:80_000},(_,i)=>({...sample,'Line item ID':String(100000+i)}));
 const report=parseGamCsv(siteCsv('02',{rows}));assert.equal(report.rows.length,80000);assert.equal(summarizeGamCsv(report,'Variant')[0].totals.impressions,8000000);
});
