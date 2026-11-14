import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {buildReference391} from '../../.generated/reference391.mjs';
export const legacyTemplate=()=>buildReference391({GAM_PATH:'/123/audit/',AD_CONTAINER_SELECTOR:'[data-ad]',STICKY_TARGET_ID:'Sticky',PREBID_TIMEOUT:2500,HARD_FLOOR_EUR:0.04},{buildTimestamp:'20261024_120000'});
export function adminAuditStore({config={},modules=['pubmaticBidAdapter','consentManagementTcf','tcfControl','currency'],version='11.34.0',template}={}){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync('migrations/'+file,'utf8'));
 const log={puts:[],batches:0},objects=new Map(),metadata=new Map();
 function prepare(sql,args=[]){return {sql,args,bind(...values){return prepare(sql,values);},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return {success:true,results:sqlite.prepare(sql).all(...args),meta:{changes:0}};},async run(){const result=sqlite.prepare(sql).run(...args);return {success:true,meta:{changes:Number(result.changes)}};}};}
 const DB={prepare,withSession(){return DB;},async batch(items){log.batches++;sqlite.exec('BEGIN IMMEDIATE');try{const result=items.map(({sql,args})=>{const stmt=sqlite.prepare(sql);return stmt.columns().length?{success:true,results:stmt.all(...args),meta:{changes:0}}:{success:true,meta:{changes:Number(stmt.run(...args).changes)}};});sqlite.exec('COMMIT');return result;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
 const BUILDS={async get(key){const bytes=objects.get(key);if(!bytes)return null;const copy=new Uint8Array(bytes);return {size:copy.byteLength,customMetadata:metadata.get(key)??{},httpMetadata:{},async text(){return new TextDecoder().decode(copy);},async arrayBuffer(){return copy.buffer;}};},async put(key,body,options={}){log.puts.push(key);const bytes=typeof body==='string'?new TextEncoder().encode(body):new Uint8Array(body);objects.set(key,bytes.slice());metadata.set(key,options.customMetadata??{});return {key};},async list({prefix=''}){return {objects:[...objects.keys()].filter(k=>k.startsWith(prefix)).map(key=>({key})),truncated:false};},async delete(key){for(const item of Array.isArray(key)?key:[key])objects.delete(item);}};
 sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('audit-site','Audit site','audit.invalid','/123/audit/')").run();
 sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('audit-config','audit-site',?)").run(JSON.stringify({enablePrebid:true,generatorProfileId:'audit-profile',runtimeControls:{sticky:{bottomAdUnitId:''}},...config}));
 sqlite.prepare("INSERT INTO ad_units(id,publisher_id,code,type,size_map_key) VALUES('audit-unit','audit-site','P1','BTF','display')").run();
 sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('audit-map','audit-site','display',?)").run(JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}]));
 sqlite.prepare("INSERT INTO bidders(id,publisher_id,bidder,params_json) VALUES('audit-bidder','audit-site','pubmatic','{}')").run();
 sqlite.prepare("INSERT INTO prebid_builds(id,publisher_id,version,file_key,modules_json,status) VALUES('audit-prebid','audit-site',?,'audit/prebid.js',?,'current')").run(version,JSON.stringify(modules));
 const profile={id:'audit-profile',name:'Audit profile',version:'1.0.0',schemaVersion:1,engine:'legacy-frozen-v1',templateKey:'audit/template.js',templateSha256:'a'.repeat(64)};
 objects.set('generator-profiles/audit-profile/manifest.json',new TextEncoder().encode(JSON.stringify(profile)));
 objects.set('audit/template.js',new TextEncoder().encode(template??legacyTemplate()));
 function setPrebid(names=modules, buildVersion=version){
  const bytes=new TextEncoder().encode(`/* prebid.js v${buildVersion}\nModules: ${names.join(', ')} */\nvoid 0;`);
  objects.set('audit/prebid.js',bytes);metadata.set('audit/prebid.js',{sha256:createHash('sha256').update(bytes).digest('hex')});
  sqlite.prepare("UPDATE prebid_builds SET version=?,modules_json=? WHERE publisher_id='audit-site'").run(buildVersion,JSON.stringify(names));
 }
 setPrebid();
 return {env:{DB,BUILDS},sqlite,objects,metadata,setPrebid,log,readConfig(){return JSON.parse(sqlite.prepare("SELECT config_json FROM publisher_configs WHERE publisher_id='audit-site'").get().config_json);},writeConfig(c){sqlite.prepare("UPDATE publisher_configs SET config_json=? WHERE publisher_id='audit-site'").run(JSON.stringify(c));},close(){sqlite.close();}};
}
