import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { PublisherAccount, Site } from '../shared/types';

type Props = {
  site: Site;
  onChanged?: () => void | Promise<void>;
};

type Requirement = {
  id: string;
  publisherId: string;
  sourceLabel: string;
  entry: string;
  required: boolean;
  createdAt: string;
  updatedAt: string;
};

type RequirementResult = Requirement & { found: boolean };

type DuplicateEntry = {
  entry: string;
  occurrences: number;
  lineNumbers: number[];
  rawOccurrences?: Array<{ lineNumber: number; line: string }>;
};

type AdsTxtCheck = {
  status: 'ok' | 'missing' | 'empty' | 'fetch-error';
  url: string;
  finalUrl: string | null;
  fetchedAt: string;
  httpStatus: number | null;
  contentType?: string;
  message?: string;
  actualEntryCount?: number;
  validLineCount?: number;
  invalidLineCount?: number;
  duplicateLineCount?: number;
  duplicateEntries?: DuplicateEntry[];
  requirementCount?: number;
  foundCount?: number;
  requiredMissingCount?: number;
  optionalMissingCount?: number;
  results: RequirementResult[];
  missing: RequirementResult[];
  optionalMissing: RequirementResult[];
};

type RequirementPayload = {
  ok: true;
  adsTxtUrl?: string;
  requirements: Requirement[];
};

type CheckPayload = { ok: true; check: AdsTxtCheck };

type ImportRow = {
  sourceLabel: string;
  entry: string;
  required: boolean;
};

type ApiFailure = {
  error?: string;
  details?: unknown;
};

const MAX_BULK_ENTRIES = 5_000;

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & ApiFailure) | null = null;
  try {
    payload = text ? JSON.parse(text) as T & ApiFailure : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
  if (!response.ok) {
    const details = payload?.details === undefined
      ? ''
      : typeof payload.details === 'string'
        ? ` ${payload.details}`
        : ` ${JSON.stringify(payload.details)}`;
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
}

function parseBoolean(value: string, fallback = true): boolean {
  const normalized = value.trim().toLowerCase();
  if (['false', '0', 'no', 'optional'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'required'].includes(normalized)) return true;
  return fallback;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field.trim());
      field = '';
    } else if (character === '\n') {
      row.push(field.trim());
      if (row.some((value) => value)) rows.push(row);
      row = [];
      field = '';
    } else if (character !== '\r') {
      field += character;
    }
  }

  row.push(field.trim());
  if (row.some((value) => value)) rows.push(row);
  return rows;
}

function lineWithoutComment(value: string): string {
  const withoutBom = value.replace(/^\uFEFF/, '');
  const commentIndex = withoutBom.indexOf('#');
  return (commentIndex >= 0 ? withoutBom.slice(0, commentIndex) : withoutBom).trim();
}

function labelFromEntry(entry: string): string {
  return lineWithoutComment(entry).split(',')[0]?.trim() || 'Ads.txt';
}

function exactSourceKey(value: string): string {
  const raw = value.replace(/^\uFEFF/, '').trim();
  const commentIndex = raw.indexOf('#');
  const record = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
  const comment = (commentIndex >= 0 ? raw.slice(commentIndex + 1) : '').trim().toLowerCase();
  const equalsIndex = record.indexOf('=');
  const commaIndex = record.indexOf(',');
  const normalizedRecord = equalsIndex > 0 && (commaIndex < 0 || equalsIndex < commaIndex)
    ? `${record.slice(0, equalsIndex).trim().toLowerCase()}=${record.slice(equalsIndex + 1).trim().toLowerCase()}`
    : record.split(',').map((field) => field.trim().toLowerCase()).join(',');
  return comment ? `${normalizedRecord}#${comment}` : normalizedRecord;
}

