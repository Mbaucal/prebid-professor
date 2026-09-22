/** Additive inventory sync. The receipt, new maps and new units commit in ONE
 * D1 transaction. Existing rows/configuration and published packages are kept.
 * No migration or cross-store transaction with Google is assumed. */
import {GamError,parseSizes} from '../../shared/gam/plan.mjs';
import {sizeMapDefaults,inferMapKey,sizeLabel} from '../../shared/inventory/defaults.mjs';
const fail=(message,status=422)=>{throw new GamError(message,status);};
const hash=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(x=>x.toString(16).padStart(2,'0')).join('');
const specs=[
 ['site','publishers',['id','name','domain','gam_path','created_at','updated_at'],'id=?',true],
 ['config','publisher_configs',['id','config_json','config_hash','updated_at'],'publisher_id=?',true],
 ['units','ad_units',['id','code','type','media_type','size_map_key','enabled','sort_order','notes','created_at','updated_at'],'publisher_id=? ORDER BY code'],
 ['maps','size_maps',['id','name','map_json','created_at','updated_at'],'publisher_id=? ORDER BY name'],
];
const path=value=>String(value??'').replace(/\/+$/,'');
export function siteInventoryStore(env,{siteScope=null,inventoryGuard,inventoryValidator}={}){
 async function database(siteId){
  if(siteId!==undefined&&(typeof siteId!=='string'||!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId)))fail('Izaberite postojeći Tessera sajt.');
  if(siteScope&&siteId!==undefined&&siteId!==siteScope)fail('Ovaj sajt nije dostupan u ovom radnom okruženju.',404);
  await inventoryGuard?.();
  const db=env.DB?.withSession('first-primary');if(!db)fail('Skladište sajtova nije dostupno.',503);return db;
 }
 async function read(siteId){
  const db=await database(siteId),snapshot={};
  const results=await db.batch(specs.map(([,table,cols,where])=>db.prepare(`SELECT ${cols.join(',')} FROM ${table} WHERE ${where}`).bind(siteId)));
  for(let i=0;i<specs.length;i++){
   const r=results[i];if(r?.success!==true||!Array.isArray(r.results))fail('Inventar sajta nije moguće proveriti.',503);
   if(r.results.length>1000)fail('Inventar premašuje opseg jednog unosa.');
   snapshot[specs[i][0]]=specs[i][4]?r.results[0]:r.results;
  }
  if(!snapshot.site)fail('Sajt nije pronađen.',404);
  if(!snapshot.config)fail('Prvo sačuvajte konfiguraciju ovog sajta.',409);
  if(JSON.stringify(snapshot).length>1024*1024)fail('Inventar premašuje opseg jednog unosa.');
  return {snapshot,revision:await hash(snapshot)};
 }
 async function receipt(siteId,resultId){
  const db=await database(siteId);
  const row=await db.prepare("SELECT a.details_json FROM audit_log a JOIN publishers p ON p.id=a.publisher_id WHERE a.id=? AND a.publisher_id=? AND json_extract(a.details_json,'$.siteCreatedAt')=p.created_at").bind(`gam-site:${resultId}:${siteId}`,siteId).first();
  return row?JSON.parse(row.details_json):null;
 }
 async function commit(plan,actor,resultId){
  const siteId=plan.snapshot.site.id,known=await receipt(siteId,resultId);if(known)return known;
  const db=await database(siteId),receiptId=`gam-site:${resultId}:${siteId}`,nonce=crypto.randomUUID(),stamp=new Date().toISOString();
  const conditions=[],args=[];
  for(const [key,table,cols,where,single]of specs){
   conditions.push(`(SELECT json_group_array(json_array(${cols.join(',')})) FROM (SELECT ${cols.join(',')} FROM ${table} WHERE ${where}))=?`);
   args.push(siteId,JSON.stringify((single?[plan.snapshot[key]]:plan.snapshot[key]).map(r=>cols.map(c=>r[c]))));
  }
  const saved={state:'saved',siteId,siteName:plan.snapshot.site.name,siteCreatedAt:plan.snapshot.site.created_at,resultId,nonce,createdAt:stamp,addedUnits:plan.units.length,addedMaps:plan.maps.length,rows:plan.rows,warnings:plan.warnings,published:false};
  const gate='EXISTS (SELECT 1 FROM audit_log WHERE id=? AND json_extract(details_json,\'$.nonce\')=?)';
  const writes=[db.prepare(`INSERT INTO audit_log(id,actor,action,publisher_id,details_json) SELECT ?,?,?,?,? WHERE ${conditions.join(' AND ')} ON CONFLICT(id) DO NOTHING`).bind(receiptId,actor,'gam.site_inventory_synced',siteId,JSON.stringify(saved),...args)];
  if(plan.maps.length)writes.push(db.prepare(`INSERT INTO size_maps(id,publisher_id,name,map_json) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.name'),json_extract(value,'$.map_json') FROM json_each(?) WHERE ${gate}`).bind(siteId,JSON.stringify(plan.maps),receiptId,nonce));
  if(plan.units.length)writes.push(db.prepare(`INSERT INTO ad_units(id,publisher_id,code,type,media_type,size_map_key,enabled,sort_order) SELECT json_extract(value,'$.id'),?,json_extract(value,'$.code'),json_extract(value,'$.type'),'banner',json_extract(value,'$.size_map_key'),1,json_extract(value,'$.sort_order') FROM json_each(?) WHERE ${gate}`).bind(siteId,JSON.stringify(plan.units),receiptId,nonce));
  if(plan.maps.length||plan.units.length)writes.push(db.prepare(`UPDATE publisher_configs SET config_hash=NULL,updated_at=? WHERE publisher_id=? AND ${gate}`).bind(stamp,siteId,receiptId,nonce));
  try{const result=await db.batch(writes);if(result?.length!==writes.length||result.some(r=>r.success!==true))throw Error();}
  catch{fail('Upis u sajt nije potvrđen. Ponovo učitajte sajt ili otvorite „Proveri upis u sajt“ u istoriji.',503);}
  const actual=await receipt(siteId,resultId);
  if(!actual)fail('Sajt je izmenjen od pregleda. Ponovo proverite upis u sajt; GAM ne treba ponovo kreirati.',409);
  return actual;
 }
 return {read,receipt,commit,validate:inventoryValidator,async links(resultId){
  const db=await database();
  const r=await db.prepare(`SELECT a.details_json FROM audit_log a JOIN publishers p ON p.id=a.publisher_id WHERE a.action='gam.site_inventory_synced' AND json_extract(a.details_json,'$.resultId')=? AND json_extract(a.details_json,'$.siteCreatedAt')=p.created_at ${siteScope?'AND a.publisher_id=?':''} ORDER BY a.created_at DESC LIMIT 100`).bind(resultId,...(siteScope?[siteScope]:[])).all();
  if(r.success!==true)fail('Sačuvane veze nisu dostupne.',503);return r.results.map(row=>JSON.parse(row.details_json));
 },async list(){
  const db=await database();const r=await db.prepare(`SELECT id,name,gam_path AS gamPath FROM publishers ${siteScope?'WHERE id=?':''} ORDER BY name LIMIT 1001`).bind(...(siteScope?[siteScope]:[])).all();
  if(r.success!==true)fail('Sajtovi nisu dostupni.',503);if(r.results.length>1000)fail('Previše sajtova za ovaj pregled.');return r.results;
 }};
}
export async function planSiteInventory(store,siteId,{rows=[],parentPath=null,revision=null}={}){
 const saved=await store.read(siteId),snapshot=saved.snapshot;
 if(revision&&revision!==saved.revision)fail('Sajt je izmenjen od pregleda. Ponovo proverite pre nastavka.',409);
 if(parentPath&&path(snapshot.site.gam_path)!==path(parentPath))fail(`GAM putanja sajta je ${snapshot.site.gam_path}, a izabrani parent je ${parentPath}/. Izaberite odgovarajući parent ili izmenite GAM putanju u podešavanjima sajta.`,409);
 const maps=Object.entries(sizeMapDefaults).filter(([name])=>!snapshot.maps.some(m=>m.name===name)).map(([name,map])=>({id:crypto.randomUUID(),name,map_json:JSON.stringify(map)}));
 const units=[],bindings=[],warnings=[];let order=Math.max(0,...snapshot.units.map(u=>u.sort_order));
 for(const row of rows){
  if(row.path&&row.path!==`${path(snapshot.site.gam_path)}/${row.code}`)fail(`GAM putanja za ${row.code} ne odgovara izabranom sajtu.`,409);
  const existing=snapshot.units.find(u=>u.code===row.code),collision=snapshot.units.find(u=>u.code.toLowerCase()===row.code.toLowerCase()&&u.code!==row.code);
  if(collision)fail(`Sajt već ima ${collision.code}; uskladite velika i mala slova za ${row.code}.`,409);
  if(existing&&existing.media_type!=='banner')fail(`${row.code} već postoji kao ${existing.media_type}. Pregledajte poziciju pre povezivanja.`,409);
  const key=existing?.size_map_key||row.mapKey||inferMapKey(row.code)||`GAM_${row.code}`;
  let map=snapshot.maps.find(m=>m.name===key)||maps.find(m=>m.name===key);
  if(!map){
   const sizes=parseSizes(row.sizes);map={id:crypto.randomUUID(),name:key,map_json:JSON.stringify([{minViewPort:[0,0],sizes:[...sizes.sizes.map(s=>[s.width,s.height]),...(sizes.fluid?['fluid']:[])]}])};maps.push(map);
  }
  if(existing&&!existing.size_map_key)fail(`${row.code} nema mapu u sajtu. Izaberite mapu pre povezivanja.`,409);
  if(existing&&existing.size_map_key!==(row.mapKey||inferMapKey(row.code)))warnings.push(`${row.code}: zadržana postojeća mapa ${existing.size_map_key}.`);
  if(row.differences?.includes('veličine'))warnings.push(`${row.code}: GAM ima drugačije veličine; postojeći GAM podaci ostaju sačuvani.`);
  const actual=parseSizes(row.sizes),available=new Set([...actual.sizes.map(s=>`${s.width}x${s.height}`),...(actual.fluid?['fluid']:[])]);
  let rules;try{rules=JSON.parse(map.map_json);}catch{fail(`Mapa ${key} nije ispravna. Pregledajte je u sajtu.`,409);}
  const missing=[...new Set(rules.flatMap(r=>r.sizes.map(sizeLabel)))].filter(size=>!available.has(size));
  if(missing.length)warnings.push(`${row.code}: mapa ${key} uključuje veličine van ovog GAM unita (${missing.join(', ')}). Prilagodite mapu ili GAM veličine pre Generate / Publish.`);
  const unit=existing||{id:crypto.randomUUID(),code:row.code,type:['Sticky','Billboard','Branding_Map'].includes(key)?'ATF':'BTF',size_map_key:key,sort_order:++order};
  if(!existing)units.push(unit);
  bindings.push({code:row.code,id:row.id??null,path:row.path??`${path(snapshot.site.gam_path)}/${row.code}`,sizes:row.sizes,mapKey:key,localId:unit.id,state:existing?'existing':'new'});
 }
 if(snapshot.units.length+units.length>1000||snapshot.maps.length+maps.length>1000)fail('Inventar premašuje opseg jednog unosa.');
 await store.validate?.({snapshot,maps,units});
 return {snapshot,revision:saved.revision,maps,units,rows:bindings,warnings};
}
export function sitePlanSummary(plan){return {siteId:plan.snapshot.site.id,siteName:plan.snapshot.site.name,revision:plan.revision,addedMaps:plan.maps.map(m=>m.name),addedUnits:plan.units.length,existingUnits:plan.rows.length-plan.units.length,warnings:plan.warnings,rows:plan.rows};}
