import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {createBidderRules} from '../../worker/runtime-322/browser-bidder-rules.mjs';
import {evaluateBidderRule, normalizeBidderRules} from '../../shared/bidder-rules/settings.mjs';
import {normalizeCountry} from '../../shared/geo-country.mjs';
import {createContextualSignals} from '../../worker/runtime-321/browser-contextual.mjs';
import {contextualCompletionHook} from '../../worker/runtime-321/compiler.mjs';
import {createGamReporting} from '../../worker/runtime-reporting-v1/browser-reporting.mjs';
import {createTesseraReadiness} from '../../worker/runtime-3161/browser-readiness.mjs';
import {compileRuntime322} from '../../worker/runtime-322/compiler.mjs';
import {previewInput} from '../../worker/runtime-322/snapshot.mjs';
import {buildArtifactCandidate} from '../../worker/runtime-322/artifact-candidate.mjs';
import {descriptor} from '../../.generated/runtime-322-manifest.mjs';
import {fixture, configure, checkedFixture} from './artifact-fixture.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const rule = (overrides = {}) => ({id:'ix-rs', name:'IX Serbia', enabled:true, bidder:'ix', positions:[],
  countries:{mode:'include', values:['RS'], unknown:'skip'}, devices:['mobile','tablet','desktop'], ...overrides});
const settings = (...rules) => normalizeBidderRules({schemaVersion:1,enabled:true,rules:rules.length ? rules : [rule()]});
const unit = (code='P1', bidders=['ix','openx']) => ({code, mediaTypes:{banner:{sizes:[[300,250]]}}, bids:bidders.map(bidder=>({bidder,params:{placement:code}}))});
const known = country => ({version:1,status:'known',source:'cloudflare',country});
function harness(config=settings(), nativeRequest) {
  const sent=[];
  const win={innerWidth:1280,__AD_GEO:{version:1,getSnapshot:()=>known('DE'),ready(){throw Error('Must never await GEO');}}};
  const pb={requestBids(request){assert.equal(this,pb);sent.push(request);return nativeRequest ? nativeRequest(request) : 'native-result';}};
  const helper=createBidderRules(win,config,{evaluate:evaluateBidderRule,normalizeCountry,request:(pb,input)=>pb.requestBids(input)});
  return {helper,win,pb,sent};
}

test('filters final request entries exactly and preserves fields, aliases, deal/SChain data and configured arrays',()=>{
  const state=harness();
  const schain={ver:'1.0',complete:1,nodes:[{asi:'publisher.invalid',sid:'fixture-seller',hp:1}]};
  const input={auctionId:'a',adUnits:[unit()],ortb2:{source:{ext:{schain}}}};
  input.adUnits[0].bids.push({bidder:'ixAlias',params:{dealId:'direct'},ortb2:{site:{name:'kept'}}});
  const before=plain(input);Object.freeze(input.adUnits[0].bids);Object.freeze(input.adUnits);
  assert.equal(state.helper.request(state.pb,input),'native-result');
  assert.deepEqual(state.sent[0].adUnits[0].bids.map(b=>b.bidder),['openx','ixAlias']);
  assert.equal(state.sent[0].adUnits[0].bids[1],input.adUnits[0].bids[2]);
  assert.equal(state.sent[0].ortb2.source.ext.schain,schain);
  assert.deepEqual(input,before);
  assert.equal(state.sent[0].adUnits[0].mediaTypes,input.adUnits[0].mediaTypes);
});

test('OFF is exact pass-through; scope-specific policy wins; unmatched bidders and positions remain allowed',()=>{
  const off=harness({...settings(),enabled:false}),input={adUnitCodes:['P1']};
  off.helper.request(off.pb,input);assert.equal(off.sent[0],input);assert.equal(off.helper.snapshot().requests,0);
  const state=harness(settings(rule(),rule({id:'p1',name:'P1 all countries',positions:['P1'],countries:{mode:'all',values:[],unknown:'skip'}})));
  state.helper.request(state.pb,{adUnits:[unit('P1'),unit('P2')]});
  assert.deepEqual(state.sent[0].adUnits.map(u=>[u.code,u.bids.map(b=>b.bidder)]),[['P1',['ix','openx']],['P2',['openx']]]);
});

