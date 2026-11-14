import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {adminAuditStore,legacyTemplate} from '../support/admin-audit-store.mjs';
import {validateReleaseWithRuntimeControls,generateReleaseWithRuntimeControls} from '../../worker/runtime-controls-release.ts';
import {publishReleaseToStaging,publishReleaseToProduction,rollbackRelease} from '../../worker/releases.ts';
import {activatePrebidBuild,uploadPrebidBuild} from '../../worker/prebid-builds-identity.ts';
const request=()=>new Request('https://test.invalid/api/generate',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
const fixtures=[];
const setup=options=>{const f=adminAuditStore(options);fixtures.push(f);return f;};
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
for(const version of ['11.34.0','8.52.0'])test(`legacy generation enforces consent modules before release writes for Prebid ${version}`,async()=>{
 const old=version.startsWith('8'),names=['pubmaticBidAdapter','currency',...(old?['consentManagement','gdprEnforcement']:['consentManagementTcf','tcfControl'])];
 const f=setup({modules:names.filter(m=>m==='pubmaticBidAdapter'||m==='currency'),version});
 const validation=await validateReleaseWithRuntimeControls(f.env,'audit-site');assert.equal(validation.status,422);assert.match(JSON.stringify(await validation.json()),old?/gdprEnforcement/:/tcfControl/);
 assert.equal((await generateReleaseWithRuntimeControls(request(),f.env,'audit-site')).status,422);
 assert.equal(f.sqlite.prepare("SELECT count(*) n FROM releases WHERE publisher_id='audit-site'").get().n,0);assert.equal(f.log.puts.length,0);
 f.setPrebid(names,version);
 assert.equal((await validateReleaseWithRuntimeControls(f.env,'audit-site')).status,200);
 const response=await generateReleaseWithRuntimeControls(request(),f.env,'audit-site');assert.equal(response.status,201,await response.clone().text());
 const release=(await response.json()).release;
 for(const file of ['ads.js','ads.min.js']){const source=new TextDecoder().decode(f.objects.get(`publishers/audit-site/releases/${release.version}/${file}`));assert.doesNotThrow(()=>parse(source,{ecmaVersion:'latest'}));assert.match(source,/window\.ADOPS_GENERATOR_PROFILE_ID\s*=/);assert.match(source,/window\.ADOPS_GENERATOR_PROFILE_VERSION\s*=/);}
});
for(const enabled of [false,true])test(`legacy floor insertion emits valid JavaScript when floors ${enabled?'enabled':'disabled'}`,async()=>{
 const f=setup({modules:['pubmaticBidAdapter','consentManagementTcf','tcfControl','currency','priceFloors'],config:{runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled,hardFloor:0.05,currency:'EUR',rules:{default:0.05}}}}});
 const response=await generateReleaseWithRuntimeControls(request(),f.env,'audit-site');assert.equal(response.status,201,await response.clone().text());const release=(await response.json()).release;
 for(const file of ['ads.js','ads.min.js']){const source=new TextDecoder().decode(f.objects.get(`publishers/audit-site/releases/${release.version}/${file}`));assert.doesNotThrow(()=>parse(source,{ecmaVersion:'latest'}));assert.match(source,/var FLOOR_RULES\s*=/);if(enabled)assert.match(source,/var extra = FLOOR_RULES/);}
});
test('legacy raw userSync IDs require native module and currency follows saved toggle',async()=>{
 const f=setup({modules:['pubmaticBidAdapter','consentManagementTcf','tcfControl'],config:{userSync:{userIds:[{name:'sharedId'}]}}});
 let r=await generateReleaseWithRuntimeControls(request(),f.env,'audit-site');assert.equal(r.status,422);assert.match(await r.text(),/currency.*sharedIdSystem.*userId/);assert.equal(f.log.puts.length,0);
 const c=f.readConfig();c.runtimeControls.currencyConversion={enabled:false};c.userSync.userIds=[];f.writeConfig(c);
 assert.equal((await validateReleaseWithRuntimeControls(f.env,'audit-site')).status,200);
});
test('legacy upload and activation cannot make a missing-TCF build current',async()=>{
 const f=setup();f.setPrebid(['pubmaticBidAdapter','currency']);f.sqlite.prepare("UPDATE prebid_builds SET status='archived' WHERE publisher_id='audit-site'").run();
 const response=await activatePrebidBuild(request(),f.env,'audit-site','audit-prebid');assert.equal(response.status,422);assert.match(await response.text(),/consentManagementTcf/);
 const form=new FormData();form.set('file',new File(['/* prebid.js v11.34.0\nModules: pubmaticBidAdapter, currency */\nvoid 0;'],'prebid.js',{type:'application/javascript'}));
 const upload=await uploadPrebidBuild(new Request('https://test.invalid/upload',{method:'POST',body:form}),f.env,'audit-site');assert.equal(upload.status,422);assert.equal(f.log.puts.length,0);
});
test('broken generated source becomes failed and never reaches staging, production or rollback',async()=>{
 const template=legacyTemplate()+'\nfunction broken( {';
 const f=setup({template});const response=await generateReleaseWithRuntimeControls(request(),f.env,'audit-site');assert.equal(response.status,422);assert.match(await response.text(),/invalid JavaScript syntax/);
 const row=f.sqlite.prepare("SELECT id,status FROM releases WHERE publisher_id='audit-site'").get();assert.equal(row.status,'failed');
 const before=f.log.puts.length;for(const handler of [publishReleaseToStaging,publishReleaseToProduction,rollbackRelease])assert.equal((await handler(request(),f.env,'audit-site',row.id)).status,409);assert.equal(f.log.puts.length,before);
});
test('already stored invalid legacy draft cannot be promoted and stored bytes remain untouched',async()=>{
 const f=setup();const response=await generateReleaseWithRuntimeControls(request(),f.env,'audit-site');assert.equal(response.status,201);const release=(await response.json()).release;
 const key=`publishers/audit-site/releases/${release.version}/ads.js`,broken=new TextEncoder().encode('var broken=;');f.objects.set(key,broken);const before=f.log.puts.length;
 for(const handler of [publishReleaseToStaging,publishReleaseToProduction,rollbackRelease]){const r=await handler(request(),f.env,'audit-site',release.id);assert.equal(r.status,409);assert.match(await r.text(),/invalid JavaScript syntax/);}
 assert.equal(f.log.puts.length,before);assert.deepEqual(f.objects.get(key),broken);assert.equal(f.sqlite.prepare('SELECT status FROM releases WHERE id=?').get(release.id).status,'draft');
});

