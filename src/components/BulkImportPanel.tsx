import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { api } from '../api';
import { adUnitsTemplateCsv, sizeMapsTemplateCsv } from '../shared/inventory-csv-templates';
import type { CsvImportKind, CsvImportPreview } from '../shared/types';

type Props = {
  publisherId: string;
  kinds?: CsvImportKind[];
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
    csv: adUnitsTemplateCsv,
    tips: [
      '26 starter positions. Remove unused rows and match codes to your page DIV IDs.',
      'Import the size-map template first; its names match this template.',
      'Sticky and other display behavior is configured separately under Display & loading.',
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
connectad,"{""networkId"":123,""siteId"":456}",true
ogury,{},true
richaudience,{},true`,
    tips: [
      'Replace every example partner ID with the values supplied for your site.',
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
richaudience,adunit,Billboard_1,"{""pid"":""replace-with-billboard-pid"",""supplyType"":""site""}",true
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
    csv: sizeMapsTemplateCsv,
    tips: [
      '7 complete maps / 25 breakpoints: Sticky, Billboard, InFeed, P, InText, Branding_Map and Under_Article.',
      'Adjust widths and sizes to your layout and GAM inventory; remove maps you do not need.',
      'An empty sizes cell disables that viewport range. fluid is supported for native inventory.',
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

export default function BulkImportPanel(props: Props) {
  return <ImportEditor key={`${props.publisherId}:${props.kinds?.join(',') ?? 'all'}`} {...props} />;
}

function ImportEditor({ publisherId, onChanged, kinds = Object.keys(templates) as CsvImportKind[] }: Props) {
  const [kind, setKind] = useState<CsvImportKind>(kinds[0]);
  const [csv, setCsv] = useState(templates[kinds[0]].csv);
  const revision = useRef(0);
  useEffect(() => () => { revision.current += 1; }, []);
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

  function replaceCsv(next: string) {
    revision.current += 1;
    setCsv(next);
    setPreview(null);
    setError(null);
    setSuccess(null);
    setCopied(false);
  }

  function chooseKind(next: CsvImportKind) {
    setKind(next);
    replaceCsv(templates[next].csv);
  }

  async function loadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const pendingRevision = ++revision.current;
      setPreview(null);
      setBusy('preview');
      const content = await file.text();
      if (revision.current !== pendingRevision) return;
      replaceCsv(content);
    } catch (fileError) {
      setError(fileError instanceof Error ? fileError.message : 'Could not read the CSV file.');
    } finally {
      setBusy(null);
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
    const pendingRevision = revision.current;
    try {
      const result = await api.previewCsvImport(publisherId, { kind, csv });
      if (revision.current === pendingRevision) setPreview(result);
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
    const pendingRevision = revision.current;
    try {
      const result = await api.applyCsvImport(publisherId, { kind, csv });
      if (revision.current !== pendingRevision) return;
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
          <h2>{kinds.length === 1 ? `${template.label} CSV import` : 'CSV import'}</h2>
          <p>Download the ready-made template, adjust the rows you need, then preview and apply.</p>
        </div>
        <span className="safe-import-badge">Upsert only · no deletions</span>
      </div>

      {kinds.length > 1 ? <div className="import-kind-grid">
        {kinds.map((item) => (
          <button
            className={item === kind ? 'import-kind-card active' : 'import-kind-card'}
            key={item}
            disabled={Boolean(busy)}
            onClick={() => chooseKind(item)}
            type="button"
          >
            <strong>{templates[item].label}</strong>
            <span>{templates[item].description}</span>
          </button>
        ))}
      </div> : null}

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
                <input disabled={Boolean(busy)} accept=".csv,text/csv" onChange={(event) => void loadFile(event)} type="file" />
              </label>
            </div>
          </div>

          <ul className="import-tips">
            {template.tips.map((tip) => <li key={tip}>{tip}</li>)}
          </ul>

          <textarea
            aria-label={`${template.label} CSV`}
            className="csv-editor"
            disabled={Boolean(busy)}
            onChange={(event) => replaceCsv(event.target.value)}
            spellCheck={false}
            value={csv}
          />

          <div className="import-actions">
            <button className="button secondary" disabled={Boolean(busy)} onClick={() => replaceCsv(template.csv)} type="button">
              Use default template
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