test('fresh natural auctions see current country and viewport; pending/unknown never waits or forces traffic',()=>{
  const state=harness(settings(rule({devices:['desktop']})));
  state.win.__AD_GEO.getSnapshot=()=>({version:1,status:'pending',country:null});
  state.helper.request(state.pb,{adUnits:[unit()]});
  assert.equal(state.helper.snapshot().events[0].reason,'country-unknown-skipped');
  state.win.__AD_GEO.getSnapshot=()=>known('RS');
  state.helper.request(state.pb,{adUnits:[unit()]});
  state.win.innerWidth=767;state.helper.request(state.pb,{adUnits:[unit()]});
  assert.deepEqual(state.sent.map(r=>r.adUnits[0].bids.map(b=>b.bidder)),[['openx'],['ix','openx'],['openx']]);
  assert.equal(state.helper.snapshot().events[4].reason,'layout-excluded');
});

test('untrusted GEO shape, unsupported country and throwing getters use explicit unknown-country behavior',()=>{
  const state=harness(settings(rule({countries:{mode:'include',values:['RS'],unknown:'allow'}})));
  for(const snapshot of [known('XX'),{...known('RS'),version:2},{...known('RS'),source:'other'},null]){
    state.win.__AD_GEO.getSnapshot=()=>snapshot;state.helper.request(state.pb,{adUnits:[unit()]});
    assert.equal(state.helper.snapshot().events.at(-2).reason,'country-unknown-allowed');
  }
  Object.defineProperty(state.win,'__AD_GEO',{get(){throw Error('foreign property');}});
  state.helper.request(state.pb,{adUnits:[unit()]});
  assert.equal(state.sent.length,5);assert.equal(state.helper.snapshot().context.country,null);
});

test('all denied returns promptly without a native auction; mixed units retain only eligible native units',()=>{
  const state=harness();let result;
  state.helper.request(state.pb,{auctionId:'empty',adUnits:[unit('P1',['ix'])],bidsBackHandler(...args){result=args;}});
  assert.equal(state.sent.length,0);assert.deepEqual(result,[{},false,'empty']);
  state.helper.request(state.pb,{auctionId:'mixed',adUnits:[unit('P1',['ix']),unit('P2')],adUnitCodes:['P1','P2']});
  assert.deepEqual(state.sent[0].adUnits.map(u=>u.code),['P2']);assert.deepEqual(state.sent[0].adUnitCodes,['P2']);
});

test('callback response guard preserves receiver/signature/return and removes unsolicited excluded bidder',()=>{
  const state=harness();let seen;
  state.helper.request(state.pb,{auctionId:'a',adUnits:[unit()],bidsBackHandler(...args){seen={receiver:this,args};return 'callback-result';}});
  const receiver={custom:true},bids={P1:{bids:[{bidderCode:'ix',adId:'excluded'},{bidderCode:'openx',adId:'allowed'}]}};
  assert.equal(state.sent[0].bidsBackHandler.call(receiver,bids,false,'a','extra'),'callback-result');
  assert.equal(seen.receiver,receiver);assert.deepEqual(seen.args.slice(1),[false,'a','extra']);
  assert.deepEqual(seen.args[0].P1.bids,[bids.P1.bids[1]]);assert.equal(bids.P1.bids.length,2);
});

test('prototype-shaped and punctuation codes are exact, with independent response filtering',()=>{
  const state=harness(),codes=['__proto__','constructor','m.box_1','a/b%é'];
  state.helper.request(state.pb,{adUnits:codes.map(code=>unit(code)),bidsBackHandler(bids){
    assert.deepEqual(Object.keys(bids),codes);
    for(const code of codes)assert.deepEqual(bids[code].bids,[{bidderCode:'openx'}]);
  }});
  const responses=Object.create(null);for(const code of codes)responses[code]={bids:[{bidderCode:'ix'},{bidderCode:'openx'}]};
  state.sent[0].bidsBackHandler(responses,false,'a');assert.deepEqual(state.sent[0].adUnits.map(u=>u.code),codes);
});

