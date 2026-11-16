import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {compileRuntime3221} from '../../worker/runtime-3221/compiler.mjs';
import {compileRuntime3222} from '../../worker/runtime-3222/compiler.mjs';
import {runtimeCatalog,previewInput,buildArtifactCandidate} from '../../worker/test-workspace/runtime-catalog.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';
import {runtime3222Source,sourceFiles} from '../../scripts/prepare-runtime3222.mjs';
import {sourceFiles as previousFiles} from '../../scripts/prepare-runtime3221.mjs';
import {fixture,configure,TS} from './artifact-fixture.mjs';
const descriptor=runtimeCatalog.find(r=>r.version==='3.22.2');
function functions(source) {
  const found=new Map();
  (function walk(n){if(!n||typeof n!=='object')return;
    if(n.type==='FunctionDeclaration')found.set(n.id.name,source.slice(n.start,n.end));
    for(const v of Object.values(n))if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==='object')walk(v);
  })(parse(source,{ecmaVersion:2015}));
  return found;
}
const inputs=new Map(),builds=new Map();
function generated(prebid=true,compiler=compileRuntime3222){
  const key=`${prebid}/${compiler.name}`;
  if(!inputs.has(prebid))inputs.set(prebid,previewInput(configure(fixture(),c=>{c.enablePrebid=prebid;}),descriptor,TS));
  if(!builds.has(key))builds.set(key,compiler(inputs.get(prebid)).adsJs);
  return builds.get(key);
}
/** Execute the actual generated lazy and request functions; deterministic DOM,
 * GPT and the readiness request boundary make observer order reproducible. */
