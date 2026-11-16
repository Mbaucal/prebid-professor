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
    CREATE TABLE ad_units(id TEXT PRIMARY KEY,publisher_id TEXT,code TEXT,type TEXT,media_type TEXT,size_map_key TEXT,enabled INTEGER,sort_order INTEGER,notes TEXT,created_at TEXT,updated_at TEXT);
    INSERT INTO ad_units VALUES('billboard','tanjug','Billboard','ATF','banner','Billboard',1,0,NULL,'2026-09-24','2026-09-24'),('sticky','tanjug','Sticky','ATF','banner','Sticky',1,1,NULL,'2026-09-24','2026-09-24');
    CREATE TABLE audit_log(id TEXT PRIMARY KEY,actor TEXT,action TEXT,publisher_id TEXT,entity_type TEXT,entity_id TEXT,details_json TEXT,created_at TEXT);
  `.replace(/\n/g,' '));
}
/** A second synthetic site that is not Tanjug (example.invalid), with its own inventory. Eligible
 * for bid caching: Footer, Home_Top, In_Article. Not eligible: a video unit, a disabled unit, a
 * Draft, the TakeOver ad position and an Outstream position. builtinRuntimeSelection is optional. */
export const EXAMPLE_SITE='example';
export const EXAMPLE_ELIGIBLE=Object.freeze(['Footer','Home_Top','In_Article']);
export async function seedExampleSite(db,{builtinRuntimeSelection}={}) {
  const config={enablePrebid:true,currency:'EUR',consent:{cmpApi:'iab'},
    runtimeControls:{adPositions:{Takeover_Unit:{display:'takeover'}},outstream:{schemaVersion:1,units:{Outstream_Unit:{format:'outstream'}}}},
    ...(builtinRuntimeSelection?{builtinRuntimeSelection}:{})};
  const units=[['Home_Top','ATF','banner',1],['In_Article','BTF','banner',1],['Footer','BTF','banner',1],['Video_Slot','BTF','video',1],
    ['Off_Unit','BTF','banner',0],['Draft_Unit','DRAFT','banner',1],['Takeover_Unit','ATF','banner',1],['Outstream_Unit','BTF','banner',1]];
  await db.batch([
    db.prepare("INSERT INTO publishers VALUES(?,'Example site','example.invalid','/123/example/')").bind(EXAMPLE_SITE),
    db.prepare("INSERT INTO publisher_configs VALUES('config-example',?,?,NULL)").bind(EXAMPLE_SITE,JSON.stringify(config)),
    db.prepare("INSERT INTO bidders VALUES(?,1)").bind(EXAMPLE_SITE),
    ...units.map(([code,type,media,enabled],i)=>db.prepare("INSERT INTO ad_units VALUES(?,?,?,?,?,?,?,?,NULL,'2026-11-01','2026-11-01')").bind('example-'+code,EXAMPLE_SITE,code,type,media,'display',enabled,i)),
  ]);
}
