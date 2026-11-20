import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../../worker/app-builtin-runtime-preview.ts';
import {workspaceStore,TEST_EMAIL,TEST_PASSWORD,TEST_SECRET} from './test-workspace-store.mjs';
import {applyBidderAccountSchema} from './bidder-account-schema.mjs';
import {memoryR2} from './memory-r2.mjs';

export const MAIN_AB_ORIGIN='https://main-ab.fixture.invalid';
export const MAIN_AB_SITES=['alpha-site','beta-site'];

/** Actual MAIN router, SQLite and strict fake R2. All generated demand is GAM-only;
 * neither generated JavaScript nor a publisher ad request is ever executed. */
export async function mainAbFixture({seed=true,workerOverride=worker}={}) {
  const f=workspaceStore(),r2=memoryR2({prefix:''});
  f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8').split('INSERT OR IGNORE INTO publishers')[0]);
  applyBidderAccountSchema(f.sqlite);
  f.sqlite.exec(readFileSync('migrations/0003_external_deployments.sql','utf8'));
  f.env.BUILDS=r2.bucket;
  Object.assign(f.env,{ADMIN_EMAIL:TEST_EMAIL,ADMIN_PASSWORD:TEST_PASSWORD,SESSION_SECRET:TEST_SECRET,
    ASSETS:{fetch(){throw Error('No remote assets in MAIN A/B fixture');}}});
  const ctx={waitUntil(){},passThroughOnException(){}};
  const request=async(path,{method='GET',body,auth=true,origin=MAIN_AB_ORIGIN,headers={}}={})=>workerOverride.fetch(new Request(MAIN_AB_ORIGIN+path,{
    method,headers:{...(auth&&cookie?{cookie}:{}),...(origin?{origin}:{}),...(body!==undefined?{'content-type':'application/json'}:{}),...headers},
    ...(body!==undefined?{body:typeof body==='string'?body:JSON.stringify(body)}:{})}),f.env,ctx);
  let cookie='';
  const login=await request('/api/auth/login',{method:'POST',auth:false,body:{email:TEST_EMAIL,password:TEST_PASSWORD}});
  assert.equal(login.status,303);cookie=login.headers.get('set-cookie').split(';')[0];
  const json=async(path,options,expected=200)=>{const response=await request(path,options),body=await response.json();assert.equal(response.status,expected,JSON.stringify(body));return body;};
  const versions={};
  async function addSite(site){
    f.sqlite.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').run(site,site==='alpha-site'?'Alpha publisher':'Beta publisher',site+'.example.invalid','/999/'+site+'/');
    f.sqlite.prepare('INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES(?,?,?)').run(site+'-config',site,JSON.stringify({enablePrebid:false,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},output:{cleanComments:true}}}));
    f.sqlite.prepare('INSERT INTO ad_units(id,publisher_id,code,type,size_map_key,sort_order) VALUES(?,?,?,?,?,?)').run(site+'-unit',site,'Billboard','ATF','display',0);
    f.sqlite.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').run(site+'-map',site,'display',JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}]));
    f.sqlite.prepare('INSERT INTO unit_rules(id,publisher_id,rule_key,rule_json) VALUES(?,?,?,?)').run(site+'-rule',site,'__DEFAULT__',JSON.stringify({timeout:800,refresh:{enabled:false}}));
    const endpoint='/api/publishers/'+site+'/builtin-site-settings',state=await json(endpoint);
    const runtime=state.runtimes.find(row=>row.version==='3.25.1');assert(runtime);
    await json(endpoint,{method:'POST',body:{action:'setup',revision:state.revision,runtime:runtime.pin,allowPreview:true,enablePrebid:false}});
    versions[site]=[];
    for(const [name,timeout] of [['Version A',800],['Version B',1200]]){
      f.sqlite.prepare('UPDATE unit_rules SET rule_json=? WHERE publisher_id=?').run(JSON.stringify({timeout,refresh:{enabled:false}}),site);
      const packages='/api/publishers/'+site+'/builtin-releases',state=await json(packages);
      const result=await json(packages,{method:'POST',body:{action:'generate',revision:state.revision,notes:name}},201);
      versions[site].push(result.release.id);
    }
  }
  if(seed){
    for(const site of MAIN_AB_SITES)await addSite(site);
    // Fixture-only production state; never calls an external publication or channel API.
    f.sqlite.prepare("UPDATE releases SET status='production' WHERE id=?").run(versions['alpha-site'][0]);
    f.sqlite.prepare('UPDATE publishers SET current_release_id=?,current_version=? WHERE id=?').run(versions['alpha-site'][0],versions['alpha-site'][0],'alpha-site');
  }
  const persistent=()=>JSON.stringify(['publishers','publisher_configs','ad_units','size_maps','unit_rules','bidders','prebid_builds','releases','audit_log'].map(table=>[table,f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  return {f,r2,request,json,versions,persistent,cookie,addSite,close:()=>f.close()};
}
