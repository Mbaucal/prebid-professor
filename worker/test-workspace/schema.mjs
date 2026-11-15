import { LOGIN_LIMITER_TABLE_SQL, LOGIN_LIMITER_INDEX_SQL } from '../auth.ts';
import {validOrganizationObjects} from '../organization/schema.mjs';
import { statements, schemaSha256, legacyStatements, legacySchemaSha256, bidderAccountMigration } from '../../.generated/test-workspace-schema.mjs';
import { WorkspaceError, TEST_DATABASE, TEST_BUCKET, TEST_SITE } from './boundary.mjs';
export { schemaSha256 };
function session(db) {
  if (!db || typeof db.withSession !== 'function') throw new WorkspaceError(503, 'Test database is not connected.');
  return db.withSession('first-primary');
}
// SQLite retains CREATE SQL with insignificant whitespace changes. Preserve
// quoted strings verbatim, rather than normalizing away a changed constraint.
function normalizedDdl(sql) {
  if (typeof sql !== 'string') return null;
  return (sql.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\s+|[^\s'"`\[]+/g) || [])
    .map((token) => /^\s+$/.test(token) ? ' ' : token).join('').trim().replace(/;$/, '');
}
const objectsFor = ddl => ddl.map((sql) => {
  const match = sql.match(/^CREATE (TABLE|INDEX|TRIGGER) (\w+)/);
  if (!match) throw new Error('Unexpected prepared schema object.');
  return { name: match[2], type: match[1].toLowerCase(), sql: normalizedDdl(sql) };
}).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const expectedObjects = objectsFor(statements);
const legacyObjects = objectsFor(legacyStatements);
export async function inspectTestSchema(db) {
  const current = session(db);
  const result = await current.prepare("SELECT name,type,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY name").all();
  if (result.success === false || !Array.isArray(result.results)) throw new WorkspaceError(503,'Test schema could not be checked.');
  const authObjects = result.results.filter(row => row.name.startsWith('auth_login_'));
  const expectedAuth = [
    {name:'auth_login_limits',type:'table',sql:normalizedDdl(LOGIN_LIMITER_TABLE_SQL.replace(' IF NOT EXISTS',''))},
    {name:'auth_login_limits_expiry',type:'index',sql:normalizedDdl(LOGIN_LIMITER_INDEX_SQL.replace(' IF NOT EXISTS',''))},
  ];
  if (authObjects.length && JSON.stringify(authObjects.map(row=>({name:row.name,type:row.type,sql:normalizedDdl(row.sql)}))) !== JSON.stringify(expectedAuth)) {
    throw new WorkspaceError(409,'Login limiter schema does not match the reviewed version. No repairs were applied.');
  }
  const workspaceObjects = result.results.filter(row => !row.name.startsWith('auth_login_'));
  if (!workspaceObjects.length) return { ready:false, empty:true };
  const extension = workspaceObjects.filter(row => row.name.startsWith('organization_'));
  if (extension.length && !validOrganizationObjects(extension)) throw new WorkspaceError(409,'Agency schema extension does not match the reviewed version. No repairs were applied.');
  const actual = workspaceObjects.filter(row => !row.name.startsWith('organization_')).map((row) => ({name:row.name,type:row.type,sql:normalizedDdl(row.sql)}));
  const legacy = JSON.stringify(actual) === JSON.stringify(legacyObjects);
  if (!legacy && JSON.stringify(actual) !== JSON.stringify(expectedObjects)) {
    throw new WorkspaceError(409,'The current test schema, indexes or safety guards do not match the reviewed version. Nothing was initialized.');
  }
  const marker = await current.prepare('SELECT * FROM tessera_test_environment WHERE id=1').first();
  if (marker?.schema_sha256 !== (legacy ? legacySchemaSha256 : schemaSha256) || marker?.database_id !== TEST_DATABASE || marker?.bucket_name !== TEST_BUCKET) {
    throw new WorkspaceError(409,'Test database identity does not match this workspace.');
  }
  return legacy ? {ready:false, empty:false, requiresMigration:'bidder-accounts'} : { ready:true, empty:false };
}
export async function migrateBidderAccountSchema(db, actor) {
  const existing = await inspectTestSchema(db);
  if (existing.ready) return {...existing, migrated:false};
  if (existing.requiresMigration !== 'bidder-accounts') throw new WorkspaceError(409,'Prepare the empty test database before upgrading it.');
  const current = session(db);
  const guard = crypto.randomUUID();
  // A second simultaneous upgrade fails its ALTER and rolls back. A retry after
  // a lost response sees the new exact schema and returns without another write.
  await current.batch([
    current.prepare('INSERT INTO builtin_draft_assertions (id,valid) VALUES (?,CASE WHEN EXISTS (SELECT 1 FROM tessera_test_environment WHERE id=1 AND schema_sha256=? AND database_id=? AND bucket_name=?) THEN 1 ELSE 0 END)')
      .bind(guard,legacySchemaSha256,TEST_DATABASE,TEST_BUCKET),
    current.prepare(bidderAccountMigration),
    current.prepare('UPDATE tessera_test_environment SET schema_sha256=? WHERE id=1 AND schema_sha256=? AND database_id=? AND bucket_name=?')
      .bind(schemaSha256,legacySchemaSha256,TEST_DATABASE,TEST_BUCKET),
    current.prepare('INSERT INTO audit_log (id,actor,action,publisher_id,details_json) VALUES (?,?,?,?,?)')
      .bind('test-bidder-accounts-migrated',actor,'test_workspace.bidder_accounts_migrated',TEST_SITE,JSON.stringify({from:legacySchemaSha256,to:schemaSha256})),
    current.prepare('DELETE FROM builtin_draft_assertions WHERE id=?').bind(guard),
  ]);
  const verified = await inspectTestSchema(db);
  if (!verified.ready) throw new WorkspaceError(503,'Test schema upgrade could not be verified.');
  return {...verified,migrated:true};
}
export async function initializeTestSchema(db, actor) {
  const existing = await inspectTestSchema(db);
  if (existing.ready) return { ...existing, created:false };
  if (!existing.empty) throw new WorkspaceError(409,'Upgrade the existing test data to support bidder accounts. No data was changed.');
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
  // Strict CREATEs and the synthetic seed commit as one D1 batch. No automatic
  // repairs or IF NOT EXISTS that could hide a concurrent/unknown initializer.
  await current.batch(writes);
  const verified = await inspectTestSchema(db);
  if (!verified.ready) throw new WorkspaceError(503,'Test schema initialization could not be verified.');
  return { ...verified, created:true };
}
