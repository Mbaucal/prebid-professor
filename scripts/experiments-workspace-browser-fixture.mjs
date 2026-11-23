/** Actual App and MAIN routes, seeded like Tanjug: historical pilots and no built-in sources. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {mainAbFixture,MAIN_AB_ORIGIN} from '../tests/support/ab-tests-main-fixture.mjs';
import {DEFAULT_PACKAGE_SETTINGS} from '../worker/experiments/package-settings-v1.mjs';

let outbound=0;
globalThis.fetch=()=>{outbound++;throw Error('Outbound traffic forbidden in experiment workspace QA');};
const h=await mainAbFixture({seed:false}),history={scripts:[],tests:[],generated:[]};
for(const site of ['tanjug','other-site','blocked-site'])await h.addSite(site);
for(const site of ['tanjug','blocked-site']){
  h.f.sqlite.prepare('DELETE FROM releases WHERE publisher_id=?').run(site);
  for(const key of h.r2.objects.keys())if(key.startsWith(`publishers/${site}/releases/`))h.r2.objects.delete(key);
}
const configOf=site=>JSON.parse(h.f.sqlite.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').get(site).config_json);
const saveConfig=(site,value)=>h.f.sqlite.prepare('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?').run(JSON.stringify(value),site);
const originalConfig=configOf('tanjug');
delete originalConfig.builtinRuntimeSelection;
Object.assign(originalConfig,{enablePrebid:true,generatorProfileId:'earlier-tanjug-pilot',currency:'EUR',prebidBidCache:{enabled:false,maxBidAgeSeconds:60}});
saveConfig('tanjug',originalConfig);
h.f.sqlite.prepare('UPDATE publishers SET name=?,domain=?,gam_path=? WHERE id=?').run('Tanjug','tanjug.rs','/22852026051/Tanjug.rs-Display/','tanjug');
h.f.sqlite.prepare('INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES(?,?,?,?,?)').run('tanjug-pubmatic','tanjug','pubmatic','{"publisherId":"fixture","adSlot":"fixture"}',1);
const vendor=new URL('../vendor/prebid/tanjug-11.34.0/',import.meta.url);
const prebid=new Uint8Array(readFileSync(new URL('prebid.js',vendor))),prebidConfig=JSON.parse(readFileSync(new URL('prebid-config.json',vendor),'utf8'));
const prebidKey='publishers/tanjug/prebid-builds/workspace-qa-prebid/prebid.js';
h.f.sqlite.prepare('INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES(?,?,?,?,?,?)').run('workspace-qa-prebid','tanjug',prebidConfig.version,prebidKey,JSON.stringify(prebidConfig.modules),'current');
await h.r2.bucket.put(prebidKey,prebid,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{cacheControl:'private, no-store'},customMetadata:{sha256:createHash('sha256').update(prebid).digest('hex'),version:prebidConfig.version}});
for(const [name,cached,seconds] of [['Earlier fresh script',false,30],['Earlier cached script',true,30],['Damaged earlier script',true,45],['Deleted earlier script',true,60]]){
  const config=configOf('tanjug');config.prebidBidCache={enabled:cached,maxBidAgeSeconds:60};saveConfig('tanjug',config);
  const listing=await h.json('/api/publishers/tanjug/script-library');
  const result=await h.json('/api/publishers/tanjug/script-library/scripts',{method:'POST',body:{revision:listing.revision,name,refreshSeconds:seconds}},201);
  history.scripts.push(result.item);
}
for(const name of ['Earlier named cache test','Earlier named refresh test','Earlier named archived comparison']){
  const listing=await h.json('/api/publishers/tanjug/script-library');
  const result=await h.json('/api/publishers/tanjug/script-library/tests',{method:'POST',body:{revision:listing.revision,name,
    scriptA:history.scripts[0].id,scriptB:history.scripts[1].id,trafficBPercent:50}},201);
  history.tests.push(result.item);
}
const older=await h.json('/api/publishers/tanjug/ab-experiments');
const generated=await h.json('/api/publishers/tanjug/ab-experiments',{method:'POST',body:{revision:older.revision,settings:DEFAULT_PACKAGE_SETTINGS,notes:'Earlier configurable pilot'}},201);
history.generated.push(generated.package);
const deleted=history.scripts[3];
await h.json(`/api/publishers/tanjug/script-library/scripts/${deleted.id}.zip`,{method:'DELETE',body:{confirmId:deleted.id,sha256:deleted.sha256}});
// Intentional damaged fixture, before the protected baseline. Healthy history must remain usable.
const damaged=history.scripts[2],damagedKey=`site-script-library/v1/tanjug/scripts/archives/${damaged.id}.zip`;
h.r2.objects.get(damagedKey).bytes[0]^=255;
const blocked=configOf('blocked-site');delete blocked.builtinRuntimeSelection;blocked.enablePrebid=true;blocked.generatorProfileId='earlier-pilot';saveConfig('blocked-site',blocked);
const other=await h.json('/api/publishers/other-site/ab-tests',{method:'POST',body:{a:h.versions['other-site'][0],b:h.versions['other-site'][1],name:'Other site saved experiment',testId:'other_1',trafficBPercent:50}},201);

let failSection='';
const nativeList=h.r2.bucket.list;
h.r2.bucket.list=async options=>{
  const named=options.prefix?.startsWith('site-script-library/v1/tanjug/');
  if(failSection&&options.prefix?.includes(failSection)){failSection='';throw Error('Synthetic historical section unavailable');}
  // R2 may legally return fewer rows than requested. Keep its real opaque cursor.
  return nativeList(named?{...options,limit:Math.min(options.limit??1000,2)}:options);
};
const protectedObjects=new Map([...h.r2.objects].map(([key,row])=>[key,createHash('sha256').update(row.bytes).digest('hex')]));
const protectedSite=JSON.stringify(h.f.sqlite.prepare('SELECT * FROM publishers WHERE id=?').get('tanjug'));
const protectedInventory=JSON.stringify(['ad_units','size_maps','unit_rules','bidders','prebid_builds'].map(table=>[table,h.f.sqlite.prepare(`SELECT * FROM ${table} WHERE publisher_id=? ORDER BY id`).all('tanjug')]));
const startingConfig=JSON.stringify(configOf('tanjug'));
const otherSql=JSON.stringify(['publishers','publisher_configs','releases'].map(table=>[table,h.f.sqlite.prepare(`SELECT * FROM ${table} WHERE ${table==='publishers'?'id':'publisher_id'}=? ORDER BY id`).all('other-site')]));
const publisher={id:'minacord-media-doo',name:'MINACORD MEDIA DOO',status:'active',sitesCount:3,notes:'',
  sites:[['tanjug','tanjug.rs'],['other-site','other.example.invalid'],['blocked-site','blocked.example.invalid']].map(([id,name])=>({id,publisherAccountId:'minacord-media-doo',name,domain:name,
    gamPath:id==='tanjug'?'/22852026051/Tanjug.rs-Display/':'/999/'+id+'/',status:'draft',currentVersion:'draft',adsTxtUrl:'https://example.invalid/ads.txt',updatedAt:'2026-11-23T00:00:00Z',lastPublishedAt:null,adUnitsCount:1,biddersCount:id==='tanjug'?1:0}))};
const bundle=await build({stdin:{contents:`import {createRoot} from 'react-dom/client';import App from './src/App';import './src/dashboard-styles';createRoot(document.getElementById('root')).render(<App/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,
  outdir:'.generated/experiments-workspace-fixture',jsx:'automatic',format:'iife',minify:true,define:{'process.env.NODE_ENV':'"production"'}});
assert.equal(h.f.sqlite.prepare('SELECT count(*) AS n FROM releases WHERE publisher_id=?').get('tanjug').n,0);
console.log(JSON.stringify({ready:true,origin:MAIN_AB_ORIGIN,history,other:{id:other.record.id,testId:other.record.testId},
  initialBuiltinSources:0,scope:'Actual App and authenticated MAIN routes; synthetic Tanjug records, approved frozen Prebid bytes, SQLite/R2; no ad script execution or external traffic'}));
for await(const line of createInterface({input:process.stdin})){
  try{
    const input=JSON.parse(line),url=new URL(input.path,MAIN_AB_ORIGIN);let response;
    if(url.pathname==='/')response=new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>',{headers:{'content-type':'text/html'}});
    else if(['/fixture.js','/fixture.css'].includes(url.pathname)){
      const extension=url.pathname.endsWith('.js')?'.js':'.css';response=new Response(bundle.outputFiles.find(file=>file.path.endsWith(extension)).text,{headers:{'content-type':extension==='.js'?'application/javascript':'text/css'}});
    }else if(url.pathname==='/tessera-logo.png')response=new Response(readFileSync('public/tessera-logo.png'),{headers:{'content-type':'image/png'}});
    else if(url.pathname==='/api/publisher-accounts')response=Response.json({publishers:[publisher]});
    else if(url.pathname==='/api/organization')response=Response.json({agencies:[],memberships:[]});
    else if(url.pathname==='/api/auth/me')response=Response.json({ok:true,user:{email:'workspace-qa@example.invalid'}});
    else if(url.pathname==='/api/health')response=Response.json({ok:true,database:'connected',storage:'connected',service:'Synthetic QA'});
    else if(url.pathname==='/__qa/inspect')response=Response.json({outboundRequests:outbound,
      originalObjectsUnchanged:[...protectedObjects].every(([key,sha])=>h.r2.objects.has(key)&&createHash('sha256').update(h.r2.objects.get(key).bytes).digest('hex')===sha),
      siteUnchanged:JSON.stringify(h.f.sqlite.prepare('SELECT * FROM publishers WHERE id=?').get('tanjug'))===protectedSite,
      inventoryUnchanged:JSON.stringify(['ad_units','size_maps','unit_rules','bidders','prebid_builds'].map(table=>[table,h.f.sqlite.prepare(`SELECT * FROM ${table} WHERE publisher_id=? ORDER BY id`).all('tanjug')]))===protectedInventory,
      configUnchanged:JSON.stringify(configOf('tanjug'))===startingConfig,config:configOf('tanjug'),
      otherSiteUnchanged:JSON.stringify(['publishers','publisher_configs','releases'].map(table=>[table,h.f.sqlite.prepare(`SELECT * FROM ${table} WHERE ${table==='publishers'?'id':'publisher_id'}=? ORDER BY id`).all('other-site')]))===otherSql,
      releases:h.f.sqlite.prepare('SELECT id,notes,status FROM releases WHERE publisher_id=? ORDER BY created_at,id').all('tanjug'),
      newKeys:[...h.r2.objects.keys()].filter(key=>!protectedObjects.has(key)),
      financialDataPersisted:[...h.r2.objects.values()].some(row=>new TextDecoder().decode(row.bytes).includes('9876.543219'))});
    else if(url.pathname==='/__qa/history-failure'){failSection='/tests/records/';response=Response.json({armed:true});}
    else if(url.pathname==='/__qa/revision-change'){
      const config=configOf('tanjug');config.qaRevision=(config.qaRevision??0)+1;saveConfig('tanjug',config);response=Response.json({changed:true});
    }else if(url.pathname==='/__qa/add-corrupt-source'){
      const id='builtin-release-'+'f'.repeat(64);h.f.sqlite.prepare('INSERT INTO releases(id,publisher_id,version,status,notes) VALUES(?,?,?,?,?)').run(id,'tanjug',id,'draft','Unavailable saved source');response=Response.json({id});
    }else if(!url.pathname.startsWith('/api/'))response=new Response('Not found',{status:404});
    else response=await h.request(input.path,{method:input.method,body:input.body??undefined});
    assert(response instanceof Response);
    console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
  }catch(error){console.log(JSON.stringify({error:error.message,stack:error.stack}));}
}
h.close();