test('debug stays bounded and detached; simulation cannot send requests or alter observed decisions',()=>{
  const state=harness();for(let i=0;i<120;i++)state.helper.request(state.pb,{auctionId:String(i),adUnits:[unit()]});
  const report=state.helper.snapshot();assert.equal(report.events.length,200);assert.equal(report.dropped,40);
  report.events[0].reason='edited';assert.notEqual(state.helper.snapshot().events[0].reason,'edited');
  const before=state.helper.snapshot();assert.equal(state.win.__AD_BIDDER_RULES.simulate({bidder:'ix',code:'P1',country:'RS',width:1024}).allowed,true);
  assert.deepEqual(state.helper.snapshot(),before);assert.equal(state.sent.length,120);
});

function integration(config=settings(), transform=input=>input, {retry=false,nativeCache=false}={}) {
  const queue=new Map(),listeners=new Set(),sent=[],requests=[];
  let timer=0,cmp,pps,geo=known('DE');const nativeTargets=Object.create(null),slots=Object.create(null),latest=Object.create(null),cache=[],pbConfig={useBidCache:true};
  const win={innerWidth:1280,adsKeywords:{category:'Sports'},__AD_GEO:{version:1,getSnapshot:()=>geo},
    setTimeout(fn,delay){queue.set(++timer,{fn,delay});return timer;},clearTimeout(id){queue.delete(id);},
    __tcfapi(command,version,callback){cmp=callback;},googletag:{setConfig(value){pps=value.pps;}}};
  function slot(code){if(!slots[code])slots[code]={id:code,targeting:{hb_adid:'previous',aq_bid_count:'previous'},setConfig({targeting}){for(const [key,value]of Object.entries(targeting)){if(value===null)delete this.targeting[key];else this.targeting[key]=value;}}};return slots[code];}
  const service={refresh(list){sent.push({slots:list.map(s=>({code:s.id,targeting:{...s.targeting}})),pps:plain(pps)});}};
  const pb=win.pbjs={setConfig(value){Object.assign(pbConfig,value);},getConfig(key){return key?pbConfig[key]:pbConfig;},onEvent(name,fn){listeners.add(fn);},offEvent(name,fn){listeners.delete(fn);},
    requestBids(input){requests.push(input);const codes=input.adUnits.map(u=>u.code);for(const code of codes)latest[code]=input.auctionId;[...listeners].forEach(fn=>fn({auctionId:input.auctionId,adUnitCodes:codes}));},
    getAdserverTargetingForAdUnitCode(code){
      if(!nativeCache)return nativeTargets[code]||{};
      // Match the native documented cache-hook boundary: it sees prior bids,
      // never current bids; native selection still chooses each bidder's best.
      const bids=cache.filter(b=>b.adUnitCode===code&&(b.auctionId===latest[code]||pbConfig.useBidCache&&(!pbConfig.bidCacheFilterFunction||pbConfig.bidCacheFilterFunction(b)))).sort((a,b)=>b.cpm-a.cpm||(a.timeToRespond||0)-(b.timeToRespond||0));
      if(!bids.length)return {};const target={hb_adid:bids[0].adId,hb_bidder:bids[0].bidderCode};
      for(const bid of bids)if(!target['hb_adid_'+bid.bidderCode])target['hb_adid_'+bid.bidderCode]=bid.adId;
      return target;
    }};
  const reporting=createGamReporting({code:s=>s.id,owns:()=>true,prebid:()=>true});
  const context=createContextualSignals(win,{enabled:true,sourceKey:'category',providerName:'publisher.invalid',gam:{enabled:true},bidders:[],mappings:[{value:'Sports',taxonomies:{'iab-content-2.2':['483']}},{value:'Books',taxonomies:{'iab-content-2.2':['42']}}]},
    {request:(pb,input)=>reporting.request(pb,transform(input)),dispatch:reporting.dispatch,code:s=>s.id});
  const helper=createBidderRules(win,config,{evaluate:evaluateBidderRule,normalizeCountry,request:context.request});
  const readiness=vm.runInNewContext('('+contextualCompletionHook(createTesseraReadiness.toString())+')');
  const ready=readiness(win,{rawRequest:helper.request,rawDispatch:context.dispatch,contextFinished:context.finished,
    clear:s=>{for(const key of Object.keys(s.targeting))if(key.startsWith('hb_'))delete s.targeting[key];},apply:(s,target)=>Object.assign(s.targeting,target),code:s=>s.id,
    discard:codes=>reporting.discard(codes.map(slot)), configure:helper.configurePrebid, ...(retry?{unit:code=>unit(code)}:{})});
  function flush(){for(let i=0;i<100;i++){const task=[...queue].find(([,t])=>t.delay===0);if(!task)return;queue.delete(task[0]);task[1].fn();}throw Error('Unbounded work');}
  function request(units){ready.request(pb,{adUnits:units,bidsBackHandler(){ready.dispatch(service,units.map(u=>slot(u.code)));}});flush();}
  function complete(index,rows={}){const req=requests[index],bids={};for(const [code,items]of Object.entries(rows))bids[code]={bids:items.map(item=>({auctionId:req.auctionId,adUnitCode:code,cpm:1,ttl:60,responseTimestamp:Date.now(),...item}))};cache.push(...Object.values(bids).flatMap(row=>row.bids));req.bidsBackHandler(bids,false,req.auctionId);flush();}
  return {win,pb,pbConfig,ready,helper,requests,sent,queue,request,complete,nativeTargets,flush,consent:value=>cmp(value,true),setCountry:country=>{geo=known(country);}};
}

