// Additive organizational metadata. No site/config/release tables are migrated.
export const organizationDdl = [
  `CREATE TABLE organization_agencies (id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(name) BETWEEN 1 AND 120), logo TEXT, revision INTEGER NOT NULL CHECK(revision > 0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, mutation_id TEXT NOT NULL)`,
  `CREATE TABLE organization_links (publisher_id TEXT PRIMARY KEY, publisher_created_at TEXT NOT NULL, agency_id TEXT REFERENCES organization_agencies(id), revision INTEGER NOT NULL CHECK(revision > 0), updated_at TEXT NOT NULL, mutation_id TEXT NOT NULL)`,
  `CREATE TABLE organization_events (id TEXT PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
];
export function normalizeDdl(sql) {
  return (String(sql).match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|\s+|[^\s'"]+/g) || [])
    .map(token => /^\s+$/.test(token) ? ' ' : token).join('').trim().replace(/;$/, '');
}
export const organizationObjects = organizationDdl.map(sql => ({name:sql.match(/^CREATE TABLE (\w+)/)[1],type:'table',sql:normalizeDdl(sql)})).sort((a,b)=>a.name.localeCompare(b.name));
export function validOrganizationObjects(rows) {
  return JSON.stringify(rows.map(row=>({name:row.name,type:row.type,sql:normalizeDdl(row.sql)})).sort((a,b)=>a.name.localeCompare(b.name))) === JSON.stringify(organizationObjects);
}
