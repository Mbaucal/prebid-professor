/** Size-map rename cascade, delete confirmation and the ADM-5 rule gate on the actual
 * compiled production Worker with local Miniflare D1 (not node:sqlite). Synthetic site,
 * no hosted API, bindings or outbound traffic. Run after `isolated-toolchain.mjs build`.
 */
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from './local-miniflare.mjs';
const directory=await mkdtemp(join(tmpdir(),'size-map-references-workerd-'));
const origin='https://maps.example.invalid',email='maps@example.invalid',password=randomBytes(24).toString('hex');
let outbound=0;
const mf=new Miniflare({modules:true,script:await readFile('dist/prebid_professor/index.js','utf8'),compatibilityDate:'2026-07-15',compatibilityFlags:['nodejs_compat'],cf:false,
 host:'127.0.0.1',port:0,resourcePersistencePath:directory,d1Databases:{DB:'maps-d1'},r2Buckets:{BUILDS:'maps-r2'},
 bindings:{ADMIN_EMAIL:email,ADMIN_PASSWORD:password,SESSION_SECRET:randomBytes(48).toString('hex')},
 outboundService:()=>{outbound++;return new Response('External traffic forbidden.',{status:503});}});
const checks=[];const check=(name,value)=>{assert(value,name);checks.push({name,passed:true});};
const site='maps',P=[{minViewPort:[0,0],sizes:[[300,250],[300,600]]},{minViewPort:[768,0],sizes:[[300,600],[160,600]]}],NP=[{minViewPort:[0,0],sizes:[[300,250]]}];
// CSV-imported names the generators select (diacritics, dot, leading digit) and names that stress
// json_group_array(json_array(...)) against JSON.stringify in the all-maps gate.
const CSV_NAMES=['članak_P','naslovna.v2_P','1x_P','quote"name','back\\slash','tab\tname','emoji😀name','ls name'];
try{
 const db=await mf.getD1Database('DB');
 for(const [file,stop] of [['0001_initial.sql','INSERT OR IGNORE INTO publishers'],['0002_publisher_accounts.sql','-- Politika.rs']]){
  for(const statement of (await readFile('migrations/'+file,'utf8')).split(stop)[0].split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 }
 const login=await mf.dispatchFetch(origin+'/api/auth/login',{method:'POST',redirect:'manual',headers:{origin,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email,password})});
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 const call=(path,body,method=body?'POST':'GET')=>mf.dispatchFetch(origin+path,{method,headers:{cookie,origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
 const json=async(path,body,method)=>{const response=await call(path,body,method);return {status:response.status,data:await response.json()};};
 const api='/api/publishers/'+site;
 assert.equal((await call('/api/sites',{id:site,name:'Maps',domain:'maps.example.invalid',gamPath:'/123/maps/'})).status,201);
 for(const [id,name,rows] of [['p-map','P',P],['np-map','naslovna_P',NP],['home-map','home',NP]])await db.prepare('INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES(?,?,?,?)').bind(id,site,name,JSON.stringify(rows)).run();
 for(const [index,code] of ['P1','P2'].entries())await db.prepare("INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,sort_order) VALUES(?,?,?,'BTF','banner','P',?)").bind('unit-'+code,site,code,index).run();
 const quoted=name=>'"'+name.replaceAll('"','""')+'"';
 const imported=await json(api+'/imports/apply',{kind:'size-maps',csv:'name,minWidth,sizes\n'+CSV_NAMES.map(name=>quoted(name)+',0,300x250').join('\n')+'\n'});
 assert.equal(imported.status,200,JSON.stringify(imported.data));
 const names=async()=>(await db.prepare('SELECT name FROM size_maps WHERE publisher_id=? ORDER BY name').bind(site).all()).results.map(row=>row.name);
 check('Size-map CSV import stores names with diacritics, dots, digits, quotes, backslashes, tabs and emoji on D1',(await names()).filter(name=>CSV_NAMES.includes(name)).length===CSV_NAMES.length);
 const rule=await json(api+'/unit-rules',{ruleKey:'P1',rule:{conditionalMappings:[{name:'Home exact',enabled:true,priority:100,match:'all',conditions:[{key:'category',operator:'equals',value:'Naslovna'}],sizeMapKey:'naslovna_P',slotAction:'inherit'},{name:'Article',enabled:true,priority:90,match:'all',conditions:[{key:'category',operator:'equals',value:'Članak'}],sizeMapKey:'članak_P',slotAction:'inherit'}]}});
 check('ADM-5: a rule save whose maps exist passes the json_each gate on D1 (one write, diacritic map name)',rule.status===201);
 const config=JSON.parse((await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').bind(site).first()).config_json);
 config.runtimeControls={...config.runtimeControls,outstream:{schemaVersion:1,units:{P2:{format:'banner-outstream',playerSizing:'size-map',playerSizes:{'P@0x0':[300,250],'naslovna_P@0x0':[300,250],'članak_P@0x0':[300,250]}}}}};
 await db.prepare('UPDATE publisher_configs SET config_json=? WHERE publisher_id=?').bind(JSON.stringify(config),site).run();
 const listing=(await json(api+'/size-maps')).data.sizeMaps;
 const labels=name=>listing.find(row=>row.name===name)?.references.map(row=>row.label)??[];
 check('Listing shows implicit page-type and Outstream use from D1 rows',labels('naslovna_P').includes('Page type naslovna: P1, P2 (via P)')&&labels('članak_P').includes('Page type članak: P1, P2 (via P)')&&labels('naslovna_P').includes('P2: Outstream video sizes')&&labels('1x_P').includes('Page type 1x: P1, P2 (via P)'));
 const audits=async()=>(await db.prepare("SELECT details_json FROM audit_log WHERE publisher_id=? AND entity_type='size_map' ORDER BY created_at").bind(site).all()).results.map(row=>JSON.parse(row.details_json));
 const renamed=await json(api+'/size-maps/p-map',{name:'X',map:P},'PATCH');
 check('Cascade rename commits through the all-maps json_group_array gate on D1',renamed.status===200);
 const after=await names();
 check('Page-type maps follow the base, odd names stay as saved',['X','naslovna_X','članak_X','naslovna.v2_X','1x_X'].every(name=>after.includes(name))&&!after.includes('P')&&!after.includes('naslovna_P')&&CSV_NAMES.filter(name=>!name.endsWith('_P')).every(name=>after.includes(name)));
 const units=(await db.prepare('SELECT size_map_key FROM ad_units WHERE publisher_id=?').bind(site).all()).results;
 const rows=(await db.prepare('SELECT rule_json FROM unit_rules WHERE publisher_id=?').bind(site).all()).results.map(row=>JSON.parse(row.rule_json));
 const saved=JSON.parse((await db.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id=?').bind(site).first()).config_json);
 check('Units, rule rows, the config mirror and Outstream keys follow in the same batch',units.every(row=>row.size_map_key==='X')
  &&JSON.stringify(rows[0].conditionalMappings.map(m=>m.sizeMapKey))==='["naslovna_X","članak_X"]'
  &&JSON.stringify(saved.unitRules.P1.conditionalMappings.map(m=>m.sizeMapKey))==='["naslovna_X","članak_X"]'
  &&JSON.stringify(Object.keys(saved.runtimeControls.outstream.units.P2.playerSizes).sort())==='["X@0x0","naslovna_X@0x0","članak_X@0x0"]');
 const audit=(await audits()).at(-1);
 check('One audit row records the carried page-type maps',(await audits()).length===1&&audit.pageTypeMaps.map(([from])=>from).sort().join()==='1x_P,naslovna.v2_P,naslovna_P,članak_P');
 const edited=await json(api+'/size-maps/home-map',{name:'home',map:P},'PATCH');
 check('A sizes-only edit commits through the single-row gate on D1',edited.status===200&&(await audits()).length===2);
 const id=(await db.prepare("SELECT id FROM size_maps WHERE publisher_id=? AND name='1x_X'").bind(site).first()).id;
 const first=await json(api+'/size-maps/'+id,undefined,'DELETE');
 check('Deleting a page-type map asks for confirmation with the exact impact',first.status===409&&first.data.details.confirmation.changes.map(c=>c.message).join()==='Page type 1x: P1, P2 will use X instead of 1x_X.'&&/Reload size maps to review and confirm this change\.$/.test(first.data.error));
 const forged=await json(api+'/size-maps/'+id,{confirmPageTypeChanges:'0'.repeat(64)},'DELETE');
 await db.prepare("INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,sort_order) VALUES('unit-P3',?,'P3','BTF','banner','X',2)").bind(site).run();
 const stale=await json(api+'/size-maps/'+id,{confirmPageTypeChanges:first.data.details.confirmation.token},'DELETE');
 check('Forged and stale tokens are refused with the fresh impact, nothing deleted',forged.status===409&&stale.status===409&&stale.data.details.confirmation.changes[0].message==='Page type 1x: P1–P3 will use X instead of 1x_X.'&&(await names()).includes('1x_X'));
 const confirmed=await json(api+'/size-maps/'+id,{confirmPageTypeChanges:stale.data.details.confirmation.token},'DELETE');
 check('The fresh token deletes through the all-maps gate on D1',confirmed.status===200&&!(await names()).includes('1x_X')&&(await audits()).at(-1).pageTypeChanges?.[0]==='Page type 1x: P1–P3 will use X instead of 1x_X.');
 // ADM-5 gate predicate, exactly as appended to the rule-save config CAS, evaluated by D1.
 const gate=async list=>(await db.prepare('SELECT (SELECT count(*) FROM size_maps WHERE publisher_id = ? AND name IN (SELECT value FROM json_each(?))) = ? AS ok').bind(site,JSON.stringify(list),list.length).first()).ok;
 check('ADM-5 json_each gate on D1: true while every selected map exists, false after a rename',await gate(['naslovna_X','članak_X','quote"name'])===1&&await gate(['naslovna_P'])===0&&await gate([])===1);
 const raced=await json(api+'/unit-rules',{ruleKey:'P2',rule:{conditionalMappings:[{name:'Old name',enabled:true,priority:100,match:'all',conditions:[{key:'category',operator:'equals',value:'Naslovna'}],sizeMapKey:'naslovna_P',slotAction:'inherit'}]}});
 check('A rule that still names the old map is refused before any write',raced.status===422&&/naslovna_P/.test(raced.data.error));
 check('No outbound fetch was attempted',outbound===0);
 await mkdir('.generated/size-map-references-ui',{recursive:true});
 const report={scope:'compiled production Worker + local Miniflare D1; NOT hosted Cloudflare',checks,passed:checks.length,failed:0,outbound};
 await writeFile('.generated/size-map-references-ui/workerd.json',JSON.stringify(report,null,2)+'\n');
 console.log('PASS '+checks.length+' compiled Worker size-map checks on local D1');
}catch(error){console.error(JSON.stringify({scope:'compiled Worker size-map checks',failed:1,error:String(error?.message||error).slice(0,500),checks,outbound}));process.exitCode=1;}
finally{await mf.dispose();await rm(directory,{recursive:true,force:true});}
