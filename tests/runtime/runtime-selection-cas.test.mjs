import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { commitTestRuntimeSelection } from '../../worker/test-workspace/selection-transaction.mjs';
const oldConfig = JSON.stringify({enablePrebid:false,unrelated:{keep:'yes'}});
const nextConfig = JSON.stringify({enablePrebid:false,unrelated:{keep:'yes'},builtinRuntimeSelection:{schemaVersion:1}});
function fixture() {
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(`CREATE TABLE publishers(id TEXT PRIMARY KEY,name TEXT,domain TEXT,gam_path TEXT);
    CREATE TABLE publisher_configs(publisher_id TEXT UNIQUE,config_json TEXT,config_hash TEXT,updated_at TEXT);
    CREATE TABLE ad_units(publisher_id TEXT,code TEXT,type TEXT,media_type TEXT,size_map_key TEXT,enabled INTEGER,sort_order INTEGER);
    CREATE TABLE bidders(publisher_id TEXT,bidder TEXT,params_json TEXT,enabled INTEGER);
    CREATE TABLE bidder_overrides(publisher_id TEXT,bidder TEXT,scope_type TEXT,scope_key TEXT,params_json TEXT,enabled INTEGER);
    CREATE TABLE size_maps(publisher_id TEXT,name TEXT,map_json TEXT);
    CREATE TABLE unit_rules(publisher_id TEXT,rule_key TEXT,rule_json TEXT);
    CREATE TABLE prebid_builds(id TEXT,publisher_id TEXT,version TEXT,file_key TEXT,modules_json TEXT,status TEXT,uploaded_at TEXT);
    CREATE TABLE builtin_draft_assertions(id TEXT PRIMARY KEY NOT NULL,valid INTEGER NOT NULL CHECK(valid = 1));
    CREATE TABLE audit_log(id TEXT PRIMARY KEY,actor TEXT,action TEXT,publisher_id TEXT,details_json TEXT);
    INSERT INTO publishers VALUES('test-site','Tessera demo','example.invalid','/123/test/');
    INSERT INTO ad_units VALUES('test-site','Billboard','ATF','banner','display',1,0);
    INSERT INTO size_maps VALUES('test-site','display','[{"viewport":[0,0],"sizes":[[300,250]]}]');
    INSERT INTO unit_rules VALUES('test-site','__DEFAULT__','{"timeout":1500}');`);
  sqlite.prepare('INSERT INTO publisher_configs VALUES(?,?,?,?)').run('test-site',oldConfig,'old-hash','old-time');
  let hook=null, committedBatches=0; const faults={at:-1,after:false};
  const db={withSession(mode){assert.equal(mode,'first-primary');return db;},prepare(sql){return {sql,args:[],bind(...args){return {sql,args};}};},
    async batch(statements){if(hook){const h=hook;hook=null;h();}sqlite.exec('BEGIN IMMEDIATE');let result;
      try{result=statements.map((s,index)=>{if(index===faults.at)throw Error('private storage diagnostic must not escape');return {success:true,results:[],meta:{changes:Number(sqlite.prepare(s.sql).run(...s.args).changes)}};});sqlite.exec('COMMIT');committedBatches++;}
      catch(e){sqlite.exec('ROLLBACK');throw e;}
      if(faults.after)throw Error('private response lost after commit');return result;}};
  const select=(sql)=>sqlite.prepare(sql).all('test-site').map((r)=>({...r}));
  const snapshot=()=>({site:select('SELECT id,name,domain,gam_path FROM publishers WHERE id=? LIMIT 1')[0],
    config:select('SELECT config_json FROM publisher_configs WHERE publisher_id=? LIMIT 1')[0],
    units:select('SELECT code,type,media_type,size_map_key,enabled,sort_order FROM ad_units WHERE publisher_id=? ORDER BY sort_order,code'),
    bidders:select('SELECT bidder,params_json,enabled FROM bidders WHERE publisher_id=? ORDER BY bidder'),
    overrides:select('SELECT bidder,scope_type,scope_key,params_json,enabled FROM bidder_overrides WHERE publisher_id=? ORDER BY bidder,scope_type,scope_key'),
    maps:select('SELECT name,map_json FROM size_maps WHERE publisher_id=? ORDER BY name'),
    rules:select('SELECT rule_key,rule_json FROM unit_rules WHERE publisher_id=? ORDER BY rule_key'),
    prebidBuilds:select("SELECT id,publisher_id,version,file_key,modules_json,status,uploaded_at FROM prebid_builds WHERE publisher_id=? AND status='current' ORDER BY uploaded_at DESC,id LIMIT 2")});
  const save=(snap=snapshot(),configJson=nextConfig,extra={})=>commitTestRuntimeSelection({isolation:'explicit-test-store',db},{snapshot:snap,configJson,actor:'tester@example.invalid',...extra});
  const config=()=>sqlite.prepare('SELECT * FROM publisher_configs WHERE publisher_id=?').get('test-site');
  const count=(table)=>sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return {sqlite,db,snapshot,save,config,count,faults,onBatch(fn){hook=fn;},commits(){return committedBatches;},close(){sqlite.close();}};
}
const fixtures=[];
function f(){const v=fixture();fixtures.push(v);return v;}
test.afterEach(()=>{while(fixtures.length)fixtures.pop().close();});
const conflict={code:'configuration_changed',status:409};

