import { statements, tables, schemaSha256 } from '../../.generated/test-workspace-schema.mjs';
import { WorkspaceError, TEST_DATABASE, TEST_BUCKET, TEST_SITE } from './boundary.mjs';
export { schemaSha256 };
function session(db) {
  if (!db || typeof db.withSession !== 'function') throw new WorkspaceError(503, 'Test database is not connected.');
  return db.withSession('first-primary');
}
export async function inspectTestSchema(db) {
  const current = session(db);
  const result = await current.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name").all();
  if (result.success === false || !Array.isArray(result.results)) throw new WorkspaceError(503,'Test schema could not be checked.');
  const names = result.results.map((row) => row.name);
  if (!names.length) return { ready:false, empty:true };
  if (JSON.stringify(names) !== JSON.stringify(tables)) throw new WorkspaceError(409,'This database is not an empty or recognized test workspace. Nothing was initialized.');
  const marker = await current.prepare('SELECT * FROM tessera_test_environment WHERE id=1').first();
  if (marker?.schema_sha256 !== schemaSha256 || marker?.database_id !== TEST_DATABASE || marker?.bucket_name !== TEST_BUCKET) {
    throw new WorkspaceError(409,'Test database identity does not match this workspace.');
  }
  return { ready:true, empty:false };
}
export async function initializeTestSchema(db, actor) {
  const existing = await inspectTestSchema(db);
  if (existing.ready) return { ...existing, created:false };
  const current = session(db);
  const config = JSON.stringify({ enablePrebid:false, runtimeControls:{ sticky:{bottomAdUnitId:'Sticky'}, floors:{enabled:false}, output:{cleanComments:true} } });
  const writes = [
    ...statements.map((sql) => current.prepare(sql)),
    current.prepare('INSERT INTO tessera_test_environment (id,schema_sha256,database_id,bucket_name) VALUES (1,?,?,?)').bind(schemaSha256,TEST_DATABASE,TEST_BUCKET),
    current.prepare('INSERT INTO publishers (id,name,domain,gam_path) VALUES (?,?,?,?)').bind(TEST_SITE,'Tessera demo','example.invalid','/123/test/'),
    current.prepare('INSERT INTO publisher_configs (id,publisher_id,config_json,created_by) VALUES (?,?,?,?)').bind('test-config',TEST_SITE,config,actor),
    current.prepare('INSERT INTO size_maps (id,publisher_id,name,map_json) VALUES (?,?,?,?)').bind('test-display',TEST_SITE,'display',JSON.stringify([{viewport:[0,0],sizes:[[300,250]]},{viewport:[1024,0],sizes:[[728,90]]}])),
    current.prepare('INSERT INTO size_maps (id,publisher_id,name,map_json) VALUES (?,?,?,?)').bind('test-sticky',TEST_SITE,'sticky',JSON.stringify([{viewport:[0,0],sizes:[[320,100]]},{viewport:[1024,0],sizes:[[728,90]]}])),
    current.prepare('INSERT INTO ad_units (id,publisher_id,code,type,size_map_key,sort_order) VALUES (?,?,?,?,?,?)').bind('test-billboard',TEST_SITE,'Billboard','ATF','display',0),
    current.prepare('INSERT INTO ad_units (id,publisher_id,code,type,size_map_key,sort_order) VALUES (?,?,?,?,?,?)').bind('test-sticky-unit',TEST_SITE,'Sticky','ATF','sticky',1),
    current.prepare('INSERT INTO unit_rules (id,publisher_id,rule_key,rule_json) VALUES (?,?,?,?)').bind('test-default-rule',TEST_SITE,'__DEFAULT__',JSON.stringify({timeout:1500,refresh:{enabled:false}})),
    current.prepare('INSERT INTO audit_log (id,actor,action,publisher_id,details_json) VALUES (?,?,?,?,?)').bind('test-workspace-initialized',actor,'test_workspace.initialized',TEST_SITE,JSON.stringify({schemaSha256,synthetic:true})),
  ];
  // All strict CREATEs, guards and synthetic inserts commit as one D1 batch.
  // A concurrent initializer loses the CREATE race; no IF NOT EXISTS masks it.
  await current.batch(writes);
  const verified = await inspectTestSchema(db);
  if (!verified.ready) throw new WorkspaceError(503,'Test schema initialization could not be verified.');
  return { ...verified, created:true };
}