test('real readiness + reporting + PPS: consent blocks; all skipped sends GAM immediately with no stale HB/auction labels',()=>{
  const state=integration();state.request([unit('P1',['ix'])]);assert.equal(state.sent.length,0);assert.equal(state.requests.length,0);
  state.consent({gdprApplies:false});state.flush();
  assert.equal(state.requests.length,0);assert.equal(state.sent.length,1);
  assert.deepEqual(state.sent[0].pps.taxonomies.IAB_CONTENT_2_2.values,['483']);
  assert.equal(state.sent[0].slots[0].targeting.hb_adid,undefined);assert.equal(state.sent[0].slots[0].targeting.aq_bid_count,undefined);
  assert(![...state.queue.values()].some(task=>task.delay===10000));
});

test('mixed all-skipped + active units preserve GAM/PPS delivery and current auction counts per original position',()=>{
  const state=integration();state.consent({gdprApplies:false});state.request([unit('P1',['ix']),unit('P2')]);
  assert.deepEqual(state.requests[0].adUnits.map(u=>u.code),['P2']);
  state.nativeTargets.P2={hb_adid:'allowed',hb_bidder:'openx'};
  state.complete(0,{P2:[{bidderCode:'openx',adId:'allowed'}]});
  assert.equal(state.sent.length,1);assert.deepEqual(state.sent[0].slots.map(s=>s.code),['P1','P2']);
  assert.equal(state.sent[0].slots[0].targeting.hb_adid,undefined);assert.equal(state.sent[0].slots[0].targeting.aq_bid_count,'0');
  assert.equal(state.sent[0].slots[1].targeting.hb_adid,'allowed');assert.equal(state.sent[0].slots[1].targeting.aq_bid_count,'1');
});

test('native cached/unsolicited excluded targeting cannot reach GAM, including Send All Bids IDs',()=>{
  for(const poison of ['cached','unsolicited','send-all']){
    const state=integration();state.consent({gdprApplies:false});state.setCountry('RS');state.request([unit()]);
    state.nativeTargets.P1={hb_adid:'old-ix',hb_bidder:'ix'};state.complete(0,{P1:[{bidderCode:'ix',adId:'old-ix'}]});
    assert.equal(state.sent[0].slots[0].targeting.hb_adid,'old-ix');
    state.setCountry('DE');state.request([unit()]);
    const response=[{bidderCode:'openx',adId:'new-openx'}];
    if(poison==='unsolicited')response.push({bidderCode:'ix',adId:'new-ix'});
    state.nativeTargets.P1=poison==='cached'?{hb_adid:'old-ix'}:poison==='unsolicited'?{hb_adid:'new-ix'}:{hb_adid:'new-openx',hb_adid_ix:'old-ix'};
    state.complete(1,{P1:response});
    assert.equal(state.sent.length,2);assert(!Object.keys(state.sent[1].slots[0].targeting).some(key=>key.startsWith('hb_')),poison);
    assert.deepEqual(state.requests[1].adUnits[0].bids.map(b=>b.bidder),['openx']);
  }
});