function sourceLabelFromLiveLine(value: string): string {
  const raw = value.replace(/^\uFEFF/, '').trim();
  const commentIndex = raw.indexOf('#');
  const inlineComment = (commentIndex >= 0 ? raw.slice(commentIndex + 1) : '').trim();
  if (inlineComment) return inlineComment;

  const record = lineWithoutComment(raw);
  const equalsIndex = record.indexOf('=');
  const commaIndex = record.indexOf(',');
  if (equalsIndex > 0 && (commaIndex < 0 || equalsIndex < commaIndex)) {
    return record.slice(0, equalsIndex).trim().toUpperCase() || 'Live ads.txt';
  }
  return record.split(',')[0]?.trim() || 'Live ads.txt';
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
        const entry = String(row[entryIndex] ?? '').replace(/^\uFEFF/, '').trim();
        return {
          entry: entry.startsWith('#') ? '' : entry,
          sourceLabel: sourceIndex >= 0 ? String(row[sourceIndex] ?? '').trim() : '',
          required: requiredIndex >= 0 ? parseBoolean(row[requiredIndex] ?? '', true) : true,
        };
      })
      .filter((row) => row.entry);
  }

  const imported: ImportRow[] = [];
  let activeLabel = '';
  for (const row of rows) {
    const joined = row.join(', ');
    const entry = joined.replace(/^\uFEFF/, '').trim();
    if (!entry) continue;
    if (entry.startsWith('#')) {
      const heading = entry.replace(/^#+\s*/, '').trim();
      if (heading) activeLabel = heading;
      continue;
    }
    imported.push({ entry, sourceLabel: activeLabel, required: true });
  }
  return imported;
}

function manualEntryCount(value: string): number {
  return value
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .length;
}

function statusForRequirement(check: AdsTxtCheck | null, requirementId: string): 'found' | 'missing' | 'unchecked' {
  if (!check || check.status === 'fetch-error') return 'unchecked';
  const result = check.results.find((item) => item.id === requirementId);
  if (!result) return 'unchecked';
  return result.found ? 'found' : 'missing';
}

