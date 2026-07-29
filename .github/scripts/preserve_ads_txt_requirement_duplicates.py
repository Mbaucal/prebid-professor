from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"Could not find expected block for {label}")
    return text.replace(old, new, 1)


schema = r'''let schemaReady: Promise<void> | null = null;

const TABLE_NAME = 'ads_txt_requirements';
const REPLACEMENT_TABLE = 'ads_txt_requirements_v2';
const LEGACY_TABLE = 'ads_txt_requirements_legacy_unique';

function createTableSql(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY,
    publisher_id TEXT NOT NULL,
    source_label TEXT,
    entry TEXT NOT NULL,
    required INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
  )`;
}

async function tableSql(db: D1Database, name: string): Promise<string | null> {
  const row = await db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).bind(name).first<{ sql: string | null }>();
  return row?.sql ?? null;
}

function hasLegacyUniqueConstraint(sql: string): boolean {
  return /UNIQUE\s*\(\s*publisher_id\s*,\s*entry\s*\)/i.test(sql);
}

async function finalizeActiveTable(db: D1Database): Promise<void> {
  await db.prepare(
    'CREATE INDEX IF NOT EXISTS idx_ads_txt_publisher ON ads_txt_requirements(publisher_id)',
  ).run();
  await db.prepare(`DROP TABLE IF EXISTS ${LEGACY_TABLE}`).run();
  await db.prepare(`DROP TABLE IF EXISTS ${REPLACEMENT_TABLE}`).run();
}

async function recoverMissingActiveTable(db: D1Database): Promise<void> {
  if (await tableSql(db, REPLACEMENT_TABLE)) {
    await db.prepare(`ALTER TABLE ${REPLACEMENT_TABLE} RENAME TO ${TABLE_NAME}`).run();
    await finalizeActiveTable(db);
    return;
  }
  if (await tableSql(db, LEGACY_TABLE)) {
    await db.prepare(`ALTER TABLE ${LEGACY_TABLE} RENAME TO ${TABLE_NAME}`).run();
    await finalizeActiveTable(db);
    return;
  }
  await db.prepare(createTableSql(TABLE_NAME)).run();
  await finalizeActiveTable(db);
}

async function reconcile(db: D1Database): Promise<void> {
  let currentSql = await tableSql(db, TABLE_NAME);
  if (!currentSql) {
    await recoverMissingActiveTable(db);
    currentSql = await tableSql(db, TABLE_NAME);
  }
  if (!currentSql) throw new Error('ads_txt_requirements could not be created.');

  if (!hasLegacyUniqueConstraint(currentSql)) {
    await finalizeActiveTable(db);
    return;
  }

  try {
    await db.prepare(`DROP TABLE IF EXISTS ${REPLACEMENT_TABLE}`).run();
    await db.prepare(createTableSql(REPLACEMENT_TABLE)).run();
    await db.prepare(`INSERT INTO ${REPLACEMENT_TABLE} (
      id, publisher_id, source_label, entry, required, created_at, updated_at
    ) SELECT
      id, publisher_id, source_label, entry, required, created_at, updated_at
    FROM ${TABLE_NAME}`).run();
    await db.prepare(`DROP TABLE IF EXISTS ${LEGACY_TABLE}`).run();
    await db.prepare(`ALTER TABLE ${TABLE_NAME} RENAME TO ${LEGACY_TABLE}`).run();
    await db.prepare(`ALTER TABLE ${REPLACEMENT_TABLE} RENAME TO ${TABLE_NAME}`).run();
    await finalizeActiveTable(db);
  } catch (error) {
    const reconciledSql = await tableSql(db, TABLE_NAME);
    if (reconciledSql && !hasLegacyUniqueConstraint(reconciledSql)) {
      await finalizeActiveTable(db);
      return;
    }
    if (!reconciledSql) {
      await recoverMissingActiveTable(db);
      const recoveredSql = await tableSql(db, TABLE_NAME);
      if (recoveredSql && !hasLegacyUniqueConstraint(recoveredSql)) return;
    }
    throw error;
  }
}

export async function ensureAdsTxtRequirementDuplicateSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = reconcile(db).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}
'''
write('worker/ads-txt-requirement-schema.ts', schema)

