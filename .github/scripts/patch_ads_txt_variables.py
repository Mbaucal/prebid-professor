from pathlib import Path


def replace_function(source: str, start_marker: str, end_marker: str, replacement: str) -> str:
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[:start] + replacement + source[end:]


variable_backfill_sql = r'''UPDATE ads_txt_requirement_sources
SET
  source_label = CASE
    WHEN TRIM(source_label) = '' OR INSTR(source_label, '=') > 0
      THEN UPPER(TRIM(SUBSTR(monitor_entry, 1, INSTR(monitor_entry, '=') - 1)))
    ELSE source_label
  END,
  canonical_entry = 'variable:'
    || LOWER(TRIM(SUBSTR(monitor_entry, 1, INSTR(monitor_entry, '=') - 1)))
    || '='
    || TRIM(SUBSTR(monitor_entry, INSTR(monitor_entry, '=') + 1))
WHERE INSTR(monitor_entry, '=') > 0
  AND (
    INSTR(monitor_entry, ',') = 0
    OR INSTR(monitor_entry, '=') < INSTR(monitor_entry, ',')
  );'''

source_path = Path('worker/ads-txt-requirement-sources.ts')
source = source_path.read_text()
source_parse = r'''function parseSource(value: unknown, requestedLabel: unknown, required: unknown): NormalizedSource {
  const raw = String(value ?? '').replace(/^\uFEFF/, '').trim();
  if (!raw) throw new Error('A complete ads.txt entry is required.');
  if (raw.length > MAX_ENTRY_LENGTH) {
    throw new Error(`An ads.txt entry must be ${MAX_ENTRY_LENGTH} characters or fewer.`);
  }

  const commentIndex = raw.indexOf('#');
  const recordText = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
  const inlineComment = (commentIndex >= 0 ? raw.slice(commentIndex + 1) : '').trim();
  if (!recordText) throw new Error('A complete ads.txt entry is required.');

  const equalsIndex = recordText.indexOf('=');
  const commaIndex = recordText.indexOf(',');
  if (equalsIndex > 0 && (commaIndex < 0 || equalsIndex < commaIndex)) {
    const variableName = recordText.slice(0, equalsIndex).trim();
    const variableValue = recordText.slice(equalsIndex + 1).trim();
    if (!variableName || /\s/.test(variableName)) {
      throw new Error('The ads.txt variable name cannot contain whitespace.');
    }
    if (!variableValue) throw new Error('The ads.txt variable value is required.');

    const normalizedName = variableName.toUpperCase();
    const monitorEntry = `${normalizedName}=${variableValue}`;
    const canonicalEntry = `variable:${normalizedName.toLowerCase()}=${variableValue}`;
    const sourceLabel = cleanLabel(requestedLabel) || cleanLabel(inlineComment) || normalizedName;

    if (sourceLabel.length > MAX_SOURCE_LABEL_LENGTH) {
      throw new Error(`Source label must be ${MAX_SOURCE_LABEL_LENGTH} characters or fewer.`);
    }

    return {
      sourceLabel,
      entry: inlineComment ? `${monitorEntry} #${inlineComment}` : monitorEntry,
      monitorEntry,
      canonicalEntry,
      required: booleanValue(required, true),
    };
  }

  const fields = recordText.split(',').map((field) => field.trim());
  if (fields.length < 3 || fields.length > 4) {
    throw new Error('Use an ads.txt seller record or a VARIABLE=VALUE declaration.');
  }

  const [rawDomain, rawSellerId, rawRelationship, rawCertificationId = ''] = fields;
  const domain = rawDomain.toLowerCase();
  const sellerId = rawSellerId.trim();
  const relationship = rawRelationship.toUpperCase();
  const certificationId = rawCertificationId.trim();

  if (!domain || !domain.includes('.') || /\s/.test(domain)) {
    throw new Error('The advertising-system domain is invalid.');
  }
  if (!sellerId) throw new Error('The seller ID is required.');
  if (!['DIRECT', 'RESELLER'].includes(relationship)) {
    throw new Error('The relationship must be DIRECT or RESELLER.');
  }

  const displayFields = [domain, sellerId, relationship];
  if (certificationId) displayFields.push(certificationId);
  const monitorEntry = displayFields.join(', ');
  const canonicalFields = [domain, sellerId.toLowerCase(), relationship.toLowerCase()];
  if (certificationId) canonicalFields.push(certificationId.toLowerCase());
  const canonicalEntry = canonicalFields.join(',');
  const sourceLabel = cleanLabel(requestedLabel) || cleanLabel(inlineComment) || domain;

  if (!sourceLabel) throw new Error('Source label is required.');
  if (sourceLabel.length > MAX_SOURCE_LABEL_LENGTH) {
    throw new Error(`Source label must be ${MAX_SOURCE_LABEL_LENGTH} characters or fewer.`);
  }

  return {
    sourceLabel,
    entry: inlineComment ? `${monitorEntry} #${inlineComment}` : monitorEntry,
    monitorEntry,
    canonicalEntry,
    required: booleanValue(required, true),
  };
}

'''
source = replace_function(
    source,
    'function parseSource(value: unknown, requestedLabel: unknown, required: unknown): NormalizedSource {',
    'function normalizeInput(',
    source_parse,
)
runtime_backfill_marker = """          FROM ads_txt_requirements`),
      ]);"""