test('concurrent natural auctions keep their own eligibility and category without global bidder configuration mutation',()=>{
  const state=integration();state.consent({gdprApplies:false});state.setCountry('RS');state.request([unit('P1')]);
  state.setCountry('DE');state.win.adsKeywords.category='Books';state.request([unit('P2')]);
  assert.deepEqual(state.requests.map(r=>r.adUnits[0].bids.map(b=>b.bidder)),[['ix','openx'],['openx']]);
  state.nativeTargets.P2={hb_adid:'book'};state.complete(1,{P2:[{bidderCode:'openx',adId:'book'}]});
  state.nativeTargets.P1={hb_adid:'sport'};state.complete(0,{P1:[{bidderCode:'ix',adId:'sport'}]});
  assert.deepEqual(state.sent.map(s=>s.pps.taxonomies.IAB_CONTENT_2_2.values),[['42'],['483']]);
});

function findNodes(source,predicate){const matches=[];function visit(node){if(!node||typeof node!=='object')return;if(predicate(node))matches.push(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);}}visit(parse(source,{ecmaVersion:2015}));return matches;}

test('compiled responsive Outstream callback cannot restore excluded PubMatic, in pure and banner+video units',()=>{
  const snapshot=configure(fixture(),config=>{config.runtimeControls.bidderRules=settings(rule({bidder:'pubmatic'}));});
  const input=previewInput(snapshot,descriptor,'20261112_100000');const source=compileRuntime322(input).adsJs;
  assert.match(source,/rawRequest:_adBidderRules.request,rawDispatch:_adContext.dispatch/);
  const nodes=findNodes(source,node=>node.type==='VariableDeclarator'&&node.id?.name==='_adContext');assert.equal(nodes.length,1);
  const request=nodes[0].init.arguments[2].properties.find(p=>p.key.name==='request').value;
  for(const bidders of [['pubmatic'],['pubmatic','openx']]){
    const sent=[],original=unit('P1',bidders);original.mediaTypes.video={context:'outstream',playerSize:[[300,250]]};
    const inherited=vm.runInNewContext('('+source.slice(request.start,request.end)+')',{
      TESSERA_OUTSTREAM:{units:{P1:{playerSizing:'size-map'}}},adUnitFromCode:()=>original,
      _gamReporting:{request:(pb,next)=>pb.requestBids(next)},
    });
    const state=harness(settings(rule({bidder:'pubmatic'})));
    const helper=createBidderRules(state.win,settings(rule({bidder:'pubmatic'})),{evaluate:evaluateBidderRule,normalizeCountry,request:inherited});
    let completed=0;helper.request({requestBids(next){sent.push(next);}},{adUnits:[unit('P1',['already-filtered'])],bidsBackHandler(){completed++;}});
    if(bidders.length===1){assert.equal(sent.length,0);assert.equal(completed,1);}
    else{assert.deepEqual(plain(sent[0].adUnits[0].bids.map(b=>b.bidder)),['openx']);assert.equal(sent[0].adUnits[0].mediaTypes,original.mediaTypes);}
    assert.deepEqual(original.bids.map(b=>b.bidder),bidders);
  }
});

test('every compiled readiness request supplies explicit adUnits, including retry and refresh paths',()=>{
  const source=compileRuntime322(previewInput(fixture(),descriptor,'20261112_100000')).adsJs;
  const calls=findNodes(source,node=>node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&node.callee.object.name==='_tesseraReady'&&node.callee.property.name==='request');
  assert(calls.length>=3);
  for(const node of calls){assert.equal(node.arguments[1].type,'ObjectExpression');assert(node.arguments[1].properties.some(p=>p.key.name==='adUnits'));}
});