migration = r'''PRAGMA foreign_keys = OFF;

CREATE TABLE ads_txt_requirements_v2 (
  id TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  source_label TEXT,
  entry TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (publisher_id) REFERENCES publishers(id) ON DELETE CASCADE
);

INSERT INTO ads_txt_requirements_v2 (
  id, publisher_id, source_label, entry, required, created_at, updated_at
)
SELECT
  id, publisher_id, source_label, entry, required, created_at, updated_at
FROM ads_txt_requirements;

DROP TABLE ads_txt_requirements;
ALTER TABLE ads_txt_requirements_v2 RENAME TO ads_txt_requirements;
CREATE INDEX IF NOT EXISTS idx_ads_txt_publisher ON ads_txt_requirements(publisher_id);

PRAGMA foreign_keys = ON;
'''
write('migrations/0006_ads_txt_requirement_duplicates.sql', migration)

ads = read('worker/ads-txt.ts')
ads = replace_once(
    ads,
    "import { apiError, getActor, json, readJson } from './http';\n",
    "import { apiError, getActor, json, readJson } from './http';\nimport { ensureAdsTxtRequirementDuplicateSchema } from './ads-txt-requirement-schema';\n",
    'ads-txt schema import',
)
ads = replace_once(
    ads,
    "function lineWithoutComment(value: string): string {\n  const withoutBom = value.replace(/^\\uFEFF/, '');\n  const commentIndex = withoutBom.indexOf('#');\n  return (commentIndex >= 0 ? withoutBom.slice(0, commentIndex) : withoutBom).trim();\n}\n",
    "function lineWithoutComment(value: string): string {\n  const withoutBom = value.replace(/^\\uFEFF/, '');\n  const commentIndex = withoutBom.indexOf('#');\n  return (commentIndex >= 0 ? withoutBom.slice(0, commentIndex) : withoutBom).trim();\n}\n\nfunction storedEntry(value: unknown, display: string): string {\n  const raw = String(value ?? '').replace(/^\\uFEFF/, '').trim();\n  const commentIndex = raw.indexOf('#');\n  if (commentIndex < 0) return display;\n  const comment = raw.slice(commentIndex).trim();\n  return comment ? `${display} ${comment}` : display;\n}\n",
    'stored raw entry helper',
)
ads = replace_once(
    ads,
    "function normalizeRequirement(input: RequirementInput, fallback?: RequirementRow): NormalizedRequirement {\n  const parsed = parseAdsEntry(input.entry === undefined ? fallback?.entry : input.entry);\n  const sourceLabel = String(\n",
    "function normalizeRequirement(input: RequirementInput, fallback?: RequirementRow): NormalizedRequirement {\n  const rawEntry = input.entry === undefined ? fallback?.entry : input.entry;\n  const parsed = parseAdsEntry(rawEntry);\n  const sourceLabel = String(\n",
    'normalize raw entry variable',
)
ads = replace_once(
    ads,
    "    entry: parsed.display,\n    canonical: parsed.canonical,\n",
    "    entry: storedEntry(rawEntry, parsed.display),\n    canonical: parsed.canonical,\n",
    'preserve inline comment',
)
ads = re.sub(
    r"\nasync function duplicateRequirementId\([\s\S]*?\n}\n\nfunction auditStatement",
    "\nfunction auditStatement",
    ads,
    count=1,
)
ads = ads.replace(
    "  if (!env.DB) return databaseMissing();\n",
    "  if (!env.DB) return databaseMissing();\n  await ensureAdsTxtRequirementDuplicateSchema(env.DB);\n",
)
ads = ads.replace(
    "    if (await duplicateRequirementId(env.DB, siteId, normalized.canonical)) {\n      return apiError('This ads.txt entry is already saved for the site.', 409);\n    }\n\n",
    "",
)
ads = ads.replace(
    "    if (await duplicateRequirementId(env.DB, siteId, normalized.canonical, requirementId)) {\n      return apiError('This ads.txt entry is already saved for the site.', 409);\n    }\n\n",
    "",
)
ads = ads.replace("  const seen = new Set<string>();\n\n", "", 1)
ads = ads.replace(
    "      if (seen.has(requirement.canonical)) return;\n      seen.add(requirement.canonical);\n      requirements.push(requirement);",
    "      requirements.push(requirement);",
    1,
)
ads = replace_once(
    ads,
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);\n    const existing = new Set<string>();\n    for (const row of existingRows) {\n      try {\n        existing.add(parseAdsEntry(row.entry).canonical);\n      } catch {\n        // Ignore malformed legacy rows during duplicate detection.\n      }\n    }\n\n    const imported = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));\n    const skipped = normalized.requirements.length - imported.length;",
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const imported = normalized.requirements;\n    const skipped = 0;\n    const duplicatesKept = canonicalDuplicateCount(imported);",
    'legacy import duplicate filtering',
)
ads = replace_once(
    ads,
    "        { imported: imported.length, skipped, replaceExisting },",
    "        { imported: imported.length, skipped, duplicatesKept, replaceExisting },",
    'legacy import audit',
)
ads = replace_once(
    ads,
    "      skipped,\n      replaced: replaceExisting,",
    "      skipped,\n      duplicatesKept,\n      replaced: replaceExisting,",
    'legacy import response',
)
ads = replace_once(
    ads,
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);\n    const existing = new Set<string>();\n    for (const row of existingRows) {\n      try {\n        existing.add(parseAdsEntry(row.entry).canonical);\n      } catch {\n        // Ignore malformed legacy rows during duplicate detection.\n      }\n    }\n\n    const copied = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));\n    const skipped = normalized.requirements.length - copied.length;",
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const copied = normalized.requirements;\n    const skipped = 0;\n    const duplicatesKept = canonicalDuplicateCount(copied);",
    'legacy copy duplicate filtering',
)
ads = replace_once(
    ads,
    "        { sourceSiteId, copied: copied.length, skipped, replaceExisting },",
    "        { sourceSiteId, copied: copied.length, skipped, duplicatesKept, replaceExisting },",
    'legacy copy audit',
)
ads = replace_once(
    ads,
    "      copied: copied.length,\n      skipped,\n      replaced: replaceExisting,",
    "      copied: copied.length,\n      skipped,\n      duplicatesKept,\n      replaced: replaceExisting,",
    'legacy copy response',
)
helper_anchor = "function toRequirement(row: RequirementRow) {\n"
helper = "function canonicalDuplicateCount(requirements: NormalizedRequirement[]): number {\n  const counts = new Map<string, number>();\n  for (const requirement of requirements) {\n    counts.set(requirement.canonical, (counts.get(requirement.canonical) ?? 0) + 1);\n  }\n  return Array.from(counts.values()).reduce((total, count) => total + Math.max(0, count - 1), 0);\n}\n\nfunction uniqueRequirementResults<T extends { entry: string }>(items: T[]): T[] {\n  const seen = new Set<string>();\n  return items.filter((item) => {\n    let key = item.entry.trim().toLowerCase();\n    try {\n      key = parseAdsEntry(item.entry).canonical;\n    } catch {\n      // Keep malformed legacy values distinct by their stored text.\n    }\n    if (seen.has(key)) return false;\n    seen.add(key);\n    return true;\n  });\n}\n\n"
ads = replace_once(ads, helper_anchor, helper + helper_anchor, 'duplicate helpers')
ads = replace_once(
    ads,
    "    const missing = results.filter((item) => item.required && !item.found);\n    const optionalMissing = results.filter((item) => !item.required && !item.found);",
    "    const missing = uniqueRequirementResults(results.filter((item) => item.required && !item.found));\n    const optionalMissing = uniqueRequirementResults(results.filter((item) => !item.required && !item.found));",
    'deduplicate checker notifications',
)
write('worker/ads-txt.ts', ads)

bulk = read('worker/ads-txt-bulk.ts')
bulk = replace_once(
    bulk,
    "import { apiError, getActor, json, readJson } from './http';\n",
    "import { apiError, getActor, json, readJson } from './http';\nimport { ensureAdsTxtRequirementDuplicateSchema } from './ads-txt-requirement-schema';\n",
    'bulk schema import',
)
bulk = replace_once(
    bulk,
    "function lineWithoutComment(value: string): string {\n  const withoutBom = value.replace(/^\\uFEFF/, '');\n  const commentIndex = withoutBom.indexOf('#');\n  return (commentIndex >= 0 ? withoutBom.slice(0, commentIndex) : withoutBom).trim();\n}\n",
    "function lineWithoutComment(value: string): string {\n  const withoutBom = value.replace(/^\\uFEFF/, '');\n  const commentIndex = withoutBom.indexOf('#');\n  return (commentIndex >= 0 ? withoutBom.slice(0, commentIndex) : withoutBom).trim();\n}\n\nfunction storedEntry(value: unknown, display: string): string {\n  const raw = String(value ?? '').replace(/^\\uFEFF/, '').trim();\n  const commentIndex = raw.indexOf('#');\n  if (commentIndex < 0) return display;\n  const comment = raw.slice(commentIndex).trim();\n  return comment ? `${display} ${comment}` : display;\n}\n",
    'bulk stored raw entry helper',
)
bulk = replace_once(
    bulk,
    "  const raw = lineWithoutComment(String(input.entry ?? ''));\n  if (!raw) throw new Error('A complete ads.txt entry is required.');",
    "  const rawInput = String(input.entry ?? '').replace(/^\\uFEFF/, '').trim();\n  const raw = lineWithoutComment(rawInput);\n  if (!raw) throw new Error('A complete ads.txt entry is required.');",
    'bulk raw input',
)
bulk = replace_once(
    bulk,
    "    entry: displayFields.join(', '),\n    canonical: canonicalFields.join(','),",
    "    entry: storedEntry(rawInput, displayFields.join(', ')),\n    canonical: canonicalFields.join(','),",
    'bulk preserve inline comment',
)
bulk = bulk.replace("  const seen = new Set<string>();\n\n", "", 1)
bulk = bulk.replace(
    "      if (seen.has(requirement.canonical)) return;\n      seen.add(requirement.canonical);\n      requirements.push(requirement);",
    "      requirements.push(requirement);",
    1,
)
bulk = bulk.replace(
    "  if (!env.DB) return databaseMissing();\n",
    "  if (!env.DB) return databaseMissing();\n  await ensureAdsTxtRequirementDuplicateSchema(env.DB);\n",
)
bulk = replace_once(
    bulk,
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);\n    const existing = new Set(existingRows.map((row) => canonicalEntry(row.entry)).filter(Boolean));\n    const imported = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));\n    const skipped = normalized.requirements.length - imported.length;",
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const imported = normalized.requirements;\n    const skipped = 0;\n    const duplicatesKept = canonicalDuplicateCount(imported);",
    'bulk import duplicate filtering',
)
bulk = replace_once(
    bulk,
    "      { imported: imported.length, skipped, replaceExisting, inputRows: body.rows.length },",
    "      { imported: imported.length, skipped, duplicatesKept, replaceExisting, inputRows: body.rows.length },",
    'bulk import audit',
)
bulk = replace_once(
    bulk,
    "      skipped,\n      replaced: replaceExisting,",
    "      skipped,\n      duplicatesKept,\n      replaced: replaceExisting,",
    'bulk import response',
)
bulk = replace_once(
    bulk,
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const existingRows = replaceExisting ? [] : await requirementRows(env.DB, siteId);\n    const existing = new Set(existingRows.map((row) => canonicalEntry(row.entry)).filter(Boolean));\n    const copied = normalized.requirements.filter((requirement) => !existing.has(requirement.canonical));\n    const skipped = normalized.requirements.length - copied.length;",
    "    const replaceExisting = booleanValue(body.replaceExisting, false);\n    const copied = normalized.requirements;\n    const skipped = 0;\n    const duplicatesKept = canonicalDuplicateCount(copied);",
    'bulk copy duplicate filtering',
)
bulk = replace_once(
    bulk,
    "      { sourceSiteId, copied: copied.length, skipped, replaceExisting },",
    "      { sourceSiteId, copied: copied.length, skipped, duplicatesKept, replaceExisting },",
    'bulk copy audit',
)
bulk = replace_once(
    bulk,
    "      copied: copied.length,\n      skipped,\n      replaced: replaceExisting,",
    "      copied: copied.length,\n      skipped,\n      duplicatesKept,\n      replaced: replaceExisting,",
    'bulk copy response',
)
bulk_anchor = "function canonicalEntry(entry: string): string | null {\n"
bulk_helper = "function canonicalDuplicateCount(requirements: NormalizedRequirement[]): number {\n  const counts = new Map<string, number>();\n  for (const requirement of requirements) {\n    counts.set(requirement.canonical, (counts.get(requirement.canonical) ?? 0) + 1);\n  }\n  return Array.from(counts.values()).reduce((total, count) => total + Math.max(0, count - 1), 0);\n}\n\n"
bulk = replace_once(bulk, bulk_anchor, bulk_helper + bulk_anchor, 'bulk duplicate helper')
write('worker/ads-txt-bulk.ts', bulk)