function formatTime(value: string | null | undefined): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function AdsTxtPanel({ site, onChanged }: Props) {
  const [requirements, setRequirements] = useState<Requirement[]>([]);
  const [accounts, setAccounts] = useState<PublisherAccount[]>([]);
  const [adsTxtUrl, setAdsTxtUrl] = useState(site.adsTxtUrl || `https://${site.domain}/ads.txt`);
  const [sourceLabel, setSourceLabel] = useState('');
  const [entry, setEntry] = useState('');
  const [required, setRequired] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [copySourceId, setCopySourceId] = useState('');
  const [replaceOnCopy, setReplaceOnCopy] = useState(false);
  const [replaceOnImport, setReplaceOnImport] = useState(false);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importFileName, setImportFileName] = useState('');
  const [check, setCheck] = useState<AdsTxtCheck | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addingLiveKey, setAddingLiveKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceSites = useMemo(
    () => accounts.flatMap((account) => account.sites.map((candidate) => ({
      id: candidate.id,
      label: `${account.name} · ${candidate.name} (${candidate.domain})`,
    }))).filter((candidate) => candidate.id !== site.id),
    [accounts, site.id],
  );
  const manualCount = useMemo(() => manualEntryCount(entry), [entry]);
  const filteredRequirements = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return requirements;
    return requirements.filter((requirement) =>
      `${requirement.sourceLabel} ${requirement.entry}`.toLowerCase().includes(query),
    );
  }, [requirements, searchQuery]);
  const liveSearchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query || !check?.duplicateEntries?.length) return [];

    const savedExactCounts = new Map<string, number>();
    requirements.forEach((requirement) => {
      const key = exactSourceKey(requirement.entry);
      savedExactCounts.set(key, (savedExactCounts.get(key) ?? 0) + 1);
    });

    const seenLiveCounts = new Map<string, number>();
    const matches: Array<{
      canonicalEntry: string;
      occurrences: number;
      lineNumber: number;
      line: string;
      exactKey: string;
      saved: boolean;
    }> = [];

    check.duplicateEntries.forEach((duplicate) => {
      const canonicalMatches = duplicate.entry.toLowerCase().includes(query);
      (duplicate.rawOccurrences ?? []).forEach((occurrence) => {
        const exactKey = exactSourceKey(occurrence.line);
        const occurrenceNumber = (seenLiveCounts.get(exactKey) ?? 0) + 1;
        seenLiveCounts.set(exactKey, occurrenceNumber);
        if (!canonicalMatches && !occurrence.line.toLowerCase().includes(query)) return;
        matches.push({
          canonicalEntry: duplicate.entry,
          occurrences: duplicate.occurrences,
          lineNumber: occurrence.lineNumber,
          line: occurrence.line,
          exactKey,
          saved: occurrenceNumber <= (savedExactCounts.get(exactKey) ?? 0),
        });
      });
    });

    return matches.sort((left, right) => left.lineNumber - right.lineNumber);
  }, [check, requirements, searchQuery]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [requirementsPayload, publisherAccounts] = await Promise.all([
        requestJson<RequirementPayload>(`/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements`),
        api.listPublisherAccounts(),
      ]);
      setRequirements(requirementsPayload.requirements);
      setAccounts(publisherAccounts);
      if (requirementsPayload.adsTxtUrl) setAdsTxtUrl(requirementsPayload.adsTxtUrl);
      setCopySourceId((current) => current || publisherAccounts
        .flatMap((account) => account.sites)
        .find((candidate) => candidate.id !== site.id)?.id || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Ads.txt settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [site.id]);

  useEffect(() => {
    setAdsTxtUrl(site.adsTxtUrl || `https://${site.domain}/ads.txt`);
    setCheck(null);
    setSearchQuery('');
    setShowDuplicates(false);
    void load();
  }, [load, site.adsTxtUrl, site.domain]);

  function resetEditor(): void {
    setEditingId(null);
    setSourceLabel('');
    setEntry('');
    setRequired(true);
  }

  async function saveUrl(): Promise<void> {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const normalized = adsTxtUrl.trim() || `https://${site.domain}/ads.txt`;
      await api.updateSite(site.id, { adsTxtUrl: normalized });
      setAdsTxtUrl(normalized);
      setCheck(null);
      setMessage('Ads.txt URL saved.');
      await onChanged?.();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Ads.txt URL could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  async function saveRequirement(): Promise<void> {
    const entryCount = manualEntryCount(entry);
    if (!entryCount) {
      setError('Paste at least one valid ads.txt line.');
      return;
    }
    if (editingId && entryCount !== 1) {
      setError('Edit mode accepts one ads.txt line. Cancel the edit to add multiple new lines.');
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const path = editingId
        ? `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements/${encodeURIComponent(editingId)}`
        : `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements`;
      await requestJson(path, {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceLabel, entry, required }),
      });
      resetEditor();
      setCheck(null);
      setMessage(
        editingId
          ? 'Ads.txt requirement updated.'
          : entryCount === 1
            ? 'Ads.txt requirement added.'
            : `${entryCount} ads.txt requirements added.`,
      );
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Ads.txt requirement could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  function editRequirement(requirement: Requirement): void {
    setEditingId(requirement.id);
    setSourceLabel(requirement.sourceLabel);
    setEntry(requirement.entry);
    setRequired(requirement.required);
    setMessage(null);
    setError(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function deleteRequirement(requirement: Requirement): Promise<void> {
    if (!window.confirm(`Delete the ${requirement.sourceLabel} ads.txt requirement?`)) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await requestJson(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements/${encodeURIComponent(requirement.id)}`,
        { method: 'DELETE' },
      );
      if (editingId === requirement.id) resetEditor();
      setCheck(null);
      setMessage('Ads.txt requirement deleted.');
      await load();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Ads.txt requirement could not be deleted.');
    } finally {
      setSaving(false);
    }
  }

  async function checkNow(): Promise<void> {
    setChecking(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<CheckPayload>(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/check`,
        { method: 'POST' },
      );
      setCheck(payload.check);
      setShowDuplicates(false);
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : 'Ads.txt could not be checked.');
    } finally {
      setChecking(false);
    }
  }

  async function addLiveOccurrence(match: {
    lineNumber: number;
    line: string;
    exactKey: string;
  }): Promise<void> {
    const pendingKey = `${match.lineNumber}:${match.exactKey}`;
    if (saving || addingLiveKey) return;
    setSaving(true);
    setAddingLiveKey(pendingKey);
    setError(null);
    setMessage(null);
    try {
      await requestJson(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceLabel: sourceLabelFromLiveLine(match.line),
            entry: match.line,
            required: true,
          }),
        },
      );
      await load();
      setMessage(`Live line ${match.lineNumber} added to the managed list.`);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'The live ads.txt line could not be added.');
    } finally {
      setAddingLiveKey(null);
      setSaving(false);
    }
  }

  async function importRequirements(): Promise<void> {
    if (!importRows.length) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<{ imported: number; skipped: number; requirements: Requirement[] }>(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements/import`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rows: importRows, replaceExisting: replaceOnImport }),
        },
      );
      setRequirements(payload.requirements);
      setImportRows([]);
      setImportFileName('');
      setCheck(null);
      setMessage(`Imported ${payload.imported} entr${payload.imported === 1 ? 'y' : 'ies'}${payload.skipped ? `; skipped ${payload.skipped} duplicate(s)` : ''}.`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Ads.txt CSV could not be imported.');
    } finally {
      setSaving(false);
    }
  }

  async function copyRequirements(): Promise<void> {
    if (!copySourceId) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const payload = await requestJson<{ copied: number; skipped: number; requirements: Requirement[] }>(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements/copy`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sourceSiteId: copySourceId, replaceExisting: replaceOnCopy }),
        },
      );
      setRequirements(payload.requirements);
      setCheck(null);
      setMessage(`Copied ${payload.copied} entr${payload.copied === 1 ? 'y' : 'ies'}${payload.skipped ? `; skipped ${payload.skipped} duplicate(s)` : ''}.`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : 'Ads.txt requirements could not be copied.');
    } finally {
      setSaving(false);
    }
  }

  async function readImportFile(file: File): Promise<void> {
    setError(null);
    setMessage(null);
    try {
      const parsed = importRowsFromText(await file.text());
      if (!parsed.length) throw new Error('No valid ads.txt rows were found in the selected file.');
      if (parsed.length > MAX_BULK_ENTRIES) {
        throw new Error(`Import at most ${MAX_BULK_ENTRIES.toLocaleString('en-US')} rows at once.`);
      }
      setImportRows(parsed);
      setImportFileName(file.name);
    } catch (fileError) {
      setImportRows([]);
      setImportFileName('');
      setError(fileError instanceof Error ? fileError.message : 'The import file could not be read.');
    }
  }

  function findSavedRequirement(duplicateEntry: string): void {
    setSearchQuery(duplicateEntry);
    window.requestAnimationFrame(() => {
      document.getElementById('ads-txt-saved-requirements')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  if (loading) return <div className="config-loading">Loading ads.txt requirements…</div>;

  return (
    <section className="ads-txt-page">
      <div className="ads-txt-heading">
        <div>
          <span className="panel-kicker">Authorized Digital Sellers</span>
          <h2>Ads.txt checker</h2>
          <p>Save the lines this site must publish, fetch the live ads.txt file through the Worker, and receive a simple OK or Missing result.</p>
        </div>
        <button className="button primary" disabled={checking || saving} onClick={() => void checkNow()} type="button">
          {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {error ? <div className="form-error ads-txt-message">{error}</div> : null}
      {message ? <div className="ads-txt-success ads-txt-message">✓ {message}</div> : null}

      <article className="ads-txt-url-card">
        <div>
          <span className="panel-kicker">Live source</span>
          <h3>Ads.txt URL</h3>
        </div>
        <div className="ads-txt-url-row">
          <input onChange={(event) => setAdsTxtUrl(event.target.value)} placeholder={`https://${site.domain}/ads.txt`} value={adsTxtUrl} />
          <a className="button secondary" href={adsTxtUrl || undefined} rel="noreferrer" target="_blank">Open</a>
          <button className="button secondary" disabled={saving} onClick={() => void saveUrl()} type="button">Save URL</button>
        </div>
      </article>

      <article className={`ads-txt-result-card ${check?.status ?? 'unchecked'}`}>
        {!check ? (
          <div className="ads-txt-result-empty">
            <strong>Not checked yet</strong>
            <span>Click Check now after saving the expected entries.</span>
          </div>
        ) : check.status === 'fetch-error' ? (
          <>
            <div className="ads-txt-result-title"><strong>⚠️ ads.txt could not be fetched</strong><span>{check.httpStatus ? `HTTP ${check.httpStatus}` : 'Network error'}</span></div>
            <p>{check.message || 'The Worker could not read the configured ads.txt URL.'}</p>
          </>
        ) : check.status === 'empty' ? (
          <>
            <div className="ads-txt-result-title"><strong>⚪ No requirements configured</strong><span>HTTP {check.httpStatus}</span></div>
            <p>The live file contains {check.actualEntryCount ?? 0} unique valid entr{check.actualEntryCount === 1 ? 'y' : 'ies'}, but there is nothing saved to compare.</p>
          </>
        ) : check.status === 'ok' ? (
          <>
            <div className="ads-txt-result-title"><strong>✅ OK</strong><span>{check.foundCount ?? 0}/{check.requirementCount ?? 0} found</span></div>
            <p>No required ads.txt entries are missing.</p>
          </>
        ) : (
          <>
            <div className="ads-txt-result-title"><strong>❌ Missing</strong><span>{check.requiredMissingCount ?? 0} required</span></div>
            <div className="ads-txt-missing-list">
              {check.missing.map((item) => (
                <div key={item.id}>
                  <strong>❌ Missing · {item.sourceLabel}</strong>
                  <code>{item.entry}</code>
                </div>
              ))}
            </div>
          </>
        )}

        {check && check.status !== 'fetch-error' ? (
          <div className="ads-txt-check-facts">
            <div><span>Checked</span><strong>{formatTime(check.fetchedAt)}</strong></div>
            <div><span>HTTP</span><strong>{check.httpStatus ?? '—'}</strong></div>
            <div><span>Live entries</span><strong>{check.actualEntryCount ?? 0}</strong></div>
            <div><span>Invalid lines</span><strong>{check.invalidLineCount ?? 0}</strong></div>
            <button
              className={`ads-txt-check-fact-button ${showDuplicates ? 'active' : ''}`}
              disabled={!check.duplicateLineCount}
              onClick={() => setShowDuplicates((current) => !current)}
              type="button"
            >
              <span>Repeated live entries</span>
              <strong>{check.duplicateLineCount ?? 0}</strong>
              <small>{check.duplicateLineCount ? (showDuplicates ? 'Hide repeats' : 'View repeats') : 'None found'}</small>
            </button>
          </div>
        ) : null}

        {check && showDuplicates && (check.duplicateLineCount ?? 0) > 0 ? (
          <div className="ads-txt-duplicate-panel">
            <div className="ads-txt-duplicate-heading">
              <div>
                <span className="panel-kicker">Live file cleanup</span>
                <h4>Repeated live ads.txt entries</h4>
              </div>
              <strong>{check.duplicateLineCount} extra occurrence{check.duplicateLineCount === 1 ? '' : 's'}</strong>
            </div>
            <p>Each card is a different canonical ads.txt record that appears more than once in the live publisher file. Use the button to show every matching live occurrence together with the saved requirement below. Tessera remains read-only.</p>
            {check.duplicateEntries?.length ? (
              <div className="ads-txt-duplicate-list">
                {check.duplicateEntries.map((duplicate) => (
                  <div key={`${duplicate.entry}-${duplicate.lineNumbers.join('-')}`}>
                    <div>
                      <strong>{duplicate.occurrences} occurrences</strong>
                      <span>Live lines {duplicate.lineNumbers.join(', ')}</span>
                    </div>
                    <code>{duplicate.entry}</code>
                    <button className="button secondary" onClick={() => findSavedRequirement(duplicate.entry)} type="button">Show all matches in search</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ads-txt-empty"><strong>Repeat details unavailable</strong><span>Run Check now again after the latest preview deployment.</span></div>
            )}
          </div>
        ) : null}

        {check?.optionalMissing.length ? (
          <details className="ads-txt-optional-missing">
            <summary>{check.optionalMissing.length} optional entr{check.optionalMissing.length === 1 ? 'y is' : 'ies are'} missing</summary>
            {check.optionalMissing.map((item) => <code key={item.id}>{item.sourceLabel}: {item.entry}</code>)}
          </details>
        ) : null}
      </article>

      <div className="ads-txt-workspace-grid">
        <article className="ads-txt-editor-card">
          <div className="ads-txt-card-heading">
            <div><span className="panel-kicker">Expected line</span><h3>{editingId ? 'Edit requirement' : 'Add requirement'}</h3></div>
            {editingId ? <button className="button secondary" onClick={resetEditor} type="button">Cancel edit</button> : null}
          </div>
          <label>
            <span>Source label</span>
            <input
              onChange={(event) => setSourceLabel(event.target.value)}
              placeholder="Google, Criteo… (optional when # headings are pasted)"
              value={sourceLabel}
            />
          </label>
          <label>
            <span>{editingId ? 'Full ads.txt entry' : 'Full ads.txt entries'}</span>
            <textarea
              onChange={(event) => setEntry(event.target.value)}
              placeholder={'#Google\ngoogle.com, pub-123, DIRECT, f08c47fec0942fa0\ngoogle.com, pub-456, DIRECT, f08c47fec0942fa0'}
              rows={editingId ? 3 : 8}
              value={entry}
            />
            <small>
              {editingId
                ? 'Edit one ads.txt line.'
                : 'Paste one or many lines. Blank lines are ignored. A # heading can set the label for the lines below it. Maximum 5,000 entries at once.'}
            </small>
          </label>
          <label className="ads-txt-checkbox"><input checked={required} onChange={(event) => setRequired(event.target.checked)} type="checkbox" /><span>Required {editingId || manualCount <= 1 ? 'entry' : 'entries'}</span></label>
          <button className="button primary" disabled={saving || manualCount === 0} onClick={() => void saveRequirement()} type="button">
            {saving
              ? 'Saving…'
              : editingId
                ? 'Save changes'
                : manualCount > 1
                  ? `Add ${manualCount} entries`
                  : 'Add entry'}
          </button>
        </article>

        <article className="ads-txt-tools-card">
          <div className="ads-txt-card-heading"><div><span className="panel-kicker">Bulk workflow</span><h3>Import or copy</h3></div></div>
          <section className="ads-txt-tool-section">
            <h4>CSV / text import</h4>
            <p>Use a CSV with <code>source_label, entry, required</code>, or upload a plain ads.txt file.</p>
            <input accept=".csv,.txt,text/csv,text/plain" onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void readImportFile(file);
              event.currentTarget.value = '';
            }} type="file" />
            {importRows.length ? <div className="ads-txt-import-preview"><strong>{importFileName}</strong><span>{importRows.length} row(s) ready</span></div> : null}
            <label className="ads-txt-checkbox"><input checked={replaceOnImport} onChange={(event) => setReplaceOnImport(event.target.checked)} type="checkbox" /><span>Replace existing requirements</span></label>
            <button className="button secondary" disabled={saving || !importRows.length} onClick={() => void importRequirements()} type="button">Import rows</button>
          </section>

          <section className="ads-txt-tool-section">
            <h4>Copy from another site</h4>
            <select onChange={(event) => setCopySourceId(event.target.value)} value={copySourceId}>
              <option value="">Select source site</option>
              {sourceSites.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
            <label className="ads-txt-checkbox"><input checked={replaceOnCopy} onChange={(event) => setReplaceOnCopy(event.target.checked)} type="checkbox" /><span>Replace existing requirements</span></label>
            <button className="button secondary" disabled={saving || !copySourceId} onClick={() => void copyRequirements()} type="button">Copy requirements</button>
          </section>
        </article>
      </div>

      <article className="ads-txt-list-card" id="ads-txt-saved-requirements">
        <div className="ads-txt-card-heading">
          <div>
            <span className="panel-kicker">Ads.txt search</span>
            <h3>
              {searchQuery.trim()
                ? `${liveSearchMatches.length} live match${liveSearchMatches.length === 1 ? '' : 'es'} · ${filteredRequirements.length} saved`
                : `${requirements.length} entr${requirements.length === 1 ? 'y' : 'ies'}`}
            </h3>
          </div>
          <button className="button secondary" onClick={() => void load()} type="button">Refresh</button>
        </div>

        {requirements.length ? (
          <>
            <div className="ads-txt-list-toolbar">
              <input
                aria-label="Search saved and repeated live ads.txt entries"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search source, domain, seller ID, comment or complete line…"
                type="search"
                value={searchQuery}
              />
              {searchQuery ? <button className="button secondary" onClick={() => setSearchQuery('')} type="button">Clear</button> : null}
            </div>

            {searchQuery.trim() && liveSearchMatches.length ? (
              <div className="ads-txt-live-search-panel">
                <div className="ads-txt-live-search-heading">
                  <div>
                    <span className="panel-kicker">Live publisher file</span>
                    <h4>{liveSearchMatches.length} matching live line{liveSearchMatches.length === 1 ? '' : 's'}</h4>
                  </div>
                  <a className="button secondary" href={check?.finalUrl || check?.url || adsTxtUrl} rel="noreferrer" target="_blank">Open live ads.txt</a>
                </div>
                <p>The orange cards are the current live file and remain read-only. Add any unsaved occurrence to Tessera's managed list; it will then appear below with its own Edit and Delete actions. Publishing the managed file back to the website still requires a CMS connection.</p>
                <div className="ads-txt-live-search-list">
                  {liveSearchMatches.map((match) => {
                    const pendingKey = `${match.lineNumber}:${match.exactKey}`;
                    return (
                      <div key={`${match.lineNumber}-${match.line}`}>
                        <div>
                          <strong>Live line {match.lineNumber}</strong>
                          <span>{match.occurrences} occurrences for this canonical record</span>
                        </div>
                        <code>{match.line}</code>
                        <div className="ads-txt-live-search-actions">
                          <em>LIVE FILE · READ ONLY</em>
                          {match.saved ? (
                            <span className="ads-txt-live-search-managed">SAVED IN TESSERA</span>
                          ) : (
                            <button
                              className="button secondary"
                              disabled={saving || Boolean(addingLiveKey)}
                              onClick={() => void addLiveOccurrence(match)}
                              type="button"
                            >
                              {addingLiveKey === pendingKey ? 'Adding…' : 'Add to managed list'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="ads-txt-saved-search-heading">
              <strong>Saved requirements</strong>
              {searchQuery.trim() ? <span>{filteredRequirements.length} match{filteredRequirements.length === 1 ? '' : 'es'}</span> : null}
            </div>
            {filteredRequirements.length ? (
              <div className="ads-txt-requirement-list">
                {filteredRequirements.map((requirement) => {
                  const status = statusForRequirement(check, requirement.id);
                  return (
                    <div className={`ads-txt-requirement ${status}`} key={requirement.id}>
                      <div className="ads-txt-requirement-status" title={status === 'found' ? 'Found in live ads.txt' : status === 'missing' ? 'Missing from live ads.txt' : 'Not checked'}>
                        {status === 'found' ? '✓' : status === 'missing' ? '×' : '—'}
                      </div>
                      <div className="ads-txt-requirement-main">
                        <div><strong>{requirement.sourceLabel}</strong><span className={requirement.required ? 'required' : 'optional'}>{requirement.required ? 'required' : 'optional'}</span></div>
                        <code>{requirement.entry}</code>
                      </div>
                      <div className="ads-txt-requirement-actions">
                        <button className="button secondary" onClick={() => editRequirement(requirement)} type="button">Edit</button>
                        <button className="button danger subtle" disabled={saving} onClick={() => void deleteRequirement(requirement)} type="button">Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="ads-txt-empty"><strong>No matching requirements</strong><span>Try a source name, ad-system domain, seller ID, or part of the complete line.</span></div>
            )}
          </>
        ) : (
          <div className="ads-txt-empty"><strong>No saved requirements</strong><span>Add a line manually, import a CSV, or copy requirements from another site.</span></div>
        )}
      </article>
    </section>
  );
}
