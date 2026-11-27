import {useEffect, useMemo, useRef, useState} from 'react';
import {METRIC_LABELS, POLITIKA_CSV_BYTES, POLITIKA_REPORTS, parsePolitikaCsv, summarizePolitika} from '../measurement/politika-gam-csv';
import type {Group, PolitikaReport, ReportId} from '../measurement/politika-gam-csv';
import './politika-gam-import.css';

type Loaded = {report: PolitikaReport; filename: string; revision: number};
const familyNames: Record<string, string> = {Variant: 'A/B variant', aq_bid_origin: 'Bid origin', Inventory: 'All inventory', refresh_bucket: 'Refresh bucket', refresh_interval: 'Refresh interval', aq_first_request: 'First request', aq_consent_wait: 'CMP wait'};
const format = (value: number | null, digits = 0) => value === null ? 'Unknown' : value.toLocaleString('en-GB', {minimumFractionDigits: digits, maximumFractionDigits: digits});

function ReportReview({report, filename}: Loaded) {
  const [family, setFamily] = useState(report.families[0]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const options = useMemo(() => Object.fromEntries(report.dimensions.map(dim => [dim, [...new Set(report.rows.map(row => row.dimensions[dim]))].sort()])), [report]);
  const groups = useMemo(() => summarizePolitika(report, family, filters), [report, family, filters]);
  const rates: {key: keyof Group; label: string; suffix: string; present: boolean}[] = [
    {key: 'ecpm', label: 'eCPM', suffix: ' EUR', present: report.metrics.includes('revenue')},
    {key: 'requestRpm', label: 'Revenue / 1,000 requests', suffix: ' EUR', present: report.id === '01'},
    {key: 'responseRate', label: 'Response rate (code served / requests)', suffix: '%', present: report.metrics.includes('requests')},
    {key: 'unfilledRate', label: 'Unfilled rate', suffix: '%', present: report.metrics.includes('requests')},
    {key: 'ctr', label: 'CTR', suffix: '%', present: report.metrics.includes('clicks')},
    {key: 'viewability', label: 'Viewability', suffix: '%', present: report.metrics.includes('viewable')},
    {key: 'measurability', label: 'Measurability', suffix: '%', present: report.metrics.includes('eligible')},
  ];
  return <div className="politika-report-review">
    <h4>{report.name}</h4>
    <p className="ab-tests-help">{filename} · {format(report.rows.length)} detail rows · {report.start} – {report.end} · EUR · Europe/Belgrade</p>
    {report.id === '01' ? <p>Ad requests = Total code served count + Unfilled impressions for the same display rows. Revenue per 1,000 requests includes unfilled opportunities.</p> : null}
    {report.id === '02' ? <p>Expected scope: the five saved Prebid orders. GAM revenue uses line-item rates; reconcile it with SSP revenue. Bid origin describes the main bid sent to GAM and does not prove that a cached creative was displayed.</p> : null}
    {report.id === '03' ? <p>All reported Politika display inventory. This report has no A/B labels and cannot be allocated to variants or added to report 01.</p> : null}
    {report.id === '05' ? <p>First-request and CMP labels can also appear on later refreshes. These are ad delivery counts, not page counts or page latency percentiles. Code served alone is not the number of all requests.</p> : null}
    {report.families.length > 1 ? <p className="politika-import-note">These key families overlap. View one at a time; their totals cannot be added or joined into an A/B × key breakdown.</p> : null}
    <div className="politika-import-filters">
      {report.families.length > 1 ? <label>Key family<select aria-label="Key family" value={family} onChange={e => setFamily(e.target.value)}>{report.families.map(key => <option key={key} value={key}>{familyNames[key]}</option>)}</select></label> : null}
      {report.dimensions.map(dim => <label key={dim}>{dim}<select aria-label={dim} value={filters[dim] ?? ''} onChange={e => setFilters(current => ({...current, [dim]: e.target.value}))}>
        <option value="">All reported values</option>{options[dim].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>)}
    </div>
    {Object.values(filters).some(Boolean) ? <button type="button" onClick={() => setFilters({})}>Clear report filters</button> : null}
    {!groups.length ? <p role="status">No rows match these filters. Clear report filters to return to the full report.</p> : <div className="politika-import-table" role="region" aria-label={`${familyNames[family]} results`} tabIndex={0}>
      <table><caption>{familyNames[family]} · percentages calculated from summed counters</caption><thead><tr><th scope="col">Metric</th>{groups.map(g => <th scope="col" key={g.value}>{family === 'Variant' ? `Variant ${g.value}` : g.value}</th>)}</tr></thead><tbody>
        {report.metrics.map(metric => <tr key={metric}><th scope="row">{METRIC_LABELS[metric]}{metric === 'requests' && report.requestBasis === 'components' ? ' (code served + unfilled)' : ''}</th>{groups.map(g => <td key={g.value}>{format(g.totals[metric] === null ? null : metric === 'revenue' ? g.totals[metric]! / 1_000_000 : g.totals[metric], metric === 'revenue' ? 2 : 0)}</td>)}</tr>)}
        {rates.filter(rate => rate.present).map(rate => <tr key={rate.key}><th scope="row">{rate.label}</th>{groups.map(g => <td key={g.value}>{g[rate.key] === null ? 'Unknown' : `${format(g[rate.key] as number, 2)}${rate.suffix}`}</td>)}</tr>)}
      </tbody></table>
    </div>}
    <p className="ab-tests-help">Missing rows or values do not mean zero traffic. This legacy export has no VersionId/TestId and no count of all assigned page views, so it cannot establish a package match, page RPM or an A/B winner.</p>
    {report.warnings.length ? <details className="politika-import-details" open={report.warnings.some(w => w.includes('assumed') || w.includes('in the source') || w.includes('may be excluded'))}><summary>Data coverage and export notes ({report.warnings.length})</summary><ul>{report.warnings.map(w => <li key={w}>{w}</li>)}</ul></details> : null}
  </div>;
}

/** Mounted with a site key: files are memory-only and stale reads cannot cross sites. */
export default function PolitikaGamImportPanel() {
  const [loaded, setLoaded] = useState<Partial<Record<ReportId, Loaded>>>({});
  const [selected, setSelected] = useState<ReportId>('01');
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const generation = useRef(0), revision = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  async function importFiles(files: File[]) {
    const ticket = ++generation.current;
    setErrors([]); setMessage('');
    if (files.length > 5) { setBusy(''); setErrors(['Choose up to five CSV files, one for each report.']); return; }
    const results: Partial<Record<ReportId, Loaded>> = {}, failures: string[] = [];
    for (const file of files) {
      if (ticket !== generation.current) return;
      setBusy(`Reading ${file.name}…`);
      try {
        if (!/\.csv$/i.test(file.name)) throw new Error('Choose the CSV export, not XLSX.');
        if (file.size > POLITIKA_CSV_BYTES) throw new Error('File exceeds 20 MiB. Export a shorter date range.');
        const csv = await file.text();
        await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (ticket !== generation.current) return;
        const report = parsePolitikaCsv(csv);
        if (results[report.id]) throw new Error(`Report ${report.id} was already selected in this batch. Choose one export per report.`);
        results[report.id] = {report, filename: file.name, revision: ++revision.current};
      } catch (error) { failures.push(`${file.name}: ${error instanceof Error ? error.message : 'Could not read this file. Select it again.'}`); }
    }
    if (ticket !== generation.current) return;
    const ids = Object.keys(results) as ReportId[];
    if (ids.length) { setLoaded(current => ({...current, ...results})); setSelected(ids.sort()[0]); }
    setErrors(failures); setBusy(''); setMessage(ids.length ? `${ids.length} report(s) loaded. A new export replaces that report; files are never appended.` : 'No reports replaced. Previously loaded reports are unchanged.');
  }
  const periods = new Set(Object.values(loaded).map(x => `${x.report.start}/${x.report.end}`));
  const current = loaded[selected];
  return <section className="politika-gam-import" aria-labelledby="politika-gam-import-title">
    <div className="measurement-heading"><h3 id="politika-gam-import-title">Politika GAM reports</h3>{Object.keys(loaded).length || busy ? <button type="button" onClick={() => { generation.current++; setLoaded({}); setBusy(''); setErrors([]); setMessage('Reports cleared.'); }}>Clear imported reports</button> : null}</div>
    <p>Import the five saved Politika CSV reports for network 23339552141, Politika.rs - Display. No saved A/B package is required for this earlier pilot.</p>
    <label className="politika-import-file">Choose GAM CSV files<input type="file" accept=".csv,text/csv" multiple disabled={!!busy} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void importFiles(files); }}/></label>
    <p className="ab-tests-help">Up to 5 files, 20 MiB and 200,000 detail rows each. Files stay in this browser view and are cleared when you leave the site or reload. Nothing is uploaded or saved.</p>
    <details className="politika-import-details"><summary>GAM export settings and saved reports</summary>
      <p>Use the same completed date range, EUR and Europe/Belgrade for every report. Export a flat table as CSV. Include report properties is supported and recommended. Turn off totals, hidden/filtered data, formatting fields and API column names.</p>
      <ul>{POLITIKA_REPORTS.map(r => <li key={r.id}><a href={`https://admanager.google.com/23339552141#reports/interactive/detail/report_id=${r.reportId}`} target="_blank" rel="noreferrer">{r.title}</a></li>)}</ul>
    </details>
    {busy ? <p role="status">{busy}</p> : message ? <p role="status">{message}</p> : null}
    {errors.length ? <div role="alert" className="runtime-error"><p>Some files could not be imported. Correct the export and select it again.</p><ul>{errors.map((error, i) => <li key={i}>{error}</li>)}</ul></div> : null}
    {periods.size > 1 ? <p role="alert" className="politika-import-note">The imported reports cover different date ranges. Export matching periods before comparing them. Reports remain separate.</p> : null}
    <div className="politika-import-tabs" role="group" aria-label="Select Politika report">{POLITIKA_REPORTS.map(r => <button type="button" key={r.id} aria-pressed={selected === r.id} onClick={() => setSelected(r.id)}>{r.title}<span>{loaded[r.id] ? 'Loaded' : 'No file'}</span></button>)}</div>
    {current ? <ReportReview key={`${selected}:${current.revision}`} {...current}/> : <p>No CSV loaded for report {selected}. Choose its export above; the columns identify the report automatically.</p>}
  </section>;
}