test('3.22 packages retain normalized rules, exact unit codes and unchanged SChain; GAM-only preserves rules but disables filtering',async()=>{
  for(const enablePrebid of [true,false]){
    const snapshot=configure(fixture(),config=>{config.enablePrebid=enablePrebid;config.runtimeControls.bidderRules=settings(rule({positions:['P1']}));config.runtimeControls.schain={ver:'1.0',complete:1,nodes:[{asi:'publisher.invalid',sid:'fixture-seller',hp:1}]};});
    const before=plain(snapshot),prebid=enablePrebid?await checkedFixture(snapshot):null;
    const bundle=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:'20261112_100000',prebid});
    const config=JSON.parse(new TextDecoder().decode(bundle.files['config.json']));
    assert.equal(config.bidderRules.enabled,enablePrebid);assert.deepEqual(config.bidderRules.rules,settings(rule({positions:['P1']})).rules);
    assert.equal(config.options.schain.nodes[0].sid,'fixture-seller');assert.deepEqual(snapshot,before);
    assert.match(new TextDecoder().decode(bundle.files['README.txt']),/__AD_BIDDER_RULES/);
    parse(new TextDecoder().decode(bundle.files['ads.min.js']),{ecmaVersion:2015});
  }
});

test('scoped native cache hook preserves prior filter receiver/results/errors, enablement, and foreign auction ownership',()=>{
  const state=harness(),config={useBidCache:true},listeners=new Set(),calls=[],writes=[];
  const prior=function(...args){calls.push({receiver:this,args});if(args[0].adId==='throws')throw Error('prior failure');return args[0].adId!=='prior-denied';};
  config.bidCacheFilterFunction=prior;
  const pb={getConfig:key=>config[key],setConfig(value){writes.push(value);Object.assign(config,value);},onEvent:(name,fn)=>listeners.add(fn),offEvent:(name,fn)=>listeners.delete(fn),
    requestBids(input){for(const fn of listeners)fn({auctionId:input.auctionId,adUnitCodes:input.adUnits.map(u=>u.code)});}};
  state.helper.configurePrebid(pb);state.helper.configurePrebid(pb);assert.equal(writes.length,1);assert.equal(config.useBidCache,true);
  state.helper.request(pb,{auctionId:'owned',adUnits:[unit('P1'),unit('P2')]});assert.equal(writes.length,1);
  const receiver={marker:true},bid={adUnitCode:'P1',bidderCode:'ix',adId:'old'};
  assert.equal(config.bidCacheFilterFunction.call(receiver,bid,'extra'),false);assert.equal(calls.at(-1).receiver,receiver);assert.equal(calls.at(-1).args[1],'extra');
  assert.equal(config.bidCacheFilterFunction({...bid,bidderCode:'openx'}),false,'Even an eligible old bidder must not mask the current auction');
  assert.equal(config.bidCacheFilterFunction({...bid,bidderCode:'openx',auctionId:'owned'}),true);
  assert.equal(config.bidCacheFilterFunction({...bid,bidderCode:'openx',adId:'prior-denied'}),false);
  assert.throws(()=>config.bidCacheFilterFunction({...bid,adId:'throws'}),/prior failure/);
  state.win.__AD_GEO.getSnapshot=()=>known('RS');
  assert.equal(config.bidCacheFilterFunction(bid),false,'Captured auction country remains DE until another natural auction');
  for(const fn of listeners)fn({auctionId:'foreign',adUnitCodes:['P1']});
  assert.equal(config.bidCacheFilterFunction(bid),true,'Foreign ownership restores original filter result');
  assert.equal(config.bidCacheFilterFunction({...bid,adUnitCode:'P2'}),false,'Other owned positions keep their scope');
  let foreignCalls=0;const later=()=>{foreignCalls++;return false;};config.bidCacheFilterFunction=later;
  state.helper.request(pb,{auctionId:'next',adUnits:[unit('P1')]});
  assert.equal(config.bidCacheFilterFunction(bid),false);assert.equal(foreignCalls,1);assert.equal(writes.length,2);
  assert(writes.every(value=>Object.keys(value).join(',')==='bidCacheFilterFunction'));
});

