// Synthetic local D1 state shared by the UI and compiled Worker checks.
export async function seedScriptLibrary(db) {
  await db.exec(`CREATE TABLE publishers(id TEXT PRIMARY KEY,name TEXT,domain TEXT,gam_path TEXT);
    INSERT INTO publishers VALUES('tanjug','Tanjug','tanjug.rs','/22852026051/Tanjug.rs-Display/');
    CREATE TABLE publisher_configs(id TEXT PRIMARY KEY,publisher_id TEXT,config_json TEXT,updated_at TEXT);
    INSERT INTO publisher_configs VALUES('config-tanjug','tanjug','{"enablePrebid":true,"currency":"EUR","consent":{"cmpApi":"iab"}}',NULL);
    CREATE TABLE bidders(publisher_id TEXT,enabled INTEGER);
    INSERT INTO bidders VALUES('tanjug',1);
    CREATE TABLE bidder_overrides(publisher_id TEXT);
    CREATE TABLE prebid_builds(id TEXT PRIMARY KEY,publisher_id TEXT,version TEXT,file_key TEXT,file_url TEXT,modules_json TEXT,status TEXT,uploaded_by TEXT,uploaded_at TEXT);
    CREATE TABLE audit_log(id TEXT PRIMARY KEY,actor TEXT,action TEXT,publisher_id TEXT,entity_type TEXT,entity_id TEXT,details_json TEXT,created_at TEXT);
  `.replace(/\n/g,' '));
}
