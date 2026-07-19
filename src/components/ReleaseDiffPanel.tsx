import { useEffect, useMemo, useState } from 'react';

type ReleaseStatus = 'draft' | 'staging' | 'production' | 'archived' | 'failed';

type DiffRelease = {
  id: string;
  version: string;
  status: ReleaseStatus;
  configHash: string | null;
  createdAt: string;
  urls: {
    config: string;
  };
};

type Props = {
  releases: DiffRelease[];
  siteName: string;
};

type JsonRecord = Record<string, unknown>;
type DiffKind = 'added' | 'removed' | 'changed';

type FieldChange = {
  path: string;
  before: unknown;
  after: unknown;
};

type DiffItem = {
  id: string;
  key: string;
  label: string;
  kind: DiffKind;
  fields: FieldChange[];
  before: unknown;
  after: unknown;
};

type DiffCategory = {
  id: string;
  title: string;
  description: string;
  items: DiffItem[];
};

type DiffResult = {
  from: DiffRelease;
  to: DiffRelease;
  categories: DiffCategory[];
  counts: Record<DiffKind, number> & { total: number };
  generatedAt: string;
};

const VOLATILE_ENTITY_KEYS = new Set([
  'id',
  'publisherId',
  'publisher_id',
  'createdAt',
  'updatedAt',
  'created_at',
  'updated_at',
]);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => [key, canonical(value[key])]),
  );
}

function stableStringify(value: unknown): string {
  if (value === undefined) return '__undefined__';
  return JSON.stringify(canonical(value));
}

function equal(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right);
}

function cleanEntity(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanEntity);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !VOLATILE_ENTITY_KEYS.has(key))
      .map(([key, candidate]) => [key, cleanEntity(candidate)]),
  );
}

function fieldChanges(before: unknown, after: unknown, path = '', depth = 0): FieldChange[] {
  if (equal(before, after)) return [];

  if (
    depth >= 4
    || Array.isArray(before)
    || Array.isArray(after)
    || !isRecord(before)
    || !isRecord(after)
  ) {
    return [{ path: path || 'value', before, after }];
  }

  const keys = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort((a, b) => a.localeCompare(b));
  return keys.flatMap((key) => fieldChanges(before[key], after[key], path ? `${path}.${key}` : key, depth + 1));
}

function metadataItem(id: string, label: string, before: unknown, after: unknown): DiffItem | null {
  if (equal(before, after)) return null;
  return {
    id,
    key: label,
    label,
    kind: before === undefined || before === null
      ? 'added'
      : after === undefined || after === null
        ? 'removed'
        : 'changed',
    fields: fieldChanges(before, after),
    before,
    after,
  };
}

function collectionMap(
  value: unknown,
  keyOf: (item: JsonRecord, index: number) => string,
): Map<string, unknown> {
  const rows = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.entries(value).map(([key, candidate]) => ({ key, value: candidate }))
      : [];
  const output = new Map<string, unknown>();
  rows.forEach((candidate, index) => {
    const item = isRecord(candidate) ? candidate : { value: candidate };
    const key = keyOf(item, index).trim() || `item-${index + 1}`;
    output.set(key, cleanEntity(candidate));
  });
  return output;
}

function collectionDiff(
  id: string,
  title: string,
  description: string,
  before: unknown,
  after: unknown,
  keyOf: (item: JsonRecord, index: number) => string,
): DiffCategory {
  const left = collectionMap(before, keyOf);
  const right = collectionMap(after, keyOf);
  const keys = Array.from(new Set([...left.keys(), ...right.keys()])).sort((a, b) => a.localeCompare(b));
  const items: DiffItem[] = [];

  keys.forEach((key) => {
    const leftHas = left.has(key);
    const rightHas = right.has(key);
    const leftValue = left.get(key);
    const rightValue = right.get(key);
    if (leftHas && rightHas && equal(leftValue, rightValue)) return;
    const kind: DiffKind = !leftHas ? 'added' : !rightHas ? 'removed' : 'changed';
    items.push({
      id: `${id}:${key}`,
      key,
      label: key,
      kind,
      fields: kind === 'changed' ? fieldChanges(leftValue, rightValue) : [],
      before: leftValue,
      after: rightValue,
    });
  });

  return { id, title, description, items };
}

function nested(record: JsonRecord, ...path: string[]): unknown {
  let current: unknown = record;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function selectedRecord(value: unknown, keys: string[]): JsonRecord | null {
  if (!isRecord(value)) return null;
  const output = Object.fromEntries(keys.flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]]));
  return Object.keys(output).length ? output : null;
}

