import {WorkspaceError,jsonBody} from './boundary.mjs';
import {inspectTestSchema} from './schema.mjs';
import {CACHE_POSITIONS} from '../experiments/position-cache-settings.mjs';

export const NAMED_TEST_SITE='test-named-script';
const SOURCE_TREE='e3ea81d240b1ad4f5f44fc59dba162d6bf0ef777';
const marker={schemaVersion:1,candidateOnly:true,sourceTree:SOURCE_TREE};
const domains=['tanjug.rs','www.tanjug.rs'].flatMap(domain=>['','http://','https://'].flatMap(protocol=>[protocol+domain,protocol+domain+'/']));
const domainPlaceholders=domains.map(()=>'?').join(',');
const collision='The reviewed Tanjug identity is already used by another TEST draft. Existing drafts were not overwritten. Keep that draft and ask the PM to review the test setup.';
async function database(env){
  if(!(await inspectTestSchema(env.DB)).ready)throw new WorkspaceError(409,'Prepare the TEST workspace from Home first.');
  if(!env.BUILDS)throw new WorkspaceError(503,'The isolated test storage is not connected.');
  return env.DB.withSession('first-primary');
}
async function state(db){
  // Refuse canonical domain aliases too: the shared named generator accepts them.
  const row=await db.prepare('SELECT p.id,p.domain,p.gam_path,c.config_json FROM publishers p LEFT JOIN publisher_configs c ON c.publisher_id=p.id WHERE p.id=? OR lower(trim(p.domain)) IN ('+domainPlaceholders+')').bind(NAMED_TEST_SITE,...domains).all();
  if(row.results.some(r=>r.id!==NAMED_TEST_SITE))throw new WorkspaceError(409,collision);
  if(!row.results.length)return {ready:false,siteId:NAMED_TEST_SITE};
  const saved=row.results[0];let config;
  try{config=JSON.parse(saved.config_json);}catch{}
  if(saved.domain!=='tanjug.rs'||saved.gam_path!=='/22852026051/Tanjug.rs-Display/'
    ||JSON.stringify(config?.testNamedScript)!==JSON.stringify(marker)||typeof config.enablePrebid!=='boolean'||config.builtinRuntimeSelection){
    throw new WorkspaceError(409,'The named-script TEST copy does not match its reviewed identity. Nothing was changed.');
  }
  const units=await db.prepare('SELECT code,type,enabled,sort_order FROM ad_units WHERE publisher_id=? ORDER BY sort_order').bind(NAMED_TEST_SITE).all();
  if(JSON.stringify(units.results)!==JSON.stringify(CACHE_POSITIONS.map((code,sort_order)=>({code,type:['Billboard','Branding_Left','Branding_Right','P1','Sticky'].includes(code)?'ATF':'BTF',enabled:1,sort_order})))){
    throw new WorkspaceError(409,'The named-script TEST inventory is incomplete or changed. Nothing was repaired.');
  }
  return {ready:true,siteId:NAMED_TEST_SITE,positions:CACHE_POSITIONS,sourceTree:SOURCE_TREE};
}
export async function namedScriptStatus(env){return state(await database(env));}
export async function requireNamedScriptFixture(env){
  const status=await namedScriptStatus(env);
  if(!status.ready)throw new WorkspaceError(409,'Prepare the named-script TEST copy first.');
  return status;
}
export async function prepareNamedScriptFixture(request,env,actor){
  const body=await jsonBody(request,['confirm']);
  if(body.confirm!=='prepare-named-script-test-copy')throw new WorkspaceError(422,'Confirm preparation of the named-script TEST copy.');
  const db=await database(env),before=await state(db);
  if(before.ready)return {...before,created:false};
  const config=JSON.stringify({enablePrebid:true,currency:'EUR',consent:{cmpApi:'iab'},testNamedScript:marker});
  const writes=[
    // The NOT NULL domain constraint aborts this same transaction if an alias
    // appeared after state(). Never rely on the earlier read alone.
    db.prepare('INSERT INTO publishers(id,name,domain,gam_path) SELECT ?,?,CASE WHEN EXISTS (SELECT 1 FROM publishers WHERE lower(trim(domain)) IN ('+domainPlaceholders+')) THEN NULL ELSE ? END,?')
      .bind(NAMED_TEST_SITE,'Tanjug · named-script TEST copy',...domains,'tanjug.rs','/22852026051/Tanjug.rs-Display/'),
    db.prepare('INSERT INTO publisher_configs(id,publisher_id,config_json,created_by) VALUES(?,?,?,?)').bind(NAMED_TEST_SITE+'-config',NAMED_TEST_SITE,config,actor),
    ...CACHE_POSITIONS.map((code,index)=>db.prepare('INSERT INTO ad_units(id,publisher_id,code,type,sort_order) VALUES(?,?,?,?,?)')
      .bind(NAMED_TEST_SITE+'-'+code,NAMED_TEST_SITE,code,['Billboard','Branding_Left','Branding_Right','P1','Sticky'].includes(code)?'ATF':'BTF',index)),
    db.prepare('INSERT INTO audit_log(id,actor,action,publisher_id,details_json) VALUES(?,?,?,?,?)')
      .bind(NAMED_TEST_SITE+'-prepared',actor,'test_named_script.prepared',NAMED_TEST_SITE,JSON.stringify(marker)),
  ];
  try{await db.batch(writes);}
  catch{
    // A concurrent successful setup is an exact retry. Other collisions remain errors.
    const current=await state(db);
    if(current.ready)return {...current,created:false};
    throw new WorkspaceError(409,'The TEST copy could not be prepared atomically. Nothing was overwritten. Retry after reviewing the TEST state.');
  }
  return {...await state(db),created:true};
}
