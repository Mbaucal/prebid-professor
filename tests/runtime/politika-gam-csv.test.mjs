import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePolitikaCsv,summarizePolitika,POLITIKA_CSV_BYTES} from '../../src/measurement/politika-gam-csv.ts';
import {fixtureCsv,fixtureRows,headings} from '../support/politika-gam-csv-fixture.mjs';

test('all five original header sets are detected; properties, BOM, CRLF and reordered columns work',()=>{
 for(const id of Object.keys(headings)){
  const result=parsePolitikaCsv('\uFEFF'+fixtureCsv(id,{headers:[...headings[id]].reverse()}));
  assert.equal(result.id,id);assert.equal(result.start,'2026-11-19');assert.equal(result.rows.length,fixtureRows(id).length);
  assert.equal(result.periodFromProperties,true);assert(!JSON.stringify(result).includes('winner'));
 }
 const without=parsePolitikaCsv(fixtureCsv('01',{properties:false}));assert.equal(without.periodFromProperties,false);
 assert(without.warnings.some(w=>w.includes('Currency and time zone are assumed')));assert(without.warnings.some(w=>w.includes('Filter metadata is absent')));
});
test('A/B counters, integer revenue and request RPM use the same display population',()=>{
 const report=parsePolitikaCsv(fixtureCsv('01')), [a,b]=summarizePolitika(report,'Variant');
 assert.equal(a.totals.requests,150);assert.equal(a.totals.revenue,1250000);assert.equal(a.ecpm,12.5);
 assert.equal(a.requestRpm,1.25*1000/150);assert.equal(a.responseRate,100/150*100);
 assert.equal(a.viewability,75);assert.equal(a.measurability,80/90*100);assert.equal(a.ctr,5);assert.equal(b.totals.revenue,2500000);
});
test('overlapping key families never acquire a joint grain or a cross-family total',()=>{
 const r=parsePolitikaCsv(fixtureCsv('02'));
 assert.equal(summarizePolitika(r,'Variant').reduce((s,g)=>s+g.totals.impressions,0),200);
 assert.equal(summarizePolitika(r,'aq_bid_origin').reduce((s,g)=>s+g.totals.impressions,0),200);
 assert.equal(summarizePolitika(r,'aq_bid_origin')[0].totals.requests,null);
 assert.throws(()=>summarizePolitika(r,'all'),/key family/);
 assert.throws(()=>summarizePolitika(r,'aq_bid_origin',{Variant:'B'}),/Unknown breakdown/);
 for(const id of ['04','05'])assert.equal(parsePolitikaCsv(fixtureCsv(id)).families.length,2);
});
test('inventory remains site-wide and quoted requested sizes remain intact',()=>{
 const r=parsePolitikaCsv(fixtureCsv('03'));assert.deepEqual(r.families,['Inventory']);
 assert.equal(r.rows[0].dimensions['Requested ad sizes'],'300x250, 336x280');
 assert.equal(summarizePolitika(r,'Inventory')[0].totals.requests,150);
 assert.throws(()=>summarizePolitika(r,'Variant'),/key family/);
 const rows=fixtureRows('03');rows[0]['Total ad requests']='151';assert.throws(()=>parsePolitikaCsv(fixtureCsv('03',{rows})),/requests do not equal/);
});
test('missing metrics poison only affected totals and ratios; zero denominators are unknown',()=>{
 const rows=fixtureRows('01');rows[0]['Total CPM and CPC revenue']='';rows[0]['Unfilled impressions']='-';
 rows.push({...rows[0],'Ad unit (all levels)':'Politika.rs - Display » Second','Total CPM and CPC revenue':'7.10','Unfilled impressions':'10'});
 const [a,b]=summarizePolitika(parsePolitikaCsv(fixtureCsv('01',{rows})),'Variant');
 assert.equal(a.totals.revenue,null);assert.equal(a.totals.impressions,200);assert.equal(a.totals.requests,null);assert.equal(a.requestRpm,null);assert.equal(b.totals.requests,150);
 const zero=fixtureRows('01').slice(0,1);for(const h of headings['01'].slice(4))zero[0][h]='0';
 assert.equal(summarizePolitika(parsePolitikaCsv(fixtureCsv('01',{rows:zero})),'Variant')[0].requestRpm,null);
});
test('source Active View anomalies preserve counters and suppress affected ratios',()=>{
 const rows=fixtureRows('02');rows[0]['Ad server Active View viewable impressions']='81';
 const r=parsePolitikaCsv(fixtureCsv('02',{rows}));assert(r.warnings.some(w=>w.includes('1 row(s)')));
 const [a,b]=summarizePolitika(r,'Variant');assert.equal(a.totals.viewable,81);assert.equal(a.viewability,null);assert.equal(b.viewability,75);
});
test('metadata prevents wrong currency, time zone, network, scope, period and Prebid orders',()=>{
 for(const patch of [{'Report currency':'USD'},{'Time zone':'UTC'},{'Publisher network':'Other'},{'Report type':'Ad Exchange'},{'Report name':'Politika | 03 Wrong'}, {Filters:'Ad unit ID (all levels) = 999'}, {Filters:'Ad unit ID (all levels) = 23338702405 AND Country = Serbia'}, {'Date range':'Nov 20, 2026 - Nov 21, 2026'}])assert.throws(()=>parsePolitikaCsv(fixtureCsv('01',{propertyPatch:patch})));
 assert.throws(()=>parsePolitikaCsv(fixtureCsv('02',{propertyPatch:{Filters:'Ad unit ID (all levels) = 23338702405 AND Order ID = 999'}})),/expected Prebid order IDs/);
});
test('older incomplete CMP filters are explicitly flagged instead of implying zero missing buckets',()=>{
 const r=parsePolitikaCsv(fixtureCsv('05',{propertyPatch:{Filters:'Ad unit ID (all levels) = 23338702405 AND Key-values ID = '+Array.from({length:12},(_,i)=>String(1001+i)).join(', ')}}));
 assert(r.warnings.some(w=>w.includes('selects 12 key-values')&&w.includes('expects 14')));
});
test('duplicate grain, mixed site, mixed keys, custom NA exports and malformed CSV fail clearly',()=>{
 const rows=fixtureRows('01');assert.throws(()=>parsePolitikaCsv(fixtureCsv('01',{rows:[...rows,rows[0]]})),/duplicate report grain/);
 for(const patch of [{'Ad unit (all levels)':'Other site » QA'},{'Key-values':'aq_bid_origin=cached'},{'Key-values':'(not applicable)'},{'Key-values':'Variant=A;Variant=B'},{Date:'2026-02-30'},{'Total impressions':'1e3'},{'Total impressions':'1,00'},{'Total CPM and CPC revenue':'1,25'},{'Total CPM and CPC revenue':'-1.00'}])assert.throws(()=>parsePolitikaCsv(fixtureCsv('01',{rows:[{...rows[0],...patch}]})));
 assert.throws(()=>parsePolitikaCsv(fixtureCsv('01').replace('Key-values,','Variant (variant),')),/custom dimensions/);
 assert.throws(()=>parsePolitikaCsv(fixtureCsv('01')+'"unterminated'),/Unclosed/);
 assert.throws(()=>parsePolitikaCsv(fixtureCsv('01').replace('Variant=A','"Variant=A"bad')),/Unexpected text/);
 assert.throws(()=>parsePolitikaCsv(fixtureCsv('01',{headers:[...headings['01'],'Total impressions']})),/Duplicate CSV headers/);
 assert.throws(()=>parsePolitikaCsv(fixtureCsv('01',{rows:[]})),/no detail rows/);
});
test('precision, quoted names, missing dates and scoped filters remain exact',()=>{
 const rows=fixtureRows('01');rows[0]['Ad unit (all levels)']='Politika.rs - Display » QA "quoted", name';rows[0]['Total CPM and CPC revenue']='0.123456';rows[0]['Total impressions']='1,234';
 const r=parsePolitikaCsv(fixtureCsv('01',{rows,propertyPatch:{'Date range':'Nov 19, 2026 - Nov 21, 2026'}}));
 assert(r.warnings.some(w=>w.includes('2 date(s)')));
 const a=summarizePolitika(r,'Variant',{'Ad unit (all levels)':rows[0]['Ad unit (all levels)']})[0];
 assert.equal(a.totals.revenue,123456);assert.equal(a.totals.impressions,1234);
 assert.deepEqual(summarizePolitika(r,'Variant',{'Device category':'Tablet'}),[]);
 const huge=fixtureRows('01');huge[0]['Total impressions']='9007199254740992';assert.throws(()=>parsePolitikaCsv(fixtureCsv('01',{rows:huge})),/too large/);
 const sum=fixtureRows('01').slice(0,1);sum[0]['Total impressions']='9007199254740991';sum.push({...sum[0],'Ad unit (all levels)':'Politika.rs - Display » Second','Total impressions':'1'});
 assert.throws(()=>parsePolitikaCsv(fixtureCsv('01',{rows:sum})),/safe numeric precision/);
});
test('bounded large imports support the real Prebid report scale without truncation',()=>{
 const sample=fixtureRows('02')[0];const rows=Array.from({length:80_000},(_,i)=>({...sample,'Line item ID':String(100000+i)}));
 const r=parsePolitikaCsv(fixtureCsv('02',{rows}));assert.equal(r.rows.length,80_000);assert.equal(summarizePolitika(r,'Variant')[0].totals.impressions,8_000_000);
 assert.throws(()=>parsePolitikaCsv('x'.repeat(POLITIKA_CSV_BYTES+1)),/20 MiB/);
});