test('cache context storage is bounded while unrelated cached bidders retain original behavior',()=>{
  const state=harness(),config={},listeners=[];
  const pb={getConfig:key=>config[key],setConfig:value=>Object.assign(config,value),onEvent:(name,fn)=>listeners.push(fn),requestBids(input){listeners.forEach(fn=>fn({auctionId:input.auctionId,adUnitCodes:input.adUnits.map(u=>u.code)}));}};
  state.helper.configurePrebid(pb);
  for(let i=0;i<140;i++)state.helper.request(pb,{auctionId:String(i),adUnits:[unit('position-'+i)]});
  assert.equal(state.helper.snapshot().trackedAuctions,128);
  assert.equal(config.bidCacheFilterFunction({adUnitCode:'position-139',bidderCode:'ix'}),false);
  assert.equal(config.bidCacheFilterFunction({adUnitCode:'foreign-slot',bidderCode:'ix'}),true);
});

test('current-auction cache policy retains fresh eligible bids despite equal or higher CPM from older eligible bids',()=>{
  for(const oldCpm of [1,5]){
    const state=integration(settings(),input=>input,{retry:true,nativeCache:true});
    state.consent({gdprApplies:false});state.setCountry('RS');state.request([unit()]);
    state.complete(0,{P1:[{bidderCode:'ix',adId:'old-high',cpm:10},{bidderCode:'openx',adId:'old-eligible',cpm:oldCpm,timeToRespond:78}]});
    assert.equal(state.sent[0].slots[0].targeting.hb_adid,'old-high');
    state.setCountry('DE');state.request([unit()]);state.complete(1,{P1:[{bidderCode:'openx',adId:'fresh-allowed',cpm:1,timeToRespond:99}]});
    assert.equal(state.sent[1].slots[0].targeting.hb_adid,'fresh-allowed');
    assert.equal(state.sent[1].slots[0].targeting.hb_adid_ix,undefined);
    assert.equal(state.requests.length,2,'No unnecessary expired-target retry');assert.equal(state.pbConfig.useBidCache,true);
    assert.equal(state.helper.snapshot().cachePolicy,'current-auction-for-rule-positions');
  }
});

test('actual readiness retry is still filtered and bounded when native targeting remains incompatible',()=>{
  const state=integration(settings(),input=>input,{retry:true});state.consent({gdprApplies:false});state.request([unit()]);
  state.nativeTargets.P1={hb_adid:'foreign-cache'};state.complete(0,{P1:[{bidderCode:'openx',adId:'valid'}]});
  assert.equal(state.requests.length,2);assert.equal(state.sent.length,0);
  assert.deepEqual(state.requests[1].adUnits[0].bids.map(b=>b.bidder),['openx']);
  state.complete(1,{P1:[{bidderCode:'openx',adId:'replacement'}]});
  assert.equal(state.requests.length,2);assert.equal(state.sent.length,1);assert(!Object.keys(state.sent[0].slots[0].targeting).some(key=>key.startsWith('hb_')));
});

test('same-code reverse completions keep each response policy and corresponding PPS without resurrecting denied bids',()=>{
  const state=integration();state.consent({gdprApplies:false});state.setCountry('RS');state.request([unit()]);
  state.setCountry('DE');state.win.adsKeywords.category='Books';state.request([unit()]);
  state.nativeTargets.P1={hb_adid:'book'};state.complete(1,{P1:[{bidderCode:'openx',adId:'book'},{bidderCode:'ix',adId:'unsolicited'}]});
  state.nativeTargets.P1={hb_adid:'sport'};state.complete(0,{P1:[{bidderCode:'ix',adId:'sport'}]});
  assert.deepEqual(state.sent.map(s=>[s.slots[0].targeting.hb_adid,s.pps.taxonomies.IAB_CONTENT_2_2.values]),[['book',['42']],['sport',['483']]]);
  assert.deepEqual(state.requests.map(r=>r.adUnits[0].bids.map(b=>b.bidder)),[['ix','openx'],['openx']]);
});