runtime_backfill_replacement = """          FROM ads_txt_requirements`),
        db.prepare(`""" + variable_backfill_sql.removesuffix(';') + """`),
      ]);"""
if runtime_backfill_marker not in source:
    raise SystemExit('Runtime backfill insertion point not found')
source = source.replace(runtime_backfill_marker, runtime_backfill_replacement, 1)
source_path.write_text(source)

legacy_path = Path('worker/ads-txt.ts')
legacy = legacy_path.read_text()
legacy_parse = r'''function parseAdsEntry(value: unknown): NormalizedEntry {
  const raw = lineWithoutComment(String(value ?? ''));
  if (!raw) throw new Error('A complete ads.txt entry is required.');

  const equalsIndex = raw.indexOf('=');
  const commaIndex = raw.indexOf(',');
  if (equalsIndex > 0 && (commaIndex < 0 || equalsIndex < commaIndex)) {
    const variableName = raw.slice(0, equalsIndex).trim();
    const variableValue = raw.slice(equalsIndex + 1).trim();
    if (!variableName || /\s/.test(variableName)) {
      throw new Error('The ads.txt variable name cannot contain whitespace.');
    }
    if (!variableValue) throw new Error('The ads.txt variable value is required.');

    const normalizedName = variableName.toUpperCase();
    return {
      display: `${normalizedName}=${variableValue}`,
      canonical: `variable:${normalizedName.toLowerCase()}=${variableValue}`,
      sourceDomain: normalizedName,
    };
  }

  const fields = raw.split(',').map((field) => field.trim());
  if (fields.length < 3 || fields.length > 4) {
    throw new Error('Use an ads.txt seller record or a VARIABLE=VALUE declaration.');
  }

  const [rawDomain, rawSellerId, rawRelationship, rawCertificationId = ''] = fields;
  const domain = rawDomain.toLowerCase();
  const sellerId = rawSellerId.trim();
  const relationship = rawRelationship.toUpperCase();
  const certificationId = rawCertificationId.trim();

  if (!domain || !domain.includes('.') || /\s/.test(domain)) {
    throw new Error('The advertising-system domain is invalid.');
  }
  if (!sellerId) throw new Error('The seller ID is required.');
  if (!['DIRECT', 'RESELLER'].includes(relationship)) {
    throw new Error('The relationship must be DIRECT or RESELLER.');
  }

  const displayFields = [domain, sellerId, relationship];
  if (certificationId) displayFields.push(certificationId);
  const canonicalFields = [domain, sellerId.toLowerCase(), relationship.toLowerCase()];
  if (certificationId) canonicalFields.push(certificationId.toLowerCase());

  return {
    display: displayFields.join(', '),
    canonical: canonicalFields.join(','),
    sourceDomain: domain,
  };
}

'''
legacy = replace_function(
    legacy,
    'function parseAdsEntry(value: unknown): NormalizedEntry {',
    'function normalizeRequirement(',
    legacy_parse,
)
legacy_path.write_text(legacy)

migration_path = Path('migrations/0006_ads_txt_requirement_sources.sql')
migration = migration_path.read_text().rstrip() + '\n\n' + variable_backfill_sql + '\n'
migration_path.write_text(migration)

docs_path = Path('docs/ADS_TXT_DUPLICATE_REQUIREMENTS.md')
docs = docs_path.read_text()
needle = '- Plain-text and CSV imports preserve inline comments such as `#Smaato`, including comments containing commas; full-line `# Partner` headings become the label for following rows.\n'
replacement = needle + '- Ads.txt variable declarations such as `OWNERDOMAIN=novosti.rs`, `MANAGERDOMAIN=...`, `CONTACT=...`, `SUBDOMAIN=...` and future `VARIABLE=VALUE` records are preserved and monitored instead of being rejected as malformed seller rows.\n'
if needle not in docs:
    raise SystemExit('Documentation insertion point not found')
docs_path.write_text(docs.replace(needle, replacement, 1))
