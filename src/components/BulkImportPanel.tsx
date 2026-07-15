import { useMemo, useState, type ChangeEvent } from 'react';
import { api } from '../api';
import type { CsvImportKind, CsvImportPreview } from '../shared/types';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

type Template = {
  label: string;
  description: string;
  fileName: string;
  csv: string;
  tips: string[];
};

const templates: Record<CsvImportKind, Template> = {
  'ad-units': {
    label: 'Ad units',
    description: 'Create or update many ATF, BTF and Draft positions from one spreadsheet.',
    fileName: 'ad-units-template.csv',
    csv: `code,type,mediaType,sizeMapKey,enabled,sortOrder,notes
Billboard,ATF,banner,Billboard,true,1,Homepage top billboard
P1,ATF,banner,P_MAP,true,2,Right rail
InFeed_1,BTF,banner,InFeed,true,10,First in-feed position`,
    tips: [
      'code is also the div ID used by the generated wrapper.',
      'type must be ATF, BTF or DRAFT.',
      'Existing codes are updated; missing codes are created.',
    ],
  },
  bidders: {
    label: 'Bidders',
    description: 'Create or update bidder base params. Empty base params are valid when overrides are used.',
    fileName: 'bidders-template.csv',
    csv: `bidder,paramsJson,enabled
connectad,"{""networkId"":44,""siteId"":3213233}",true
ogury,{},true
richaudience,{},true`,
    tips: [
      'paramsJson must be a JSON object, never an array.',
      'Use {} for override-only bidders such as Ogury or RichAudience.',
      'Bidder codes are normalized to lowercase.',
    ],
  },
  'bidder-overrides': {
    label: 'Bidder overrides',
    description: 'Bulk-create slot, device and exact ad-unit overrides, including RichAudience per position.',
    fileName: 'bidder-overrides-template.csv',
    csv: `bidder,scopeType,scopeKey,paramsJson,enabled
richaudience,adunit,Billboard,"{""pid"":""nfQSGaQIZe"",""supplyType"":""site""}",true
richaudience,adunit,P1,"{""pid"":""replace-with-p1-pid"",""supplyType"":""site""}",true
ogury,device,desktop,"{""assetKey"":""OGY-..."",""adUnitId"":""wd-...""}",true
ogury,device,mobile,"{""assetKey"":""OGY-..."",""adUnitId"":""wm-...""}",true`,
    tips: [
      'scopeType must be slot, device or adunit.',
      'For adunit overrides, scopeKey must match an existing ad unit exactly.',
      'If the base bidder does not exist, the import creates it automatically with {} params.',
    ],
  },
  'size-maps': {
    label: 'Size maps',
    description: 'Build responsive size maps from breakpoint rows prepared in Excel or Google Sheets.',
    fileName: 'size-maps-template.csv',
    csv: `name,minWidth,minHeight,sizes
Billboard,0,0,320x50|320x100|300x50|300x100
Billboard,469,0,468x60|320x100|300x100
Billboard,768,0,728x90|750x100|750x200
Billboard,1024,0,970x90|970x250|728x90
P_MAP,0,0,300x250|250x250
P_MAP,768,0,300x250|300x300|300x600|160x600`,
    tips: [
      'Use one row per breakpoint. Rows with the same name are grouped into one size map.',
      'Separate sizes with |, for example 970x250|728x90.',
      'Existing map names are replaced with the imported breakpoint definition.',
    ],
  },
};

