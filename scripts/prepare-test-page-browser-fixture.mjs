import { mkdir,writeFile,readFile,readdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Miniflare,Headers as MiniflareHeaders } from 'miniflare';
import { positionFixture } from '../tests/support/position-runtime-fixture.mjs';
import { runtimeCatalog,buildArtifactCandidate } from '../worker/test-workspace/runtime-catalog.mjs';
import { pinRuntime } from '../worker/runtime/version-pin.mjs';
import { saveDraftRelease } from '../worker/runtime/draft-release-store.mjs';
import { testPageScript } from '../.generated/test-page-client.mjs';
const out=new URL('../.generated/test-page-evidence/',import.meta.url);await mkdir(out,{recursive:true});
const snapshot=positionFixture(false),config=JSON.parse(snapshot.config.config_json);
delete config.runtimeControls.adPositions;snapshot.config.config_json=JSON.stringify(config);
snapshot.units[2].code='Branding';
snapshot.maps[1].map_json=JSON.stringify([{viewport:[0,0],sizes:[]},{viewport:[1300,0],sizes:[[160,600]]}]);
const candidate=await buildArtifactCandidate({snapshot,pin:pinRuntime(runtimeCatalog[0],{allowPreview:true}),buildTimestamp:'20260922_220000'});
// The HTML must come from the actual Wrangler bundle, not an imported source
// renderer: source-only tests missed Function#toString dropping __name helpers.
const compiled=new URL('../.generated/test-workspace-active-dry-run/',import.meta.url);
const names=(await readdir(compiled)).filter(name=>/\.m?js$/.test(name));assert.equal(names.length,1);
const script=await readFile(new URL(names[0],compiled),'utf8');
const workerConfig=JSON.parse(await readFile(new URL('../ops/runtime-test/wrangler.active.jsonc',import.meta.url),'utf8'));
const origin=workerConfig.vars.TEST_PUBLIC_ORIGIN,password=randomBytes(24).toString('hex');
let outbound=0;
const mf=new Miniflare({name:'test-page-browser-fixture',modules:true,script,compatibilityDate:workerConfig.compatibility_date,cf:false,host:'127.0.0.1',port:0,
  bindings:{...workerConfig.vars,TEST_ADMIN_EMAIL:'tester@example.invalid',TEST_ADMIN_PASSWORD:password,TEST_SESSION_SECRET:randomBytes(48).toString('hex')},
  d1Databases:{DB:'local-test-page-db'},r2Buckets:{BUILDS:'local-test-page-builds'},
  outboundService:()=>{outbound++;return new Response('No external requests in this fixture',{status:503});}});
try{
  const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:'tester@example.invalid',password}).toString()});
  assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
  const setup=await mf.dispatchFetch(origin+'/test-api/setup',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-empty-test-database'})});assert.equal(setup.status,200);
  const rawBucket=await mf.getR2Bucket('BUILDS');
  // Preserve conditional writes while adapting Node's Headers to the proxy's
  // supported Headers class. This adapter exists only in the local fixture.
  const bucket={get:key=>rawBucket.get(key),put:(key,bytes,options)=>rawBucket.put(key,bytes,{...options,onlyIf:new MiniflareHeaders(options.onlyIf)})};
  const saved=await saveDraftRelease({isolation:'explicit-test-store',db:await mf.getD1Database('DB'),bucket},
    {siteId:'test-site',candidate,actor:'tester@example.invalid',note:'Compiled Worker browser test'});
  const response=await mf.dispatchFetch(origin+'/test-api/site-test-page/'+saved.draft.id+'?googfc',{headers:{cookie}});
  assert.equal(response.status,200);const html=await response.text();
  assert(html.includes('<script>'+testPageScript+'</script>'),'Compiled Worker must return the complete browser bundle unchanged.');
  assert.equal(outbound,0);
  await writeFile(new URL('page.html',out),html);
  await writeFile(new URL('headers.json',out),JSON.stringify(Object.fromEntries(response.headers)));
  console.log('Prepared authenticated page from the actual Wrangler Worker with local D1/R2; no hosted data or ad requests.');
}finally{await mf.dispose();}