function lab({prebid=true,compiler=compileRuntime3222}={}){
  let time=0,next=0;const tasks=new Map(),observers=[],requests=[],dispatches=[];
  const tick=ms=>{const end=time+ms;for(let guard=0;guard<10000;guard++){
    const item=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
    if(!item)break;tasks.delete(item[0]);time=item[1].at;item[1].fn();}time=end;};
  const slot={getSlotElementId:()=> 'P1',setConfig(){}},dom={id:'P1'};
  const c={window:{adSlots:{P1:slot}},document:{getElementById:()=>dom},HAS_PREBID:prebid,BIDDERS:prebid?[{bidder:'ix'}]:[],
    LAZY_PREFETCH_PIXELS_MOBILE:300,LAZY_PREFETCH_PIXELS_DESKTOP:600,LAZY_THRESHOLD:0,LAZY_DISPLAY_IN_VIEW_PCT:50,
    PREBID_TIMEOUT_BTF:1000,STICKY_TARGET_ID:'',STICKY_TOP_TARGET_ID:'',_auctionLock:Object.create(null),_refreshCounts:{},
    setTimeout(fn,ms=0){tasks.set(++next,{fn,at:time+ms});return next;},clearTimeout(id){tasks.delete(id);},normalizePx:String,isMobile:()=>false,
    slotHasCurrentViewportSizes:()=>true,tesseraLazyRule:()=>null,getUnitConfigById:()=>({type:'BTF'}),
    adUnitFromCode:code=>({code,bids:[{bidder:'ix'}]}),getAdUnitTimeoutMs:()=>1000,getTimeoutForSlot:()=>1000,
    log(){},applyPrebidTargetingToSlots(){},applyHbVerTargetingForSlots(){},googletag:{cmd:{push:fn=>fn()},pubads:()=>({})},
    pbjs:{removeAdUnit(){}},_tesseraReady:{request(pb,input){requests.push(input);},dispatch(pa,slots){dispatches.push(slots);}},
    IntersectionObserver:class{constructor(fn,options){this.fn=fn;this.options=options;this.unobserved=0;observers.push(this);}observe(){}unobserve(){this.unobserved++;}
      // A notification already queued by the browser can arrive after unobserve.
      fire(){this.fn([{target:dom,isIntersecting:true,intersectionRatio:1}],this);}}};
  c.window.pbjs=c.pbjs;vm.createContext(c);const source=functions(generated(prebid,compiler));
  vm.runInContext(['fetchBidsAndRefresh','wireLazyBtf'].map(name=>source.get(name)).join('\n')+'\nwireLazyBtf();',c);
  return {c,requests,dispatches,tick,fetch:()=>observers[0].fire(),display:()=>observers[1].fire(),
    complete(index=0){assert(requests[index],'An auction must exist before its callback');requests[index].bidsBackHandler();},
    counts(auctions,dispatch){assert.equal(requests.length,auctions,'Prebid auction count');assert.equal(dispatches.length,dispatch,'GAM dispatch count');}};
}
test('before-control: generated 3.22.1 reproduces one unused auction after display-first',()=>{
  const l=lab({compiler:compileRuntime3221});l.display();l.complete();l.fetch();l.tick(200);l.complete(1);l.counts(2,1);
});
test('display-first claims prefetch even after the first auction already completed',()=>{
  const l=lab();l.display();l.complete();l.fetch();l.fetch();l.tick(200);l.display();l.counts(1,1);
});
test('display-first and prefetch callbacks in the same observer turn have one owner',()=>{
  const l=lab();l.display();l.fetch();l.fetch();l.tick(200);l.counts(1,0);l.complete();l.display();l.counts(1,1);
});
test('prefetch queued before display waits for the existing 200ms batch and completes once',()=>{
  const l=lab();l.fetch();l.display();l.display();l.counts(0,0);l.tick(199);l.counts(0,0);l.tick(1);l.counts(1,0);
  l.fetch();l.complete();l.display();l.tick(1000);l.counts(1,1);
});
test('display waits for an inflight prefetch and ignores repeated and late callbacks',()=>{
  const l=lab();l.fetch();l.tick(200);l.display();l.fetch();l.counts(1,0);l.complete();l.complete();l.display();l.tick(200);l.counts(1,1);
});
test('completed prefetch does not dispatch until display is observed',()=>{
  const l=lab();l.fetch();l.tick(200);l.complete();l.counts(1,0);l.tick(2000);l.display();l.fetch();l.tick(200);l.counts(1,1);
});
test('GAM-only lazy display remains one dispatch and never starts Prebid',()=>{
  const l=lab({prebid:false});l.fetch();l.display();l.display();l.fetch();l.tick(200);l.counts(0,1);
});
test('the new compiler only patches lazy ownership; audited readiness and expiry handling stay identical',()=>{
  for(const prebid of [true,false]){
    const before=generated(prebid,compileRuntime3221),after=generated(prebid);
    const restored=after.replace('if (!id || prefetched[id] || displayed[id]) return;','if (!id || prefetched[id]) return;')
      .replace('if (!prefetched[id]){\n          prefetched[id] = true;\n          prefetchIO.unobserve(el);','if (!prefetched[id]){')
      .replace('if (displayed[c] || _auctionLock[c]) continue;','if (_auctionLock[c]) continue;');
    assert.equal(restored,before,'All non-lazy generated code is byte-identical');
    assert.equal(functions(after).get('createTesseraReadiness'),functions(before).get('createTesseraReadiness'));
  }
});
test('3.22.2 is explicitly selected preview with the complete immutable 3.22.1 source closure',async()=>{
  assert.equal(descriptor.channel,'preview');assert.throws(()=>pinRuntime(descriptor),/explicit opt-in/);
  assert.equal(runtimeReleaseHistory.find(r=>r.channel==='stable').version,'3.21.2');
  for(const file of previousFiles)assert(sourceFiles.includes(file),file);
  assert.equal((await runtime3222Source(process.cwd())).codeSha256,descriptor.codeSha256);
});
test('the catalog builds a complete 3.22.2 GAM-only package with exact version and both programs',async()=>{
  const snapshot=configure(fixture(),c=>{c.enablePrebid=false;});
  const result=await buildArtifactCandidate({snapshot,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:TS});
  assert.equal(result.manifest.runtime.runtimeVersion,'3.22.2');
  assert.equal(JSON.parse(new TextDecoder().decode(result.files['config.json'])).runtime.runtimeVersion,'3.22.2');
  for(const name of ['ads.js','ads.min.js'])assert.doesNotThrow(()=>parse(new TextDecoder().decode(result.files[name]),{ecmaVersion:2015}));
  assert(result.files['deals-plan.json']);assert(!result.files['prebid.js']);
});
