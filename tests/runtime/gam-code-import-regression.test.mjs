import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {previewCsvImport,applyCsvImport} from '../../worker/imports.ts';
import {createAdUnit,updateAdUnit,duplicateAdUnit,listAdUnits} from '../../worker/ad-units.ts';
import {normalizeCsvForApi} from '../../src/csv.ts';

// Real application handlers and SQL schema, with local in-memory storage only.
function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 for(const file of readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort())sqlite.exec(readFileSync('migrations/'+file,'utf8'));
 sqlite.prepare("INSERT INTO publishers(id,name,domain,gam_path) VALUES('qa','QA','qa.invalid','/123/qa/')").run();
 sqlite.prepare("INSERT INTO publisher_configs(id,publisher_id,config_json) VALUES('cfg','qa','{}')").run();
 // The units below name this saved map: ad-unit writes refuse a size map that does not exist (F3).
 sqlite.prepare("INSERT INTO size_maps(id,publisher_id,name,map_json) VALUES('display-map','qa','display',?)").run(JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}]));
 function prepare(sql,args=[]){return{sql,args,bind(...values){return prepare(sql,values);},async first(){return sqlite.prepare(sql).get(...args)??null;},async all(){return{success:true,results:sqlite.prepare(sql).all(...args),meta:{changes:0}};},async run(){return{success:true,meta:{changes:Number(sqlite.prepare(sql).run(...args).changes)}};}};}
 const env={DB:{prepare,async batch(items){sqlite.exec('BEGIN IMMEDIATE');try{const result=items.map(({sql,args})=>{const stmt=sqlite.prepare(sql);return stmt.columns().length?{success:true,results:stmt.all(...args),meta:{changes:0}}:{success:true,meta:{changes:Number(stmt.run(...args).changes)}};});sqlite.exec('COMMIT');return result;}catch(error){sqlite.exec('ROLLBACK');throw error;}}}};
 return{env,sqlite,close(){sqlite.close();}};
}
const request=body=>new Request('https://qa.invalid/api',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const csvCell=value=>'"'+String(value).replaceAll('"','""')+'"';
const csvFor=(codes,note='original')=>normalizeCsvForApi('code,type,mediaType,sizeMapKey,enabled,sortOrder,notes\n'+codes.map((code,i)=>[code,'BTF','banner','display','true',i,note].map(csvCell).join(',')).join('\n'));
const validCodes=['m.box_3','m.InText_1','123_box','under_score','with-dash','with.period','with*asterisk','with!bang','with<angle','with:colon','with/slash','with\\backslash','with(parentheses)','with"quote','Članak_1','A'.repeat(100),'_start','-start','.start','*start','!start','<start',':start','(start)','"start','\\start','__proto__','constructor','prototype','toString','</script','x"<img'];

test('CSV preview/apply/update/reopen preserve legal GAM codes exactly, including Republica periods',async()=>{
 const f=fixture();try{
  const body={kind:'ad-units',csv:csvFor(validCodes)};
  const preview=await previewCsvImport(request(body),f.env,'qa'),result=await preview.json();
  assert.equal(preview.status,200);assert.equal(result.preview.errorCount,0,JSON.stringify(result.preview.rows.filter(r=>r.errors.length)));
  assert.deepEqual(result.preview.rows.map(r=>r.key),validCodes);
  const applied=await applyCsvImport(request(body),f.env,'qa');assert.equal(applied.status,200,await applied.clone().text());
  const before=f.sqlite.prepare('SELECT id,code FROM ad_units ORDER BY sort_order').all();assert.deepEqual(before.map(u=>u.code),validCodes);
  const changed={kind:'ad-units',csv:csvFor(validCodes,'updated')};
  const again=await(await previewCsvImport(request(changed),f.env,'qa')).json();assert.equal(again.preview.updateCount,validCodes.length);assert.equal(again.preview.createCount,0);
  assert.equal((await applyCsvImport(request(changed),f.env,'qa')).status,200);
  assert.deepEqual(f.sqlite.prepare('SELECT id,code FROM ad_units ORDER BY sort_order').all(),before,'existing IDs cannot be renamed/recreated by CSV update');
  const read=await(await listAdUnits(f.env,'qa')).json();assert.deepEqual(read.adUnits.map(u=>u.code),validCodes);
  assert(!before.some(u=>u.code==='m_box_3'||u.code==='m_InText_1'));
 }finally{f.close();}
});

test('manual create/edit/duplicate share CSV code support and preserve literal quotes/backslashes',async()=>{
 const f=fixture();try{
  for(const code of validCodes){const response=await createAdUnit(request({code,type:'BTF',sizeMapKey:'display'}),f.env,'qa');assert.equal(response.status,201,code+': '+await response.clone().text());assert.equal((await response.json()).adUnit.code,code);}
  const source=f.sqlite.prepare('SELECT id FROM ad_units WHERE code=?').get('m.box_3');
  const edit=await updateAdUnit(request({code:'m.box_4',notes:'updated'}),f.env,'qa',source.id);assert.equal(edit.status,200,await edit.clone().text());assert.equal((await edit.json()).adUnit.code,'m.box_4');
  const duplicate=await duplicateAdUnit(request({code:'m.box_5'}),f.env,'qa',source.id);assert.equal(duplicate.status,201,await duplicate.clone().text());assert.equal((await duplicate.json()).adUnit.code,'m.box_5');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ad_units WHERE code IN (?,?)').get('m.box_4','m.box_5').n,2);
 }finally{f.close();}
});

test('invalid GAM input rejects the entire CSV before writes, with equivalent manual validation',async()=>{
 const invalid=['/leading','bad code','bad\tcode','bad\ncode','bad>code','bad&code','bad=code','bad\u0000code','A'.repeat(101),'</script><script>alert(1)</script>','x" onerror="alert(1)','bad;code','=SUM(1)','+start'];
 for(const code of invalid){const f=fixture();try{
  const body={kind:'ad-units',csv:csvFor(['m.box_3',code])};
  const preview=await(await previewCsvImport(request(body),f.env,'qa')).json();assert.equal(preview.preview.errorCount,1,JSON.stringify({code,preview}));
  assert.equal((await applyCsvImport(request(body),f.env,'qa')).status,422,JSON.stringify(code));
  assert.equal((await createAdUnit(request({code,type:'BTF'}),f.env,'qa')).status,422,JSON.stringify(code));
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ad_units').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM audit_log').get().n,0);
 }finally{f.close();}}
});