test('explicit null and default undefined cache hooks both install exactly once',()=>{
  for(const initial of [null,undefined]){
    const state=harness(),config={bidCacheFilterFunction:initial},writes=[];
    const pb={getConfig:key=>config[key],setConfig(value){writes.push(value);Object.assign(config,value);},onEvent(){},requestBids(){}};
    state.helper.configurePrebid(pb);state.helper.request(pb,{auctionId:'one',adUnits:[unit()]});
    assert.equal(typeof config.bidCacheFilterFunction,'function');assert.equal(writes.length,1);assert.equal(state.helper.snapshot().cacheFilter,'installed');
  }
});

test('Prebid replacement detaches old scope and restores only its own installed hook',()=>{
  for(const foreignWrap of [false,true]){
    const state=harness();
    function prebid(){const config={bidCacheFilterFunction:null},listeners=[];return {config,listeners,getConfig:key=>config[key],setConfig:value=>Object.assign(config,value),onEvent:(name,fn)=>listeners.push(fn),
      requestBids(input){listeners.forEach(fn=>fn({auctionId:input.auctionId,adUnitCodes:input.adUnits.map(u=>u.code)}));}};}
    const oldPb=prebid(),newPb=prebid();state.helper.configurePrebid(oldPb);state.helper.request(oldPb,{auctionId:'old',adUnits:[unit()]});
    const oldOwn=oldPb.config.bidCacheFilterFunction,foreign=bid=>oldOwn(bid);if(foreignWrap)oldPb.config.bidCacheFilterFunction=foreign;
    state.helper.configurePrebid(newPb);state.helper.request(newPb,{auctionId:'new',adUnits:[unit()]});
    assert.equal(newPb.config.bidCacheFilterFunction({adUnitCode:'P1',bidderCode:'ix'}),false);
    if(foreignWrap){assert.equal(oldPb.config.bidCacheFilterFunction,foreign);assert.equal(foreign({adUnitCode:'P1',bidderCode:'ix'}),true);}
    else assert.equal(oldPb.config.bidCacheFilterFunction,null);
    assert.equal(oldOwn({adUnitCode:'P1',bidderCode:'ix'}),true,'Detached callbacks have no new Prebid ownership');
    oldPb.listeners.forEach(fn=>fn({auctionId:'old-foreign',adUnitCodes:['P1']}));
    assert.equal(newPb.config.bidCacheFilterFunction({adUnitCode:'P1',bidderCode:'ix'}),false,'Old event callbacks cannot clear new ownership');
  }
});

test('fresh-only cache compatibility is limited to positions with an active matching rule',()=>{
  for(const enabled of [true,false]){
    const state=harness(settings(rule({positions:['P1'],enabled}))),config={},listeners=[];
    const pb={getConfig:key=>config[key],setConfig:value=>Object.assign(config,value),onEvent:(name,fn)=>listeners.push(fn),
      requestBids(input){listeners.forEach(fn=>fn({auctionId:input.auctionId,adUnitCodes:input.adUnits.map(u=>u.code)}));}};
    state.helper.configurePrebid(pb);state.helper.request(pb,{auctionId:'owned',adUnits:[unit('P1'),unit('P2')]});
    const cached={adUnitCode:'P1',bidderCode:'openx',auctionId:'earlier'};
    assert.equal(config.bidCacheFilterFunction(cached),!enabled,'Only active position rule changes its owned cache scope');
    assert.equal(config.bidCacheFilterFunction({...cached,adUnitCode:'P2'}),true,'Unrelated owned position keeps its prior filter');
    assert.equal(config.bidCacheFilterFunction({...cached,adUnitCode:'unowned'}),true);
    listeners.forEach(fn=>fn({auctionId:'foreign',adUnitCodes:['P1']}));
    assert.equal(config.bidCacheFilterFunction(cached),true,'Foreign auction restores original cache semantics');
  }
});
