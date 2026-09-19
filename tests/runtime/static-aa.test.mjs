import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {unzipSync} from 'fflate';
import {AA_RELEASE,bootStaticAA,instrumentFullRuntime} from '../../worker/experiments/static-aa-v1.mjs';
const root=new URL('../../',import.meta.url),read=p=>readFileSync(new URL(p,root));
const manifest=JSON.parse(read('.generated/tanjug-aa/deploy/release.json')),config=manifest.config;
function fixture(variant='A',patch={}) {
 const inserted=[],listeners={},timers=new Map();let seq=0,draws=0;
 const tag={src:'https://cdn.example.com/ads.js',nonce:'nonce'},pbjs={version:config.prebidVersion};
 const document={currentScript:tag,baseURI:'https://www.tanjug.rs/',readyState:'complete',scripts:[tag],
  createElement:()=>({}),head:{appendChild:s=>inserted.push(s)},addEventListener:(e,cb)=>listeners[e]=cb};
 const slots=[],win={pbjs,crypto:{getRandomValues(a){draws++;a[0]=variant==='A'?0:4294967295;return a;}},
  googletag:{cmd:{push(cb){cb();}},pubads:()=>({getSlots:()=>slots,addEventListener(){}})},...patch};
 const context=vm.createContext({window:win,document,URL,Uint32Array,WeakSet,Date,console,config,
  setTimeout:cb=>{timers.set(++seq,cb);return seq;},clearTimeout:id=>timers.delete(id),
  setInterval:cb=>{timers.set(++seq,cb);return seq;},clearInterval:id=>timers.delete(id)});
 const run=()=>vm.runInContext('('+bootStaticAA.toString()+')(config)',context);
 run();return {win,document,inserted,run,draws:()=>draws,timers,context,slots};
}
test('archive includes all 19 positions and byte-identical A/A arms with exact integrity',()=>{
 const zip=unzipSync(read('.generated/tanjug-aa/'+AA_RELEASE+'.zip'));
 assert.equal(config.positions.length,19);assert(config.positions.includes('InText_5'));assert(config.positions.includes('P8'));
 assert.deepEqual(zip[config.arms.A.path],zip[config.arms.B.path]);
 assert.equal('sha256-'+createHash('sha256').update(zip[config.arms.A.path]).digest('base64'),config.arms.A.integrity);
 for(const [name,item] of Object.entries(manifest.files))assert.equal(createHash('sha256').update(zip[name]).digest('hex'),item.sha256,name);
 const stop=unzipSync(read('.generated/tanjug-aa/'+AA_RELEASE+'-stop.zip'));
 assert.equal(createHash('sha256').update(stop['ads.js']).digest('hex'),manifest.baseAdsSha256);
 assert.deepEqual(stop['prebid.js'],zip['prebid.js']);
});
for(const variant of ['A','B'])test(variant+': single selection, matching SRI, persistent targeting, blocked duplicate entry',()=>{
 const f=fixture(variant),api=f.win.__adVariantDelivery;
 assert.equal(f.inserted.length,1);assert.equal(f.inserted[0].src,'https://cdn.example.com/'+config.arms[variant].path);
 assert.equal(f.inserted[0].integrity,config.arms[variant].integrity);assert.equal(f.inserted[0].nonce,'nonce');
 assert.equal(api.enter(),true);assert.equal(api.enter(),false);
 const slot={value:null,setConfig(c){this.value=c.targeting.Variant;},getConfig(){return {targeting:{Variant:this.value}};},getSlotElementId(){return 'P1';}};
 f.slots.push(slot);api.apply(slot);api.apply(slot);f.inserted[0].onload();f.run();
 assert.equal(api.snapshot().status,'loaded');assert.equal(slot.value,variant);assert.equal(api.snapshot().appliedSlots,1);
 assert.equal(api.snapshot().runtimeEntries,1);assert.equal(api.snapshot().blockedRuntimeEntries,1);
 assert.equal(api.snapshot().blockedDuplicateLoaders,1);assert.equal(f.draws(),1);assert.equal(f.inserted.length,1);
});
test('existing runtime and wrong Prebid stop before an arm is requested',()=>{
 for(const patch of [{__TESSERA_RUNTIME_STARTED:{}},{__tesseraExperimentOwner:'other'},{pbjs:{version:'10.10.0'}}]){
  const f=fixture('A',patch);assert.equal(f.inserted.length,0);assert.equal(f.win.AdVariant.snapshot().status,'error');
 }
});
test('native Prebid v-prefixed version is accepted and normalized',()=>{
 const f=fixture('A',{pbjs:{version:'v11.34.0'}});
 assert.equal(f.inserted.length,1);assert(f.inserted[0].src.endsWith('/A.js'));
 assert.equal(f.win.AdVariant.snapshot().prebidVersion,'11.34.0');
});
test('missing dependency is loaded once before arm and dependency failure cannot launch an arm',()=>{
 const f=fixture('B',{pbjs:undefined});assert.equal(f.inserted.length,1);assert(f.inserted[0].src.endsWith('/prebid.js'));
 f.win.pbjs={version:config.prebidVersion};f.inserted[0].onload();assert.equal(f.inserted.length,2);
 const bad=fixture('A',{pbjs:undefined});bad.inserted[0].onerror();assert.equal(bad.win.AdVariant.snapshot().error,'prebid-load-error');
 assert.equal(bad.inserted.length,1);assert.equal(bad.win.__adVariantDelivery.enter(),false);
});
test('dependency timeout prevents late runtime entry',()=>{
 const f=fixture('A',{pbjs:undefined});
 const state=f.win.AdVariant.snapshot();assert.equal(state.status,'waiting-prebid');
 for(const cb of [...f.timers.values()])cb();
 f.win.pbjs={version:config.prebidVersion};assert.equal(f.win.__adVariantDelivery.enter(),false);
 assert.equal(f.win.AdVariant.snapshot().status,'error');
});
test('instrumentation preserves the entire original source outside exactly two reviewed insertions',()=>{
 const source=read('.generated/tanjug-pilot/ads.js').toString(),newSource=instrumentFullRuntime(source);
 const prefix=`if (!window.__adVariantDelivery || window.__adVariantDelivery.release !== ${JSON.stringify(AA_RELEASE)} || !window.__adVariantDelivery.enter()) return;\n    `;
 assert.equal(newSource.replace(prefix,'').replace('\n                    window.__adVariantDelivery.apply(slot);',''),source);
 assert.throws(()=>instrumentFullRuntime('arbitrary source'));
 assert(!bootStaticAA.toString().includes('localStorage'));assert(!bootStaticAA.toString().includes('document.cookie'));
});