test('legacy module metadata cannot claim TCF modules absent from the saved bytes',async()=>{
 const f=setup({modules:['pubmaticBidAdapter','currency']});
 f.sqlite.prepare("UPDATE prebid_builds SET modules_json=? WHERE publisher_id='audit-site'").run(JSON.stringify(['pubmaticBidAdapter','currency','consentManagementTcf','tcfControl']));
 for(const response of [await validateReleaseWithRuntimeControls(f.env,'audit-site'),await generateReleaseWithRuntimeControls(request(),f.env,'audit-site')]){assert.equal(response.status,422);assert.match(await response.text(),/header differs/);}
 assert.equal(f.log.puts.length,0);assert.equal(f.sqlite.prepare("SELECT count(*) n FROM releases WHERE publisher_id='audit-site'").get().n,0);
});
test('legacy uploaded checksum mismatch is refused before generation or activation',async()=>{
 const f=setup();f.objects.set('audit/prebid.js',new TextEncoder().encode(new TextDecoder().decode(f.objects.get('audit/prebid.js'))+'\n// changed'));
 const generated=await generateReleaseWithRuntimeControls(request(),f.env,'audit-site');assert.equal(generated.status,422);assert.match(await generated.text(),/checksum/);
 f.sqlite.prepare("UPDATE prebid_builds SET status='archived' WHERE publisher_id='audit-site'").run();const activated=await activatePrebidBuild(request(),f.env,'audit-site','audit-prebid');assert.equal(activated.status,422);assert.match(await activated.text(),/checksum/);assert.equal(f.log.puts.length,0);
});
test('saved legacy portal option patches both generated scripts and external CSS without changing false output',async()=>{
 const fixed=setup({config:{runtimeControls:{sticky:{bottomAdUnitId:'P1',allowClosePortal:true}}}});
 const r=await generateReleaseWithRuntimeControls(request(),fixed.env,'audit-site');assert.equal(r.status,201,await r.clone().text());const release=(await r.json()).release;
 for(const file of ['ads.js','ads.min.js']){const source=new TextDecoder().decode(fixed.objects.get(`publishers/audit-site/releases/${release.version}/${file}`));assert.match(source,/document.getElementById\('close_sticky_ad'\) \|\| host.querySelector/);assert.match(source,/setProperty\("z-index"/);assert.match(source,/if \(_sticky && _sticky.closed\) return/);assert.doesNotThrow(()=>parse(source,{ecmaVersion:'latest'}));}
 const css=new TextDecoder().decode(fixed.objects.get(`publishers/audit-site/releases/${release.version}/sticky.css`));assert.match(css,/Tessera legacy portal appearance/);assert.doesNotMatch(css,/,\s*body\s*>\s*#close_sticky_ad/);
 const manifest=JSON.parse(new TextDecoder().decode(fixed.objects.get(`publishers/audit-site/releases/${release.version}/manifest.json`)));assert(manifest.compiler.patches.some(p=>p.includes('legacy Sticky close portal')));
 const unchanged=setup({config:{runtimeControls:{sticky:{bottomAdUnitId:'P1',allowClosePortal:false}}}});const off=await generateReleaseWithRuntimeControls(request(),unchanged.env,'audit-site');assert.equal(off.status,201);const old=(await off.json()).release;const offCss=new TextDecoder().decode(unchanged.objects.get(`publishers/audit-site/releases/${old.version}/sticky.css`));assert.doesNotMatch(offCss,/Tessera legacy portal appearance/);assert.match(offCss,/,\s*body\s*>\s*#close_sticky_ad/);
});