function downloadText(fileName: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function BulkImportPanel({ publisherId, onChanged }: Props) {
  const [kind, setKind] = useState<CsvImportKind>('ad-units');
  const [csv, setCsv] = useState(templates['ad-units'].csv);
  const [preview, setPreview] = useState<CsvImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null);
  const [copied, setCopied] = useState(false);

  const template = templates[kind];
  const canApply = Boolean(preview && preview.totalRows > 0 && preview.errorCount === 0 && !busy);

  const previewLabel = useMemo(() => {
    if (!preview) return 'No preview yet';
    return `${preview.createCount} create · ${preview.updateCount} update · ${preview.errorCount} error`;
  }, [preview]);

  function chooseKind(next: CsvImportKind) {
    setKind(next);
    setCsv(templates[next].csv);
    setPreview(null);
    setError(null);
    setSuccess(null);
  }

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      setCsv(await file.text());
      setPreview(null);
      setError(null);
      setSuccess(null);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Could not read the CSV file.');
    } finally {
      event.target.value = '';
    }
  }

  async function copyTemplate() {
    try {
      await navigator.clipboard.writeText(template.csv);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setError('Clipboard access failed. Use Download template instead.');
    }
  }

  async function runPreview() {
    setBusy('preview');
    setError(null);
    setSuccess(null);
    try {
      setPreview(await api.previewCsvImport(publisherId, { kind, csv }));
    } catch (requestError) {
      setPreview(null);
      setError(requestError instanceof Error ? requestError.message : 'CSV preview failed.');
    } finally {
      setBusy(null);
    }
  }

  async function applyImport() {
    if (!canApply) return;
    setBusy('apply');
    setError(null);
    setSuccess(null);
    try {
      const result = await api.applyCsvImport(publisherId, { kind, csv });
      setSuccess(
        `Imported ${result.imported} item(s): ${result.created} created and ${result.updated} updated.`,
      );
      setPreview(null);
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'CSV import failed.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="bulk-import-page">
      <div className="config-toolbar">
        <div>
          <span className="panel-kicker">Spreadsheet workflow</span>
          <h2>CSV bulk import</h2>
          <p>Prepare repeated configuration in Excel, preview every change, then merge it into D1.</p>
        </div>
        <span className="safe-import-badge">Upsert only · no deletions</span>
      </div>

      <div className="import-kind-grid">
        {(Object.keys(templates) as CsvImportKind[]).map((item) => (
          <button
            className={item === kind ? 'import-kind-card active' : 'import-kind-card'}
            key={item}
            onClick={() => chooseKind(item)}
            type="button"
          >
            <strong>{templates[item].label}</strong>
            <span>{templates[item].description}</span>
          </button>
        ))}
      </div>

      <div className="bulk-import-layout">
        <article className="panel import-editor-panel">
          <div className="panel-heading import-heading">
            <div>
              <span className="panel-kicker">{template.label}</span>
              <h2>CSV source</h2>
            </div>
            <div className="import-actions compact">
              <button className={copied ? 'button copied' : 'button secondary'} onClick={() => void copyTemplate()} type="button">
                {copied ? '✓ Copied' : 'Copy template'}
              </button>
              <button className="button secondary" onClick={() => downloadText(template.fileName, template.csv)} type="button">
                Download template
              </button>
              <label className="button secondary file-button">
                Upload CSV
                <input accept=".csv,text/csv" onChange={(event) => void loadFile(event)} type="file" />
              </label>
            </div>
          </div>

          <ul className="import-tips">
            {template.tips.map((tip) => <li key={tip}>{tip}</li>)}
          </ul>

          <textarea
            aria-label={`${template.label} CSV`}
            className="csv-editor"
            onChange={(event) => {
              setCsv(event.target.value);
              setPreview(null);
              setSuccess(null);
            }}
            spellCheck={false}
            value={csv}
          />

          <div className="import-actions">
            <button className="button secondary" disabled={Boolean(busy)} onClick={() => setCsv(template.csv)} type="button">
              Reset template
            </button>
            <button className="button primary" disabled={Boolean(busy) || !csv.trim()} onClick={() => void runPreview()} type="button">
              {busy === 'preview' ? 'Checking…' : 'Preview import'}
            </button>
          </div>
        </article>

        <article className="panel import-preview-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Validation preview</span>
              <h2>{previewLabel}</h2>
            </div>
            {preview ? (
              <span className={preview.errorCount ? 'preview-state error' : 'preview-state ok'}>
                {preview.errorCount ? 'Fix errors' : 'Ready to import'}
              </span>
            ) : null}
          </div>

          {error ? <div className="form-error import-message">{error}</div> : null}
          {success ? <div className="import-success import-message">✓ {success}</div> : null}

          {!preview ? (
            <div className="empty-import-preview">
              <strong>Nothing will be written before preview.</strong>
              <span>The system marks every record as create, update or error.</span>
            </div>
          ) : (
            <div className="import-preview-table-wrap">
              <table className="import-preview-table">
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Key</th>
                    <th>Action</th>
                    <th>Summary / errors</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr className={row.status === 'error' ? 'has-error' : ''} key={`${row.rowNumber}-${row.key}`}>
                      <td>{row.rowNumber}</td>
                      <td><code>{row.key}</code></td>
                      <td><span className={`import-status ${row.status}`}>{row.status}</span></td>
                      <td>
                        <span>{row.summary}</span>
                        {row.errors.length ? (
                          <ul>{row.errors.map((item) => <li key={item}>{item}</li>)}</ul>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="import-apply-box">
            <p>Apply uses merge/update behavior. Records not present in this CSV remain unchanged.</p>
            <button className="button primary" disabled={!canApply} onClick={() => void applyImport()} type="button">
              {busy === 'apply' ? 'Importing…' : 'Apply import'}
            </button>
          </div>
        </article>
      </div>
    </section>
  );
}