test('atomic TEST selection updates only the configuration and audit, clearing stale config hash',async()=>{const x=f();const before=x.snapshot();const result=await x.save();assert.deepEqual(result,{persisted:true,changed:true,publishable:false});assert.equal(x.config().config_json,nextConfig);assert.equal(x.config().config_hash,null);assert.notEqual(x.config().updated_at,'old-time');assert.deepEqual(x.snapshot().maps,before.maps);assert.equal(x.count('audit_log'),1);assert.equal(x.count('builtin_draft_assertions'),0);});
test('unchanged settings still compare the full snapshot without a duplicate audit or timestamp update',async()=>{const x=f();const before={...x.config()};assert.equal((await x.save(x.snapshot(),oldConfig)).changed,false);assert.deepEqual({...x.config()},before);assert.equal(x.count('audit_log'),0);assert.equal(x.count('builtin_draft_assertions'),0);});
test('two clients with the same reviewed state cannot overwrite each other',async()=>{const x=f(),s=x.snapshot();const results=await Promise.allSettled([x.save(s),x.save(s,JSON.stringify({enablePrebid:false,other:'second'}))]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'configuration_changed');assert.equal(x.config().config_json,nextConfig);assert.equal(x.count('audit_log'),1);});
const changes=[
  ['site name',"UPDATE publishers SET name='Other' WHERE id='test-site'"],
  ['site domain',"UPDATE publishers SET domain='different.invalid' WHERE id='test-site'"],
  ['GAM path',"UPDATE publishers SET gam_path='/123/other/' WHERE id='test-site'"],
  ['configuration',`UPDATE publisher_configs SET config_json='{"enablePrebid":false,"newer":true}' WHERE publisher_id='test-site'`],
  ['unit sizes',"UPDATE ad_units SET size_map_key='other' WHERE publisher_id='test-site'"],
  ['unit enabled',"UPDATE ad_units SET enabled=0 WHERE publisher_id='test-site'"],
  ['unit ordering',"UPDATE ad_units SET sort_order=2 WHERE publisher_id='test-site'"],
  ['unit addition',"INSERT INTO ad_units VALUES('test-site','P1','BTF','banner','display',1,1)"],
  ['unit deletion',"DELETE FROM ad_units WHERE publisher_id='test-site'"],
  ['bidder',`INSERT INTO bidders VALUES('test-site','ix','{"siteId":"synthetic"}',1)`],
  ['override',`INSERT INTO bidder_overrides VALUES('test-site','ix','device','mobile','{"siteId":"synthetic"}',1)`],
  ['size map',"UPDATE size_maps SET map_json='[]' WHERE publisher_id='test-site'"],
  ['map addition',"INSERT INTO size_maps VALUES('test-site','other','[]')"],
  ['rule',"UPDATE unit_rules SET rule_json='{}' WHERE publisher_id='test-site'"],
  ['current Prebid',"INSERT INTO prebid_builds VALUES('build-1','test-site','1.0.0','key','[]','current','2026-01-01')"],
];
for(const [name,sql] of changes)test(`a changed ${name} between validation and transaction aborts before the update`,async()=>{const x=f(),s=x.snapshot();x.onBatch(()=>x.sqlite.exec(sql));await assert.rejects(x.save(s),conflict);assert.equal(x.count('audit_log'),0);assert.equal(x.count('builtin_draft_assertions'),0);assert.equal(x.commits(),0);if(name!=='configuration')assert.equal(x.config().config_json,oldConfig);});
test('even a no-change proposal refuses a stale map snapshot',async()=>{const x=f(),s=x.snapshot();x.sqlite.exec("DELETE FROM size_maps WHERE publisher_id='test-site'");await assert.rejects(x.save(s,oldConfig),conflict);assert.equal(x.count('audit_log'),0);});
test('an unrelated site cannot cause or receive this update',async()=>{const x=f(),s=x.snapshot();x.sqlite.exec("INSERT INTO publishers VALUES('other','Other','other.invalid','/123/other/'); INSERT INTO publisher_configs VALUES('other','{}','untouched','untouched'); INSERT INTO size_maps VALUES('other','display','[]')");await x.save(s);assert.deepEqual({...x.sqlite.prepare("SELECT * FROM publisher_configs WHERE publisher_id='other'").get()},{publisher_id:'other',config_json:'{}',config_hash:'untouched',updated_at:'untouched'});});
test('archived Prebid metadata does not alter the current-build projection',async()=>{const x=f(),s=x.snapshot();x.sqlite.exec("INSERT INTO prebid_builds VALUES('old','test-site','1.0.0','key','[]','archived','2026-01-01')");await x.save(s);assert.equal(x.config().config_json,nextConfig);});
test('more than one current build appearing during a race is caught',async()=>{const x=f(),s=x.snapshot();x.onBatch(()=>x.sqlite.exec("INSERT INTO prebid_builds VALUES('a','test-site','1.0.0','key','[]','current','2026-01-01'); INSERT INTO prebid_builds VALUES('b','test-site','1.0.0','key','[]','current','2026-01-02')"));await assert.rejects(x.save(s),conflict);});
for(const at of [0,1,2,3,4])test(`failure at transaction statement ${at} rolls back configuration and audit together`,async()=>{const x=f();x.faults.at=at;await assert.rejects(x.save(),(e)=>e.code==='save_unconfirmed'&&e.status===503&&!e.message.includes('private'));assert.equal(x.config().config_json,oldConfig);assert.equal(x.count('audit_log'),0);assert.equal(x.count('builtin_draft_assertions'),0);});
test('lost response AFTER commit reports uncertainty without undoing a successful selection',async()=>{const x=f();x.faults.after=true;await assert.rejects(x.save(),{code:'save_unconfirmed',status:503});assert.equal(x.config().config_json,nextConfig);assert.equal(x.count('audit_log'),1);x.faults.after=false;const retry=await x.save(x.snapshot(),nextConfig);assert.equal(retry.changed,false);assert.equal(x.count('audit_log'),1);});
test('JSON comparisons preserve Unicode, quotes, backslashes and null values',async()=>{const x=f();x.sqlite.prepare("UPDATE publishers SET name=? WHERE id='test-site'").run('Žurnal \\ " test\n😊');x.sqlite.exec("UPDATE ad_units SET size_map_key=NULL WHERE publisher_id='test-site'");await x.save();assert.equal(x.config().config_json,nextConfig);});
test('SQL-looking values stay bound data rather than becoming query text',async()=>{const x=f();x.sqlite.prepare("UPDATE publishers SET name=? WHERE id='test-site'").run("'; DELETE FROM publishers; --");await x.save();assert.equal(x.count('publishers'),1);});
test('row object property ordering is not a spurious conflict',async()=>{const x=f(),s=x.snapshot();s.units[0]=Object.fromEntries(Object.entries(s.units[0]).reverse());await x.save(s);});
for(const change of [s=>delete s.prebidBuilds,s=>{s.site.id='politika';},s=>{s.site.gam_path='/23339552141/Politika.rs/';},s=>{s.units[0].extra='not-projected';},s=>{s.units[0].sort_order=Infinity;},s=>{s.rules.length=2;}])test('incomplete or out-of-scope snapshot is refused before a transaction',async()=>{const x=f(),s=x.snapshot();change(s);await assert.rejects(x.save(s));assert.equal(x.commits(),0);assert.equal(x.config().config_json,oldConfig);});
test('getter properties are not executed when reading reviewed rows',async()=>{const x=f(),s=x.snapshot();let read=false;Object.defineProperty(s.site,'name',{get(){read=true;throw Error('getter');},enumerable:true});await assert.rejects(x.save(s));assert.equal(read,false);});
test('caller mutation after the first await cannot alter SQL bindings',async()=>{const x=f(),s=x.snapshot();const running=x.save(s);s.config.config_json='{}';await running;assert.equal(x.config().config_json,nextConfig);});
test('Prebid enablement is outside this first test writer scope',async()=>{const x=f();await assert.rejects(x.save(x.snapshot(),'{"enablePrebid":true}'),{code:'test_mode_required'});assert.equal(x.commits(),0);});
test('missing explicit isolated-store marker is refused',async()=>{const x=f();await assert.rejects(commitTestRuntimeSelection({db:x.db},{snapshot:x.snapshot(),configJson:nextConfig,actor:'tester'}),{code:'test_store_required'});});
test('oversized or missing actor cannot enter the write transaction',async()=>{const x=f();for(const actor of ['',null,'x'.repeat(321),'a\nb'])await assert.rejects(x.save(x.snapshot(),nextConfig,{actor}));assert.equal(x.commits(),0);});
