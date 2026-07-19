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
        const entry = lineWithoutComment(row[entryIndex] ?? '');
        return {
          entry,
          sourceLabel: (sourceIndex >= 0 ? row[sourceIndex] : '')?.trim() || labelFromEntry(entry),
          required: requiredIndex >= 0 ? parseBoolean(row[requiredIndex] ?? '', true) : true,
        };
      })
      .filter((row) => row.entry);
  }

  return rows
    .map((row) => {
      const joined = row.length >= 3 && /^(direct|reseller)$/i.test(row[2] ?? '')
        ? row.slice(0, 4).join(', ')
        : row.join(', ');
      const entry = lineWithoutComment(joined);
      return { entry, sourceLabel: labelFromEntry(entry), required: true };
    })
    .filter((row) => row.entry);
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
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sourceSites = useMemo(
    () => accounts.flatMap((account) => account.sites.map((candidate) => ({
      id: candidate.id,
      label: `${account.name} · ${candidate.name} (${candidate.domain})`,
    }))).filter((candidate) => candidate.id !== site.id),
    [accounts, site.id],
  );

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
      setMessage(editingId ? 'Ads.txt requirement updated.' : 'Ads.txt requirement added.');
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
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : 'Ads.txt could not be checked.');
    } finally {
      setChecking(false);
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
      if (parsed.length > 100) throw new Error('Import at most 100 rows at once.');
      setImportRows(parsed);
      setImportFileName(file.name);
    } catch (fileError) {
      setImportRows([]);
      setImportFileName('');
      setError(fileError instanceof Error ? fileError.message : 'The import file could not be read.');
    }
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
            <div><span>Duplicates</span><strong>{check.duplicateLineCount ?? 0}</strong></div>
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
          <label><span>Source label</span><input onChange={(event) => setSourceLabel(event.target.value)} placeholder="Criteo" value={sourceLabel} /></label>
          <label><span>Full ads.txt entry</span><textarea onChange={(event) => setEntry(event.target.value)} placeholder="criteo.com, 12345, RESELLER, 9fac4a4a87c2a44f" rows={3} value={entry} /></label>
          <label className="ads-txt-checkbox"><input checked={required} onChange={(event) => setRequired(event.target.checked)} type="checkbox" /><span>Required entry</span></label>
          <button className="button primary" disabled={saving || !entry.trim()} onClick={() => void saveRequirement()} type="button">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add entry'}
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

      <article className="ads-txt-list-card">
        <div className="ads-txt-card-heading">
          <div><span className="panel-kicker">Saved requirements</span><h3>{requirements.length} entr{requirements.length === 1 ? 'y' : 'ies'}</h3></div>
          <button className="button secondary" onClick={() => void load()} type="button">Refresh</button>
        </div>

        {requirements.length ? (
          <div className="ads-txt-requirement-list">
            {requirements.map((requirement) => {
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
          <div className="ads-txt-empty"><strong>No saved requirements</strong><span>Add a line manually, import a CSV, or copy requirements from another site.</span></div>
        )}
      </article>
    </section>
  );
}