function demandMode(config: JsonRecord): string {
  const explicit = String(config.demandMode ?? '').trim();
  if (explicit) return explicit;
  const build = config.prebidBuild;
  if (config.enablePrebid === false || build === null || (isRecord(build) && build.version === 'disabled')) {
    return 'gam-adx-only';
  }
  return 'gam-prebid';
}

function buildDiff(from: DiffRelease, to: DiffRelease, before: JsonRecord, after: JsonRecord): DiffResult {
  const siteBefore = nested(before, 'site');
  const siteAfter = nested(after, 'site');
  const coreItems = [
    metadataItem('demand-mode', 'Demand mode', demandMode(before), demandMode(after)),
    metadataItem(
      'site',
      'Site settings',
      selectedRecord(siteBefore, ['domain', 'gam_path', 'gamPath', 'ads_txt_url', 'adsTxtUrl']),
      selectedRecord(siteAfter, ['domain', 'gam_path', 'gamPath', 'ads_txt_url', 'adsTxtUrl']),
    ),
    metadataItem(
      'generator-profile',
      'Generator profile',
      selectedRecord(nested(before, 'generatorProfile'), ['id', 'name', 'version', 'engine', 'templateSha256', 'sourceSha256']),
      selectedRecord(nested(after, 'generatorProfile'), ['id', 'name', 'version', 'engine', 'templateSha256', 'sourceSha256']),
    ),
    metadataItem(
      'prebid-build',
      'Prebid build',
      selectedRecord(nested(before, 'prebidBuild'), ['id', 'version', 'modules']),
      selectedRecord(nested(after, 'prebidBuild'), ['id', 'version', 'modules']),
    ),
    metadataItem('runtime-modules', 'Required runtime modules', before.requiredRuntimeModules, after.requiredRuntimeModules),
  ].filter((item): item is DiffItem => Boolean(item));

  const runtimeItems = [
    metadataItem('runtime-controls', 'Runtime controls', before.runtimeControls, after.runtimeControls),
    metadataItem('runtime-integrations', 'SChain and consent', before.runtimeIntegrations, after.runtimeIntegrations),
    metadataItem('user-id', 'User ID configuration', before.userIdConfig, after.userIdConfig),
    metadataItem('user-sync', 'User sync', before.userSync, after.userSync),
    metadataItem('compiler', 'Compiler output', before.compiler, after.compiler),
  ].filter((item): item is DiffItem => Boolean(item));

  const categories = [
    {
      id: 'core',
      title: 'Release architecture',
      description: 'Demand mode, site identity, generator profile and Prebid build.',
      items: coreItems,
    },
    collectionDiff('ad-units', 'Ad units', 'Enabled state, type, media type, size-map reference and ordering.', before.adUnits, after.adUnits, (item, index) => String(item.code ?? item.key ?? `unit-${index + 1}`)),
    collectionDiff('bidders', 'Bidders', 'Bidder enablement and base parameter changes.', before.bidders, after.bidders, (item, index) => String(item.bidder ?? item.key ?? `bidder-${index + 1}`)),
    collectionDiff(
      'bidder-overrides',
      'Bidder overrides',
      'Slot, device and ad-unit override changes.',
      before.bidderOverrides,
      after.bidderOverrides,
      (item, index) => [item.bidder, item.scopeType ?? item.scope_type, item.scopeKey ?? item.scope_key].filter(Boolean).join(' · ') || String(item.key ?? `override-${index + 1}`),
    ),
    collectionDiff('size-maps', 'Size maps', 'Responsive breakpoints, empty states, fluid and size changes.', before.sizeMaps, after.sizeMaps, (item, index) => String(item.name ?? item.key ?? `map-${index + 1}`)),
    collectionDiff('unit-rules', 'Unit rules', 'Timeout, lazy-load, refresh and conditional mapping changes.', before.unitRules, after.unitRules, (item, index) => String(item.ruleKey ?? item.rule_key ?? item.key ?? `rule-${index + 1}`)),
    {
      id: 'runtime',
      title: 'Runtime and privacy',
      description: 'Sticky, floors, SChain, consent, User ID and compiler behavior.',
      items: runtimeItems,
    },
  ].filter((category) => category.items.length);

  const flat = categories.flatMap((category) => category.items);
  return {
    from,
    to,
    categories,
    counts: {
      added: flat.filter((item) => item.kind === 'added').length,
      removed: flat.filter((item) => item.kind === 'removed').length,
      changed: flat.filter((item) => item.kind === 'changed').length,
      total: flat.length,
    },
    generatedAt: new Date().toISOString(),
  };
}