test('GAM codes matching JavaScript object keys remain ordinary persisted data',async()=>{
 const f=fixture();try{
  const codes=['__proto__','constructor','prototype','toString'];
  const before=Object.getOwnPropertyNames(Object.prototype);
  const body={kind:'ad-units',csv:csvFor(codes)};
  const response=await applyCsvImport(request(body),f.env,'qa');assert.equal(response.status,200,await response.clone().text());
  assert.deepEqual(f.sqlite.prepare('SELECT code FROM ad_units ORDER BY sort_order').all().map(row=>row.code),codes);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype),before);
  for(const code of codes){const row=f.sqlite.prepare('SELECT id FROM ad_units WHERE code=?').get(code);const response=await updateAdUnit(request({code,notes:'safe ordinary update'}),f.env,'qa',row.id);assert.equal(response.status,200,code+': '+await response.clone().text());assert.equal((await response.json()).adUnit.code,code);}
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype),before);
 }finally{f.close();}
});

test('literal duplicate code is rejected without transforming dot codes into underscore codes',async()=>{
 const f=fixture();try{
  const distinct={kind:'ad-units',csv:csvFor(['m.box_3','m_box_3'])};assert.equal((await applyCsvImport(request(distinct),f.env,'qa')).status,200);
  const duplicate={kind:'ad-units',csv:csvFor(['m.box_3','m.box_3'])};const result=await(await previewCsvImport(request(duplicate),f.env,'qa')).json();
  assert.equal(result.preview.errorCount,1);assert.match(result.preview.rows[1].errors.join(' '),/Duplicate/);
  assert.equal((await applyCsvImport(request(duplicate),f.env,'qa')).status,422);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM ad_units').get().n,2);
 }finally{f.close();}
});