panel = read('src/components/AdsTxtPanel.tsx')
new_import_parser = r'''function rawAdsTxtEntry(value: string): string {
  return value.replace(/^\uFEFF/, '').trim();
}

function importRowsFromText(text: string): ImportRow[] {
  const rows = csvRows(text);
  if (!rows.length) return [];

  const header = rows[0].map((value) => value.trim().toLowerCase().replace(/[ -]+/g, '_'));
  const entryIndex = header.findIndex((value) => ['entry', 'ads_txt_entry', 'ads.txt_entry'].includes(value));
  const sourceIndex = header.findIndex((value) => ['source_label', 'source', 'label', 'partner'].includes(value));
  const requiredIndex = header.findIndex((value) => ['required', 'mandatory'].includes(value));

  if (entryIndex >= 0) {
    return rows
      .slice(1)
      .map((row) => {
        const entry = rawAdsTxtEntry(row[entryIndex] ?? '');
        return {
          entry,
          sourceLabel: (sourceIndex >= 0 ? row[sourceIndex] : '')?.trim() || labelFromEntry(entry),
          required: requiredIndex >= 0 ? parseBoolean(row[requiredIndex] ?? '', true) : true,
        };
      })
      .filter((row) => lineWithoutComment(row.entry));
  }

  let activeLabel = '';
  const imported: ImportRow[] = [];
  for (const rawLine of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      activeLabel = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    imported.push({
      entry: line,
      sourceLabel: activeLabel || labelFromEntry(line),
      required: true,
    });
  }
  return imported;
}

function canonicalEntryForSearch(value: string): string | null {
  const raw = lineWithoutComment(value);
  if (!raw) return null;
  const fields = raw.split(',').map((field) => field.trim());
  if (fields.length < 3 || fields.length > 4) return null;
  const [domain, sellerId, relationship, certificationId = ''] = fields;
  if (!domain || !sellerId || !relationship) return null;
  return [domain.toLowerCase(), sellerId.toLowerCase(), relationship.toLowerCase(), certificationId.toLowerCase()]
    .filter(Boolean)
    .join(',');
}
'''
panel = re.sub(
    r"function importRowsFromText\(text: string\): ImportRow\[] \{[\s\S]*?\n}\n\nfunction manualEntryCount",
    new_import_parser + "\nfunction manualEntryCount",
    panel,
    count=1,
)
panel = replace_once(
    panel,
    "  const filteredRequirements = useMemo(() => {\n    const query = searchQuery.trim().toLowerCase();\n    if (!query) return requirements;\n    return requirements.filter((requirement) =>\n      `${requirement.sourceLabel} ${requirement.entry}`.toLowerCase().includes(query),\n    );\n  }, [requirements, searchQuery]);",
    "  const filteredRequirements = useMemo(() => {\n    const query = searchQuery.trim().toLowerCase();\n    if (!query) return requirements;\n    const queryCanonical = canonicalEntryForSearch(searchQuery);\n    return requirements.filter((requirement) => {\n      const textMatch = `${requirement.sourceLabel} ${requirement.entry}`.toLowerCase().includes(query);\n      if (textMatch) return true;\n      return Boolean(queryCanonical && canonicalEntryForSearch(requirement.entry) === queryCanonical);\n    });\n  }, [requirements, searchQuery]);",
    'canonical requirement search',
)
panel = replace_once(
    panel,
    "      const payload = await requestJson<{ imported: number; skipped: number; requirements: Requirement[] }>(",
    "      const payload = await requestJson<{ imported: number; skipped: number; duplicatesKept?: number; requirements: Requirement[] }>(",
    'import response type',
)
panel = replace_once(
    panel,
    "      setMessage(`Imported ${payload.imported} entr${payload.imported === 1 ? 'y' : 'ies'}${payload.skipped ? `; skipped ${payload.skipped} duplicate(s)` : ''}.`);",
    "      setMessage(`Imported ${payload.imported} entr${payload.imported === 1 ? 'y' : 'ies'}${payload.duplicatesKept ? `; kept ${payload.duplicatesKept} duplicate canonical row${payload.duplicatesKept === 1 ? '' : 's'} for review` : ''}.`);",
    'import success message',
)
panel = replace_once(
    panel,
    "      const payload = await requestJson<{ copied: number; skipped: number; requirements: Requirement[] }>(",
    "      const payload = await requestJson<{ copied: number; skipped: number; duplicatesKept?: number; requirements: Requirement[] }>(",
    'copy response type',
)
panel = replace_once(
    panel,
    "      setMessage(`Copied ${payload.copied} entr${payload.copied === 1 ? 'y' : 'ies'}${payload.skipped ? `; skipped ${payload.skipped} duplicate(s)` : ''}.`);",
    "      setMessage(`Copied ${payload.copied} entr${payload.copied === 1 ? 'y' : 'ies'}${payload.duplicatesKept ? `; kept ${payload.duplicatesKept} duplicate canonical row${payload.duplicatesKept === 1 ? '' : 's'} for review` : ''}.`);",
    'copy success message',
)
panel = panel.replace(
    'placeholder="Search source, domain, seller ID, comment or complete line…"',
    'placeholder="Search source, domain, seller ID, inline comment or complete line…"',
)
write('src/components/AdsTxtPanel.tsx', panel)

