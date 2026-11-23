/** Saved MAIN 3.26 arms through the current immutable A/B store/composer. Local SQLite/R2 only. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {unzipSync} from 'fflate';
import {workspaceStore} from '../tests/support/test-workspace-store.mjs';
import {applyBidderAccountSchema} from '../tests/support/bidder-account-schema.mjs';
import {memoryR2} from '../tests/support/memory-r2.mjs';
import {bidCacheSite} from '../tests/runtime/bid-cache323-site.mjs';
import {siteRuntimeSettings,changeSiteRuntime} from '../worker/site-runtime/service.mjs';
import {generatePackage,readPackage} from '../worker/site-runtime/releases.mjs';
import {createAbTest,readAbZip} from '../worker/experiments/ab-store.mjs';
import {createMeasurementPlan} from '../worker/experiments/ab-report-plan.mjs';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),options={};
for(let n=0;n<args.length;n+=2){assert(['--prebid','--out'].includes(args[n])&&args[n+1]);options[args[n]]=resolve(args[n+1]);}
assert(options['--prebid']&&options['--out'],'Use --prebid <pinned native build> --out <owned evidence directory>');
const out=options['--out'],SITE='combined-measurement-timeout',ACTOR='combined-qa@example.invalid';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const prebidBytes=new Uint8Array(await readFile(resolve(options['--prebid'],'prebid.js')));
const prebid=JSON.parse(await readFile(resolve(options['--prebid'],'prebid-config.json'),'utf8'));
const native=JSON.parse(await readFile(resolve(options['--prebid'],'manifest.json'),'utf8'));
assert.equal(prebid.version,'11.34.0');assert.equal(native.sourceCommit,'195e0c6069928ed906bde550cb4e4183d1dc8474');assert.equal(hash(prebidBytes),native.buildSha256);
const f=workspaceStore(),r2=memoryR2({prefix:''}),s=bidCacheSite({cache:{enabled:false,maxBidAgeSeconds:60}}),originalFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('No outbound traffic in combined QA preparation');};f.env.BUILDS=r2.bucket;
try{
 f.sqlite.exec((await readFile(resolve(root,'migrations/0001_initial.sql'),'utf8')).split('INSERT OR IGNORE INTO publishers')[0]);applyBidderAccountSchema(f.sqlite);
 const sql=(text,...args)=>f.sqlite.prepare(text).run(...args);
 const config=JSON.parse(s.config.config_json);config.currency='EUR';
 config.userSync={syncEnabled:false,aliasSyncEnabled:false,syncsPerBidder:0,syncDelay:0,auctionDelay:0,userIds:[]};
 config.adaptiveAuctionTimeout={enabled:true,minMs:100,maxMs:1200,mobileAdjustmentMs:0,slowConnectionAdjustmentMs:0,videoAdjustmentMs:0,additionalPositionMs:0,maxPositionAdjustmentMs:0};
 sql('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)',SITE,'Synthetic combined acceptance','combined.example.invalid','/999/'+SITE+'/');
 sql('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)','config',SITE,JSON.stringify(config));
 for(const u of s.units)sql('INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) VALUES(?,?,?,?,?,?,?,?)',u.code,SITE,u.code,u.type,u.media_type,u.size_map_key,u.enabled,u.sort_order);
 for(const m of s.maps)sql('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)',m.name,SITE,m.name,m.map_json);
 for(const b of s.bidders)sql('INSERT INTO bidders(id,publisher_id,bidder,params_json,enabled) VALUES(?,?,?,?,?)',b.bidder,SITE,b.bidder,b.params_json,b.enabled);
 sql('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)','default',SITE,'__DEFAULT__',JSON.stringify({timeout:500,cmpTimeout:10000,lazy:{enabled:false,fetchMarginPx:0,renderMarginPx:0},refresh:{enabled:true,minSeconds:30,minViewPct:0,requirePreviousViewable:false,checkEveryMs:1000}}));
 const key=`publishers/${SITE}/prebid-builds/native/prebid.js`;
 sql('INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES(?,?,?,?,?,?)','native',SITE,prebid.version,key,JSON.stringify(prebid.modules),'current');
 await r2.bucket.put(key,prebidBytes,{onlyIf:new Headers({'If-None-Match':'*'}),httpMetadata:{cacheControl:'private, no-store'},customMetadata:{sha256:hash(prebidBytes),version:prebid.version}});
 const settings=await siteRuntimeSettings(f.env,SITE),runtime=settings.runtimes.find(row=>row.version==='3.26.0');assert(runtime,'Select explicit runtime3.26.0');
 await changeSiteRuntime(f.env,SITE,ACTOR,{action:'version',revision:settings.revision,runtime:runtime.pin,allowPreview:true});
 const generate=async name=>{const{release}=await generatePackage(f.env,SITE,ACTOR,{notes:name,revision:(await siteRuntimeSettings(f.env,SITE)).revision});return readPackage(f.env,SITE,release.id);};
 const A=await generate('Combined326 cache OFF');
 const current=JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').get(SITE).config_json);
 current.prebidBidCache={enabled:true,maxBidAgeSeconds:60};sql('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?',JSON.stringify(current),SITE);
 const B=await generate('Combined326 cache ON');
 for(const saved of[A,B]){assert.equal(saved.manifest.completeRelease,true);assert.equal(saved.manifest.runtime.runtimeVersion,'3.26.0');assert.deepEqual(saved.files['prebid.js'],prebidBytes);}
 assert.equal(JSON.parse(new TextDecoder().decode(A.files['config.json'])).bidCache,null);
 assert(JSON.parse(new TextDecoder().decode(B.files['config.json'])).bidCache);
 const before=JSON.stringify(f.sqlite.prepare('SELECT * FROM publisher_configs').all());
 const stored=await createAbTest(r2.bucket,{site:SITE,actor:{email:ACTOR},a:A,b:B,name:'Combined native326 and memory ledger',testId:'combined326_1',trafficBPercent:100});
 assert.equal(stored.record.loader.version,'1.1.1');assert.equal(stored.record.loader.sha256,'81a1e8eee06a26a97eb65c7c0199e21508b6721bac3d3adecddd49ff3e7dd113');
 const plan=await createMeasurementPlan(r2.bucket,{site:SITE,id:stored.record.id,actor:{email:ACTOR},readVersion:id=>readPackage(f.env,SITE,id),report:{networkCode:'999',inventoryPath:'/999/'+SITE+'/',startDate:'2026-11-20',endDate:'2026-11-20',currency:'EUR',timeZone:'UTC',revenueBasis:'net',revenueMetric:'total'}});
 const archive=await readAbZip(r2.bucket,SITE,stored.record.id),files=unzipSync(archive.bytes),written={};
 await mkdir(out,{recursive:true});
 for(const [name,bytes]of Object.entries(files)){const path=resolve(out,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes);written[name]=hash(bytes);}
 for(const [side,saved]of[['A',A],['B',B]])assert.deepEqual(files[stored.record.arms[side].path],saved.files['ads.min.js']);
 const mock=await readFile(resolve(root,'tests/runtime/mock-gpt-page-targeting.js'));await writeFile(resolve(out,'mock.js'),mock);written['mock.js']=hash(mock);
 assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM publisher_configs').all()),before,'Composing/report preparation does not change site configuration');
 await writeFile(resolve(out,'manifest.json'),JSON.stringify({schemaVersion:1,site:SITE,record:stored.record,plan:plan.plan,files:written,prebid,native,
  cases:['native-cache-refresh','assigned-b-executed-a'],runtimeSha256:A.manifest.runtime.runtimeSha256,
  scope:'Complete saved3.26 MAIN packages + loader1.1 memory ledger; pinned native Prebid, mock GPT and intercepted synthetic demand only. No collector activation, real GAM or revenue acceptance.'},null,2)+'\n');
 console.log(JSON.stringify({output:out,loader:stored.record.loader,runtime:A.manifest.runtime,sourceArms:stored.record.arms,files:Object.keys(written).length}));
}finally{f.close();globalThis.fetch=originalFetch;}