function formatTime(value: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function displayValue(value: unknown): string {
  if (value === undefined) return '—';
  if (value === null) return 'null';
  if (typeof value === 'string') return value || '""';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = JSON.stringify(canonical(value));
  return text.length > 260 ? `${text.slice(0, 257)}…` : text;
}

function releaseLabel(release: DiffRelease): string {
  return `${release.version} · ${release.status.toUpperCase()} · ${formatTime(release.createdAt)}`;
}

function downloadJson(value: unknown, fileName: string): void {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function textSummary(siteName: string, result: DiffResult): string {
  const lines = [
    `${siteName} release diff`,
    `From: ${result.from.version} (${result.from.status})`,
    `To: ${result.to.version} (${result.to.status})`,
    `Changes: ${result.counts.total} total · ${result.counts.added} added · ${result.counts.removed} removed · ${result.counts.changed} changed`,
    '',
  ];
  result.categories.forEach((category) => {
    lines.push(`${category.title}:`);
    category.items.forEach((item) => {
      lines.push(`- ${item.kind.toUpperCase()} · ${item.label}`);
      item.fields.slice(0, 12).forEach((field) => {
        lines.push(`  ${field.path}: ${displayValue(field.before)} -> ${displayValue(field.after)}`);
      });
    });
    lines.push('');
  });
  return `${lines.join('\n').trim()}\n`;
}

export default function ReleaseDiffPanel({ releases, siteName }: Props) {
  const ordered = useMemo(
    () => [...releases].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [releases],
  );
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [result, setResult] = useState<DiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | DiffKind>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (ordered.length < 2) {
      setFromId('');
      setToId('');
      setResult(null);
      return;
    }
    const newest = ordered[0];
    const production = ordered.find((release) => release.status === 'production' && release.id !== newest.id);
    const baseline = production ?? ordered[1];
    setToId((current) => ordered.some((release) => release.id === current) ? current : newest.id);
    setFromId((current) => ordered.some((release) => release.id === current) ? current : baseline.id);
  }, [ordered]);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [fromId, toId]);

  const fromRelease = ordered.find((release) => release.id === fromId) ?? null;
  const toRelease = ordered.find((release) => release.id === toId) ?? null;

  async function compare(): Promise<void> {
    if (!fromRelease || !toRelease) return;
    if (fromRelease.id === toRelease.id) {
      setError('Choose two different releases.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const readConfig = async (release: DiffRelease): Promise<JsonRecord> => {
        const response = await fetch(release.urls.config, { cache: 'no-store' });
        const text = await response.text();
        if (!response.ok) {
          throw new Error(`${release.version} config.json returned HTTP ${response.status}.`);
        }
        const parsed = JSON.parse(text) as unknown;
        if (!isRecord(parsed)) throw new Error(`${release.version} config.json is not a JSON object.`);
        return parsed;
      };
      const [before, after] = await Promise.all([readConfig(fromRelease), readConfig(toRelease)]);
      setResult(buildDiff(fromRelease, toRelease, before, after));
    } catch (compareError) {
      setError(compareError instanceof Error ? compareError.message : 'Release comparison failed.');
    } finally {
      setLoading(false);
    }
  }

  async function copySummary(): Promise<void> {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(textSummary(siteName, result));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Clipboard access was blocked by the browser.');
    }
  }

  const visibleCategories = useMemo(() => {
    if (!result) return [];
    const needle = query.trim().toLowerCase();
    return result.categories
      .map((category) => ({
        ...category,
        items: category.items.filter((item) => {
          if (filter !== 'all' && item.kind !== filter) return false;
          if (!needle) return true;
          return [
            category.title,
            item.label,
            item.key,
            ...item.fields.map((field) => `${field.path} ${displayValue(field.before)} ${displayValue(field.after)}`),
          ].some((value) => value.toLowerCase().includes(needle));
        }),
      }))
      .filter((category) => category.items.length);
  }, [filter, query, result]);

  return (
    <article className="release-diff-panel" id="release-diff">
      <div className="release-diff-heading">
        <div>
          <span className="panel-kicker">Immutable configuration comparison</span>
          <h3>Release Diff</h3>
          <p>Compare two saved config snapshots before staging, production or rollback.</p>
        </div>
        {result ? (
          <div className="release-diff-export-actions">
            <button className={copied ? 'button success' : 'button secondary'} onClick={() => void copySummary()} type="button">
              {copied ? '✓ Copied' : 'Copy summary'}
            </button>
            <button
              className="button secondary"
              onClick={() => downloadJson(result, `release-diff-${result.from.version}-to-${result.to.version}.json`)}
              type="button"
            >
              Download JSON
            </button>
          </div>
        ) : null}
      </div>

      {ordered.length < 2 ? (
        <div className="release-diff-empty">
          <strong>At least two releases are required.</strong>
          <span>Generate another immutable draft to enable comparison.</span>
        </div>
      ) : (
        <>
          <div className="release-diff-controls">
            <label>
              <span>From · baseline</span>
              <select onChange={(event) => setFromId(event.target.value)} value={fromId}>
                {ordered.map((release) => <option key={release.id} value={release.id}>{releaseLabel(release)}</option>)}
              </select>
            </label>
            <button
              aria-label="Swap releases"
              className="release-diff-swap"
              onClick={() => { setFromId(toId); setToId(fromId); }}
              type="button"
            >
              ⇄
            </button>
            <label>
              <span>To · candidate</span>
              <select onChange={(event) => setToId(event.target.value)} value={toId}>
                {ordered.map((release) => <option key={release.id} value={release.id}>{releaseLabel(release)}</option>)}
              </select>
            </label>
            <button className="button primary" disabled={loading || !fromId || !toId || fromId === toId} onClick={() => void compare()} type="button">
              {loading ? 'Comparing…' : 'Compare releases'}
            </button>
          </div>

          {error ? <div className="form-error release-diff-message">{error}</div> : null}

          {result ? (
            <>
              <div className="release-diff-summary">
                <div><span>Total changes</span><strong>{result.counts.total}</strong></div>
                <div className="added"><span>Added</span><strong>{result.counts.added}</strong></div>
                <div className="removed"><span>Removed</span><strong>{result.counts.removed}</strong></div>
                <div className="changed"><span>Changed</span><strong>{result.counts.changed}</strong></div>
                <div><span>Config hash</span><code>{result.from.configHash?.slice(0, 8) ?? '—'} → {result.to.configHash?.slice(0, 8) ?? '—'}</code></div>
              </div>

              {result.counts.total ? (
                <>
                  <div className="release-diff-filters">
                    <label>
                      <span>Search changes</span>
                      <input onChange={(event) => setQuery(event.target.value)} placeholder="Bidder, floor, refresh, size map…" value={query} />
                    </label>
                    <div role="group" aria-label="Change type filter">
                      {(['all', 'added', 'removed', 'changed'] as const).map((kind) => (
                        <button className={filter === kind ? 'active' : ''} key={kind} onClick={() => setFilter(kind)} type="button">
                          {kind === 'all' ? 'All' : kind.charAt(0).toUpperCase() + kind.slice(1)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="release-diff-categories">
                    {visibleCategories.map((category) => (
                      <details className="release-diff-category" key={category.id} open>
                        <summary>
                          <div><strong>{category.title}</strong><span>{category.description}</span></div>
                          <b>{category.items.length}</b>
                        </summary>
                        <div className="release-diff-items">
                          {category.items.map((item) => (
                            <section className={`release-diff-item ${item.kind}`} key={item.id}>
                              <header>
                                <span>{item.kind}</span>
                                <strong>{item.label}</strong>
                              </header>
                              {item.fields.length ? (
                                <div className="release-diff-fields">
                                  {item.fields.map((field) => (
                                    <div key={`${item.id}-${field.path}`}>
                                      <code>{field.path}</code>
                                      <span title={displayValue(field.before)}>{displayValue(field.before)}</span>
                                      <b>→</b>
                                      <span title={displayValue(field.after)}>{displayValue(field.after)}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="release-diff-whole-value">
                                  <pre>{item.kind === 'added' ? displayValue(item.after) : displayValue(item.before)}</pre>
                                </div>
                              )}
                              <details className="release-diff-raw">
                                <summary>Raw before / after</summary>
                                <div>
                                  <pre>{JSON.stringify(item.before ?? null, null, 2)}</pre>
                                  <pre>{JSON.stringify(item.after ?? null, null, 2)}</pre>
                                </div>
                              </details>
                            </section>
                          ))}
                        </div>
                      </details>
                    ))}
                    {!visibleCategories.length ? <div className="release-diff-empty"><strong>No changes match the selected filters.</strong></div> : null}
                  </div>
                </>
              ) : (
                <div className="release-diff-no-change">
                  <strong>✓ No configuration differences</strong>
                  <span>The two releases have equivalent operational configuration snapshots.</span>
                </div>
              )}
            </>
          ) : (
            <div className="release-diff-hint">Choose the baseline and candidate, then compare their immutable <code>config.json</code> snapshots.</div>
          )}
        </>
      )}
    </article>
  );
}