project = read('PROJECT.md')
project = replace_once(
    project,
    "1. **Monitoring requirements** — canonical unique ads.txt records used only to decide whether a required seller entry is present. Inline comments are ignored for canonical matching.",
    "1. **Monitoring requirement rows** — every partner-provided row is retained, including repeated canonical records, source labels and inline comments. Monitoring comparison still deduplicates canonically so repeated rows do not create repeated alerts.",
    'project requirement model',
)
project = project.replace(
    "- [x] Search can show every matching repeated live occurrence, including inline-comment variants such as `#Smato`, together with the matching canonical saved requirement.",
    "- [x] Search can show matching live occurrences and canonical-equivalent saved rows, including inline-comment variants such as `#Smaato`.\n- [ ] Import, manual add and site copy retain repeated canonical requirement rows instead of silently skipping them.\n- [ ] Each retained row remains independently editable/deletable while notifications deduplicate canonical missing entries.",
)
project = project.replace(
    "- Confirmed that `ads_txt_requirements` are canonical monitoring expectations, not editable physical source lines.",
    "- Confirmed that Monitoring requirements must preserve every partner-provided row for review, while canonical deduplication belongs only to checking and notification decisions.",
)
write('PROJECT.md', project)

app = read('worker/app-deploy.ts')
app = re.sub(
    r"const RUNTIME_BUILD = '[^']+';",
    "const RUNTIME_BUILD = '2026-07-30-ads-txt-duplicate-requirements-v34';",
    app,
    count=1,
)
write('worker/app-deploy.ts', app)

print('Ads.txt requirement duplicate preservation integrated.')
