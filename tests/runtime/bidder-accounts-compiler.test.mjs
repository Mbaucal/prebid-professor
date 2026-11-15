import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parse} from 'acorn';
import vm from 'node:vm';
import {createBidderAccounts} from '../../shared/bidder-accounts/browser.mjs';
import {applyBidderAccounts} from '../../shared/bidder-accounts/compiler.mjs';
import {createBidderRules} from '../../worker/runtime-322/browser-bidder-rules.mjs';
import {compileRuntime3212} from '../../worker/runtime-3212/compiler.mjs';
import {previewInput} from '../../worker/runtime-3212/snapshot.mjs';
import {descriptor} from '../../.generated/runtime-3212-manifest.mjs';
import {fixture, configure} from './artifact-fixture.mjs';
const text=await readFile(new URL('../../shared/bidder-accounts/browser.mjs',import.meta.url),'utf8');
const node=parse(text,{sourceType:'module',ecmaVersion:2015}).body.find(node=>node.type==='ExportNamedDeclaration').declaration;
const browser=text.slice(node.start,node.end);
function input() {
  const source=configure(fixture(), config=>{config.runtimeControls.schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'seller.invalid',sid:'site',hp:1}]};});
  const result=previewInput(source,descriptor,'20261115_120000');
  result.bidderAccounts=[{bidder:'adf_ag',baseAdapter:'adf',schain:{mode:'none'}}];
  return result;
}
function walk(node, callback) {if(!node||typeof node!=='object')return;callback(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(child=>walk(child,callback));else if(value&&typeof value==='object')walk(value,callback);}}
test('new compiler removes only wrapper global chain, keeps inherited enabled bidder and canonical browser function',()=>{
  const value=input(),before=compileRuntime3212(value).adsJs,after=applyBidderAccounts(before,value,browser);
  const ast=parse(after,{ecmaVersion:2015}), configs=[],calls=[];
  walk(ast,node=>{if(node.type==='CallExpression'&&node.callee.type==='MemberExpression'&&node.callee.object.name==='pbjs'&&node.callee.property.name==='setConfig'&&node.arguments[0]?.properties?.some(p=>p.key?.name==='floors'))configs.push(node.arguments[0]);
    if(node.type==='CallExpression'&&node.callee.name==='createBidderAccounts')calls.push(node);});
  assert.equal(configs.length,1);assert.equal(configs[0].properties.some(p=>p.key?.name==='ortb2'),false);
  assert.equal(calls.length,1);const accounts=JSON.parse(after.slice(calls[0].arguments[1].start,calls[0].arguments[1].end));
  assert.deepEqual(accounts.map(a=>[a.bidder,a.baseAdapter,a.schain.mode]),[['adf_ag','adf','none'],['ix','ix','inherit']]);
  assert.equal(after.includes(browser),true);assert(after.includes('rawRequest:_adBidderAccounts.request'));
  assert(after.indexOf('_adBidderAccounts.preparePrebid(pbjs)')<after.indexOf('       pbjs.setConfig({'));
  assert(after.includes('_adBidderAccounts.configurePrebid(pbjs);\n    _adContext.configurePrebid(pbjs);'));
  assert(after.includes('return e.bidder===bid.bidder;'));
});
test('accounts opt-out preserves legacy bytes and missing canonical source fails explicitly',()=>{
  const value=input(),before=compileRuntime3212(value).adsJs;
  assert.equal(applyBidderAccounts(before,{...value,bidderAccounts:[]}),before);
  assert.equal(applyBidderAccounts(before,{...value,bidderAccounts:[{bidder:'ix'}]}),before);
  assert.throws(()=>applyBidderAccounts(before,value),/canonical/);
});
test('responsive Outstream cannot restore a blocked account with bidder rules on or off', () => {
  const value = input();
  value.bidderAccounts = [
    {bidder: 'pubmatic', baseAdapter: 'pubmatic', schain: {mode: 'inherit'}},
    {bidder: 'pm_agency', baseAdapter: 'pubmatic', schain: {mode: 'none'}},
    {bidder: 'openx', baseAdapter: 'openx', schain: {mode: 'none'}},
  ];
  const source = applyBidderAccounts(compileRuntime3212(value).adsJs, value, browser);
  let responsiveRequest;
  walk(parse(source, {ecmaVersion: 2015}), node => {
    if (node.type === 'VariableDeclarator' && node.id?.name === '_adContext') {
      responsiveRequest = node.init.arguments[2].properties.find(property => property.key.name === 'request').value;
    }
  });
  const mediaTypes = {banner: {sizes: [[300, 250]]}, video: {context: 'outstream', playerSize: [[300, 250]]}};
  const makeUnit = (code, bidders) => ({
    code, mediaTypes, bids: bidders.map(bidder => ({bidder, params: {placement: code}})),
  });
  const rebuilt = {
    P1: makeUnit('P1', ['pubmatic', 'pm_agency', 'openx']),
    P2: makeUnit('P2', ['pm_agency']),
  };
  const request = vm.runInNewContext('(' + source.slice(responsiveRequest.start, responsiveRequest.end) + ')', {
    TESSERA_OUTSTREAM: {units: {P1: {playerSizing: 'size-map'}, P2: {playerSizing: 'size-map'}}},
    adUnitFromCode: code => rebuilt[code],
    _gamReporting: {request: (pb, next) => pb.requestBids(next)},
  });
  for (const enabled of [false, true]) {
    const sent = [];
    const pb = {
      version: '11.45.0',
      aliasRegistry: {pm_agency: 'ix'},
      aliasBidder() { assert.fail('The conflicting alias is already registered'); },
      getConfig() {},
      setBidderConfig() {},
      requestBids(next) {
        assert.equal(this, pb);
        sent.push(next);
        return 'native';
      },
    };
    const rules = createBidderRules({innerWidth: 1200}, {enabled, rules: []}, {
      evaluate: (_, bid) => ({allowed: bid.bidder !== 'openx', ruleId: bid.bidder === 'openx' ? 'skip-openx' : null}),
      normalizeCountry: () => null,
      request,
    });
    const accounts = createBidderAccounts({}, value.bidderAccounts, null, {request: rules.request});
    const initialP2 = makeUnit('P2', ['pubmatic']);
    assert.equal(accounts.request(pb, {
      adUnits: [rebuilt.P1, initialP2],
      adUnitCodes: ['P1', 'P2'],
      auctionId: 'mixed',
    }), 'native');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].auctionId, 'mixed');
    assert.deepEqual(JSON.parse(JSON.stringify(sent[0].adUnits.map(unit => [unit.code, unit.bids.map(bid => bid.bidder)]))),
      [['P1', enabled ? ['pubmatic'] : ['pubmatic', 'openx']]]);
    assert.deepEqual(sent[0].adUnitCodes, ['P1']);
    assert.equal(sent[0].adUnits[0].mediaTypes, mediaTypes);
    assert.equal(sent[0].adUnits[0].bids[0], rebuilt.P1.bids[0]);
    assert.equal(rebuilt.P1.bids[1].bidder, 'pm_agency');
    const callbacks = [];
    accounts.request(pb, {
      adUnits: [initialP2],
      auctionId: 'all-blocked',
      bidsBackHandler(...args) { callbacks.push(args); },
    });
    assert.equal(sent.length, 1);
    assert.equal(callbacks.length, 1);
    assert.deepEqual(Object.keys(callbacks[0][0]), []);
    assert.deepEqual(callbacks[0].slice(1), [false, 'all-blocked']);
    assert(accounts.snapshot().events.some(event => event.kind === 'alias-base-conflict' && event.detail === 'P1'));
  }
});
test('PubMatic deal parameter routing isolates exact alias and account metadata is safe in generated code',()=>{
  const value=input();value.bidderAccounts=[{bidder:'pm_a',baseAdapter:'pubmatic',displayName:'</script>$&\u2028',schain:{mode:'inherit'}},{bidder:'pm_b',baseAdapter:'pubmatic',schain:{mode:'none'}}];
  const source=applyBidderAccounts(compileRuntime3212(value).adsJs,value,browser),ast=parse(source,{ecmaVersion:2015});let fn;
  walk(ast,node=>{if(node.type==='FunctionDeclaration'&&node.id?.name==='applyDealParams')fn=node;});
  const apply=vm.runInNewContext('('+source.slice(fn.start,fn.end)+')');
  const unit={code:'P1',bids:[{bidder:'pm_a',params:{}},{bidder:'pm_b',params:{}}]};
  const entries=[{enabled:true,bidder:'pm_a',positions:[],startsAt:'2026-01-01',endsAt:'2027-01-01',dealId:'one'}];
  assert.deepEqual(JSON.parse(JSON.stringify(apply(unit,{entries},Date.parse('2026-11-15')).bids)),[{bidder:'pm_a',params:{deals:['one']}},{bidder:'pm_b',params:{}}]);
  assert(!source.includes('</script>'));
});
test('contextual aliases use base capability checks while their auction fragments stay isolated',()=>{
  const value=input();value.bidderAccounts=[{bidder:'teads_ag',baseAdapter:'teads'},{bidder:'rubicon_ag',baseAdapter:'rubicon'},{bidder:'openx_ag',baseAdapter:'openx'}];
  const source=applyBidderAccounts(compileRuntime3212(value).adsJs,value,browser),ast=parse(source,{ecmaVersion:2015});let fn;
  walk(ast,node=>{if(node.type==='FunctionDeclaration'&&node.id?.name==='createContextualSignals')fn=node;});
  const create=vm.runInNewContext('('+source.slice(fn.start,fn.end)+')');
  const config={enabled:true,sourceKey:'category',providerName:'fixture.invalid',prebidVersion:'11.11.0',gam:{enabled:false},
    bidders:value.bidderAccounts.map(account=>({bidder:account.bidder,taxonomy:'iab-content-2.2'})),
    mappings:[{value:'Sports',taxonomies:{'iab-content-2.2':['483']}}]};
  const context=create({adsKeywords:{category:'Sports'}},config,{request(){},dispatch(){},code:slot=>slot.id});
  context.request({}, {auctionId:'one',adUnits:[{code:'P1'}]});
  const schain={ver:'1.0',complete:1,nodes:[{asi:'seller.invalid',sid:'keep',hp:1}]};
  const fragments={
    global:{site:{content:{data:[{name:'foreign',ext:{segtax:7},segment:[{id:'other-taxonomy'}]}]}}},
    bidder:{openx_ag:{source:{ext:{schain}}}}
  };
  context.enrichAuction({auctionId:'one',ortb2Fragments:fragments});
  assert.equal(fragments.bidder.teads_ag,undefined);assert.equal(fragments.bidder.rubicon_ag,undefined);
  assert.equal(fragments.bidder.openx,undefined);assert.equal(fragments.bidder.openx_ag.site.content.data[0].segment[0].id,'483');
  assert.deepEqual(fragments.bidder.openx_ag.source.ext.schain,schain);
  assert(context.snapshot().events.some(event=>event.kind==='adapter-route-unavailable'&&event.bidder==='teads_ag'));
  assert(context.snapshot().events.some(event=>event.kind==='mixed-taxonomy-skipped'&&event.bidder==='rubicon_ag'));
});
