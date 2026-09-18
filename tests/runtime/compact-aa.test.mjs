import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
import {zipSync,unzipSync} from 'fflate';
import {sha256,archiveStaticAAPackage,verifyStaticAAPackage,readStaticAAArchive} from '../../scripts/static-aa-package.mjs';

const read=p=>readFileSync(new URL('../../'+p,import.meta.url));
const manifest=JSON.parse(read('.generated/tanjug-compact/release.json'));
const archive=read('.generated/tanjug-compact/tanjug-aa-1.0.1.zip');
const config=manifest.config,files=unzipSync(archive),loader=Buffer.from(files['ads.js']).toString();

test('new version preserves original A/A archive, complete inventory, exact Prebid and auction source',()=>{
  assert.equal(sha256(read('.generated/tanjug-aa/tanjug-aa-1.0.0.zip')),'bb66d583573099f46795e9e3cd9f700a5fad1581cafa7a62212b041882319993');
  const old=unzipSync(read('.generated/tanjug-aa/tanjug-aa-1.0.0.zip'));
  const prior=JSON.parse(Buffer.from(old['release.json']));
  assert.equal(manifest.release,'tanjug-aa-1.0.1');
  assert.deepEqual(config.positions,prior.config.positions);
  assert.equal(manifest.baseReadableSha256,prior.baseReadableSha256);
  assert.equal(manifest.sourceConfigurationSha256,prior.sourceConfigurationSha256);
  assert.deepEqual(files['prebid.js'],old['prebid.js']);
  assert.deepEqual(files[config.arms.A.path],files[config.arms.B.path]);
  // The sole runtime change is the release-entry guard, not auction behavior.
  assert.equal(Buffer.from(files[config.arms.A.path]).toString().replace('tanjug-aa-1.0.1','tanjug-aa-1.0.0'),Buffer.from(old[prior.config.arms.A.path]).toString());
});

test('owned JS has no comments or source maps; public ZIP has no guides or build metadata',()=>{
  for(const name of ['ads.js',config.arms.A.path,config.arms.B.path]) {
    const source=Buffer.from(files[name]).toString(),comments=[];
    parse(source,{ecmaVersion:'latest',onComment:comments});
    assert.deepEqual(comments,[]);assert.equal(source.trim().split('\n').length,1);
    assert(!source.includes('sourceMappingURL'));assert(!source.includes('sourceURL'));
  }
  for(const name of Object.keys(files))assert(!/\.map$|\.json$|\.txt$|\.md$/.test(name),name);
  const before=unzipSync(read('.generated/tanjug-aa/tanjug-aa-1.0.0.zip'))['ads.js'].length;
  assert(files['ads.js'].length<before*.8,'Loader should be materially smaller');
});

test('download archive and prepared deployment have identical verified bytes and deterministic ZIP',()=>{
  const back=readStaticAAArchive(manifest,archive,sha256(archive));
  for(const name of Object.keys(back))assert.deepEqual(Buffer.from(back[name]),read('.generated/tanjug-compact/deploy/'+name));
  assert.deepEqual(Buffer.from(archiveStaticAAPackage(manifest,back)),archive);
  assert.throws(()=>readStaticAAArchive(manifest,archive,'0'.repeat(64)),/checksum/);
});

for(const [name,edit] of [
  ['changed arm',f=>{f[config.arms.B.path]=Buffer.from('wrong');}],
  ['missing dependency',f=>{delete f[config.prebidPath];}],
  ['public metadata',f=>{f['release.json']=Buffer.from('{}');}],
  ['unsafe path',f=>{f['../outside.js']=Buffer.from('wrong');}],
])test('reject '+name+' before a ZIP can be used for delivery',()=>{
  const changed={...files};edit(changed);
  assert.throws(()=>verifyStaticAAPackage(manifest,changed));
  const zip=zipSync(changed);
  assert.throws(()=>readStaticAAArchive(manifest,zip,sha256(zip)));
});

test('manifest path and integrity changes are rejected',()=>{
  for(const alter of [m=>m.config.arms.A.path='../A.js',m=>m.config.arms.B.integrity='sha256-bad',m=>m.config.release='tanjug-aa-1.0.0']){
    const changed=structuredClone(manifest);alter(changed);
    assert.throws(()=>verifyStaticAAPackage(changed,files));
  }
});

for(const variant of ['A','B'])test('minified loader executes '+variant+' once and keeps working console diagnostics',()=>{
  const inserted=[],slots=[],tag={src:'https://cdn.example.com/ads.js',nonce:'test-nonce'};let draws=0;
  const service={getSlots:()=>slots,addEventListener(){}};
  const document={currentScript:tag,baseURI:'https://www.example.com/',readyState:'complete',scripts:[tag],
    createElement:()=>({}),head:{appendChild:s=>inserted.push(s)}};
  const window={pbjs:{version:'11.34.0'},crypto:{getRandomValues(a){draws++;a[0]=variant==='A'?0:4294967295;return a;}},
    googletag:{cmd:{push(cb){cb();}},pubads:()=>service}};
  const context=vm.createContext({window,document,URL,Uint32Array,WeakSet,Date,
    console:{table(){},log(){}},setTimeout(){return 1;},clearTimeout(){},setInterval(){},clearInterval(){}});
  vm.runInContext(loader,context);
  assert.equal(inserted.length,1);assert.equal(inserted[0].src,'https://cdn.example.com/'+config.arms[variant].path);
  assert.equal(inserted[0].integrity,config.arms[variant].integrity);
  assert.equal(inserted[0].nonce,'test-nonce');
  assert(window.__adVariantDelivery.enter());
  const slot={setConfig(c){this.value=c.targeting.Variant;},getConfig(){return {targeting:{Variant:this.value}};},getSlotElementId(){return 'P1';}};
  slots.push(slot);window.__adVariantDelivery.apply(slot);inserted[0].onload();
  vm.runInContext(loader,context);
  assert.equal(draws,1);assert.equal(inserted.length,1);assert.equal(slot.value,variant);
  const state=window.AdVariant.inspect();
  assert.equal(state.release,manifest.release);assert.equal(state.status,'loaded');
  assert.equal(state.runtimeEntries,1);assert.equal(state.blockedDuplicateLoaders,1);
});
