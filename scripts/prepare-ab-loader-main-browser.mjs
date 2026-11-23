/** Complete MAIN 3.25.1 Generate/readPackage fixtures; all storage and demand are synthetic. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname, sep} from 'node:path';
import {workspaceStore} from '../tests/support/test-workspace-store.mjs';
import {applyBidderAccountSchema} from '../tests/support/bidder-account-schema.mjs';
import {memoryR2} from '../tests/support/memory-r2.mjs';
import {bidCacheSite} from '../tests/runtime/bid-cache323-site.mjs';
import {siteRuntimeSettings, changeSiteRuntime} from '../worker/site-runtime/service.mjs';
import {generatePackage, readPackage} from '../worker/site-runtime/releases.mjs';
import {checkAbCompatibility, composeAbBundle} from '../worker/experiments/ab-bundle.mjs';
import {PAGES_HEADERS} from '../shared/pages/headers.mjs';

// node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs
//   scripts/prepare-ab-loader-main-browser.mjs [.generated/ab-loader-main-browser]
const root=resolve(import.meta.dirname,'..'),owned=resolve(root,'.generated/ab-loader-main-browser');
const out=process.argv[2]?resolve(process.argv[2]):owned;
assert(out!==root&&(!out.startsWith(root+sep)||out===owned),'Use the owned .generated/ab-loader-main-browser directory or a new external directory.');
assert.equal((await readdir(out).catch(()=>[])).length,0,'Use an empty fixture directory.');
const SITE='main-ab-example',ACTOR='browser@example.invalid';
const vendor=resolve(root,'vendor/prebid/tanjug-11.34.0');
const prebidBytes=new Uint8Array(await readFile(resolve(vendor,'prebid.js')));
const prebidConfig=JSON.parse(await readFile(resolve(vendor,'prebid-config.json'),'utf8'));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=bytes=>JSON.parse(new TextDecoder().decode(bytes));
const fixture=workspaceStore(),snapshot=bidCacheSite();
const NativeDate=globalThis.Date,STAMP='2026-11-19T12:00:00.000Z';
// Both package generations use the same build timestamp, as well as the same
// snapshot and Prebid bytes. Only the explicit cache setting changes.
globalThis.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[STAMP]));}static now(){return NativeDate.parse(STAMP);}};
snapshot.units.push({code:'P2',type:'BTF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:2});
snapshot.rules.push({rule_key:'P2',rule_json:JSON.stringify({lazy:{enabled:true,fetchMarginPx:0,renderMarginPx:0},timeout:800,
  refresh:{enabled:true,minSeconds:30,minViewPct:0,requirePreviousViewable:false,checkEveryMs:1000}})});
const written={};
async function put(path,data){const file=resolve(out,path);await mkdir(dirname(file),{recursive:true});await writeFile(file,data,{flag:'wx'});written[path]=hash(data);}
try{
  fixture.sqlite.exec((await readFile(resolve(root,'migrations/0001_initial.sql'),'utf8')).split('INSERT OR IGNORE INTO publishers')[0]);
  applyBidderAccountSchema(fixture.sqlite);
  const sql=(text,...args)=>fixture.sqlite.prepare(text).run(...args);
  sql('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)',SITE,'Synthetic MAIN A/B','main-ab.example.invalid',snapshot.site.gam_path);
  sql('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)','config',SITE,snapshot.config.config_json);
  for(const u of snapshot.units)sql('INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?)',u.code,SITE,u.code,u.type,u.media_type,u.size_map_key,u.enabled,u.sort_order);
  for(const m of snapshot.maps)sql('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)',m.name,SITE,m.name,m.map_json);
  for(const b of snapshot.bidders)sql('INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES(?,?,?,?,?)',b.bidder,SITE,b.bidder,b.params_json,b.enabled);
  for(const r of snapshot.rules)sql('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)',r.rule_key,SITE,r.rule_key,r.rule_json);
  const r2=memoryR2({prefix:`publishers/${SITE}/`});fixture.env.BUILDS=r2.bucket;
  const prebidKey=`publishers/${SITE}/prebid-builds/ab-fixture/prebid.js`;
  sql('INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES(?,?,?,?,?,?)','ab-fixture',SITE,prebidConfig.version,prebidKey,JSON.stringify(prebidConfig.modules),'current');
  await r2.bucket.put(prebidKey,prebidBytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{cacheControl:'private, no-store'},customMetadata:{sha256:hash(prebidBytes),version:prebidConfig.version}});
  const settings=await siteRuntimeSettings(fixture.env,SITE),selected=settings.runtimes.find(row=>row.version==='3.25.1');
  assert(selected,'MAIN must explicitly offer 3.25.1.');
  await changeSiteRuntime(fixture.env,SITE,ACTOR,{action:'version',revision:settings.revision,runtime:selected.pin,allowPreview:true});
  async function generated(note){
    const {release}=await generatePackage(fixture.env,SITE,ACTOR,{notes:note,revision:(await siteRuntimeSettings(fixture.env,SITE)).revision});
    const saved=await readPackage(fixture.env,SITE,release.id);
    assert.equal(saved.manifest.completeRelease,true);assert.equal(saved.manifest.runtime.runtimeVersion,'3.25.1');
    assert.deepEqual(saved.files['prebid.js'],prebidBytes);assert(saved.files['gam-reporting.json']&&saved.files['deals-plan.json']);
    return saved;
  }
  const A=await generated('MAIN 3.25.1 cache OFF');
  const config=JSON.parse(fixture.sqlite.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').get(SITE).config_json);
  config.prebidBidCache={enabled:true,maxBidAgeSeconds:60};
  sql('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?',JSON.stringify(config),SITE);
  const B=await generated('MAIN 3.25.1 cache ON');
  const ac=json(A.files['config.json']),bc=json(B.files['config.json']);
  assert.equal(ac.bidCache,null);assert(bc.bidCache);
  delete ac.bidCache;delete bc.bidCache;
  delete ac.version;delete bc.version; // Content-derived saved release IDs differ.
  assert.deepEqual(ac,bc,'The saved runtime/config/Prebid must differ only in bidCache.');
  const bundles={};
  for(const [name,trafficBPercent,b]of [['ab',50,B],['aa',50,A],['b0',0,B],['b100',100,B]]){
    const input={site:SITE,a:A,b,trafficBPercent,testId:`main_ab_${name}`,name:`MAIN 3.25.1 ${name}`};
    assert.equal((await checkAbCompatibility(input)).compatible,true);
    const bundle=await composeAbBundle(input);
    assert.equal(bundle.record.loader.version,'1.1.1','This native proof pins the pending-arm arbitration loader.');
    for(const [side,p]of [['A',A],['B',b]])assert.equal(bundle.record.arms[side].sha256,hash(p.files['ads.min.js']));
    assert.deepEqual(bundle.files['prebid.js'],prebidBytes);
    await put(`bundles/${name}/bundle.zip`,bundle.zip);await put(`bundles/${name}/record.json`,JSON.stringify(bundle.record,null,2)+'\n');
    bundles[name]={id:bundle.id,testId:input.testId,trafficBPercent,zipSha256:bundle.zipSha256,
      loader:bundle.record.loader,entrySha256:hash(bundle.files['ads.js'])};
  }
  await put('direct/ads.js',A.files['ads.min.js']);await put('direct/prebid.js',prebidBytes);await put('direct/_headers',PAGES_HEADERS);
  for(const [side,p]of [['A',A],['B',B]])await put(`source-${side}-manifest.json`,p.files['manifest.json']);
  const versions=Object.fromEntries([['A',A],['B',B]].map(([side,p])=>[side,{release:p.release.id,name:p.release.notes,runtimeVersion:'3.25.1',runtimeSha256:p.manifest.runtime.runtimeSha256,packageManifestSha256:hash(p.files['manifest.json']),adsMinSha256:hash(p.files['ads.min.js']),cache:side==='B',completeRelease:true}]));
  await writeFile(resolve(out,'manifest.json'),JSON.stringify({schema:'tessera-main-ab-browser-1',site:SITE,versions,bundles,
    prebid:{version:prebidConfig.version,modules:prebidConfig.modules,sha256:hash(prebidBytes)},nodeVersion:process.version,files:written},null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({scope:'Synthetic complete MAIN Generate/readPackage; no deployment',site:SITE,runtime:'3.25.1',prebid:prebidConfig.version,bundles:Object.keys(bundles),output:out}));
}finally{globalThis.Date=NativeDate;fixture.close();}
