import {useEffect, useMemo, useRef, useState} from 'react';
import {METRIC_LABELS, GAM_CSV_BYTES, GAM_REPORTS, gamCsvHeaders, parseGamCsv, summarizeGamCsv} from '../measurement/gam-csv';
import type {Group, GamCsvContext, GamCsvReport, ReportId} from '../measurement/gam-csv';
import './gam-csv-import.css';

type Loaded = {report: GamCsvReport; filename: string; revision: number};
const familyNames: Record<string, string> = {Variant: 'A/B variant', aq_bid_origin: 'Bid origin', Inventory: 'All inventory', refresh_bucket: 'Refresh bucket', refresh_interval: 'Refresh interval', aq_first_request: 'First request', aq_consent_wait: 'CMP wait'};
const format = (value: number | null, digits = 0) => value === null ? 'Unknown' : value.toLocaleString('en-GB', {minimumFractionDigits: digits, maximumFractionDigits: digits});

function ReportReview({report, filename}: Loaded) {
  const [family, setFamily] = useState(report.families[0]);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const options = useMemo(() => Object.fromEntries(report.dimensions.map(dim => [dim, [...new Set(report.rows.map(row => row.dimensions[dim]))].sort()])), [report]);
  const groups = useMemo(() => summarizeGamCsv(report, family, filters), [report, family, filters]);
  const rates: {key: keyof Group; label: string; suffix: string; present: boolean}[] = [
    {key: 'ecpm', label: 'eCPM', suffix: report.currency ? ' ' + report.currency : ' (currency unknown)', present: report.metrics.includes('revenue')},
    {key: 'requestRpm', label: 'Revenue / 1,000 requests', suffix: report.currency ? ' ' + report.currency : ' (currency unknown)', present: report.id === '01'},
    {key: 'responseRate', label: 'Response rate (code served / requests)', suffix: '%', present: report.metrics.includes('requests')},
    {key: 'unfilledRate', label: 'Unfilled rate', suffix: '%', present: report.metrics.includes('requests')},
    {key: 'ctr', label: 'CTR', suffix: '%', present: report.metrics.includes('clicks')},
    {key: 'viewability', label: 'Viewability', suffix: '%', present: report.metrics.includes('viewable')},
    {key: 'measurability', label: 'Measurability', suffix: '%', present: report.metrics.includes('eligible')},
  ];
  return <div className="gam-csv-report-review">
    <h4>{report.name}</h4>
    <p className="gam-csv-import-note">{report.families.includes('Variant') ? 'Variant-only cohort' : report.id === '03' ? 'Inventory cohort' : 'Separate key-family cohorts'} · package identity unverified. The period may contain more than one test or package; these rows do not identify a saved Version ID.</p>
    <p className="ab-tests-help">{filename} · {format(report.rows.length)} detail rows · {report.start} – {report.end} · {report.currency ?? 'Currency unknown'} · {report.timeZone ?? 'Time zone unknown'}</p>
    {report.id === '01' ? <p>Ad requests = Total code served count + Unfilled impressions for the same display rows. Revenue per 1,000 requests includes unfilled opportunities.</p> : null}
    {report.id === '02' ? <p>Delivery scope: {report.scope.prebidVerified ? 'matches the expected Prebid IDs' : 'not verified as Prebid'}. Check the declared Order/Line item filters below. GAM revenue uses line-item rates; reconcile it with SSP revenue. Bid origin describes the main bid sent to GAM and does not prove that a cached creative was displayed.</p> : null}
    {report.id === '03' ? <p>All reported display inventory within the export filters. This report has no A/B labels and cannot be allocated to variants or added to report 01.</p> : null}
    {report.id === '05' ? <p>First-request and CMP labels can also appear on later refreshes. These are ad delivery counts, not page counts or page latency percentiles. Code served alone is not the number of all requests.</p> : null}
    <details className="gam-csv-import-details"><summary>Reported network and inventory scope</summary>
      <p>Network: {report.scope.network || report.scope.networkCode || 'Not provided'}{report.scope.networkCode && report.scope.networkCode !== report.scope.network ? ` (${report.scope.networkCode})` : ''} · {report.scope.networkVerified ? 'matches expected export identifier' : 'unverified for selected site'}</p>
      <p>Ad unit filter IDs: {report.scope.adUnitIds.join(', ') || 'Not provided'} · {report.scope.inventoryVerified ? 'matches expected inventory identifier' : 'unverified for selected site'}</p>
      <p>Reported roots: {report.scope.inventoryRoots.join(' · ')}</p>
      <p>Order IDs: {report.scope.orderIds.join(', ') || 'None declared'} · Line item IDs: {report.scope.lineItemIds.join(', ') || 'None declared'}</p>
      <p>These are export declarations, not independent source authentication.</p>
    </details>
    {report.families.length > 1 ? <p className="gam-csv-import-note">These key families overlap. View one at a time; their totals cannot be added or joined into an A/B × key breakdown.</p> : null}
    <div className="gam-csv-import-filters">
      {report.families.length > 1 ? <label>Key family<select aria-label="Key family" value={family} onChange={e => setFamily(e.target.value)}>{report.families.map(key => <option key={key} value={key}>{familyNames[key]}</option>)}</select></label> : null}
      {report.dimensions.map(dim => <label key={dim}>{dim}<select aria-label={dim} value={filters[dim] ?? ''} onChange={e => setFilters(current => ({...current, [dim]: e.target.value}))}>
        <option value="">All reported values</option>{options[dim].map(value => <option key={value} value={value}>{value}</option>)}
      </select></label>)}
    </div>
    {Object.values(filters).some(Boolean) ? <button type="button" onClick={() => setFilters({})}>Clear report filters</button> : null}
    {!groups.length ? <p role="status">No rows match these filters. Clear report filters to return to the full report.</p> : <div className="gam-csv-import-table" role="region" aria-label={`${familyNames[family]} results`} tabIndex={0}>
      <table><caption>{familyNames[family]} · percentages calculated from summed counters</caption><thead><tr><th scope="col">Metric</th>{groups.map(g => <th scope="col" key={g.value}>{family === 'Variant' ? `Variant ${g.value}` : g.value}</th>)}</tr></thead><tbody>
        {report.metrics.map(metric => <tr key={metric}><th scope="row">{METRIC_LABELS[metric]}{metric === 'revenue' ? ` (${report.currency ?? 'currency unknown'})` : ''}{metric === 'requests' && report.requestBasis === 'components' ? ' (code served + unfilled)' : ''}</th>{groups.map(g => <td key={g.value}>{format(g.totals[metric] === null ? null : metric === 'revenue' ? g.totals[metric]! / 1_000_000 : g.totals[metric], metric === 'revenue' ? 2 : 0)}</td>)}</tr>)}
        {rates.filter(rate => rate.present).map(rate => <tr key={rate.key}><th scope="row">{rate.label}</th>{groups.map(g => <td key={g.value}>{g[rate.key] === null ? 'Unknown' : `${format(g[rate.key] as number, 2)}${rate.suffix}`}</td>)}</tr>)}
      </tbody></table>
    </div>}
    <p className="ab-tests-help">Missing rows or values do not mean zero traffic. These raw Key-values rows cannot establish a joint Version ID × Variant match or the number of all assigned page views. They cannot establish page RPM or an A/B winner. Use a saved A/B report for supported joint Version ID dimensions.</p>
    {report.warnings.length ? <details className="gam-csv-import-details" open={report.warnings.some(w => w.includes('assumed') || w.includes('in the source') || w.includes('may be excluded') || w.includes('unverified') || w.includes('not verified'))}><summary>Data coverage and export notes ({report.warnings.length})</summary><ul>{report.warnings.map(w => <li key={w}>{w}</li>)}</ul></details> : null}
  </div>;
}

/** Mounted with a site key: files are memory-only and stale reads cannot cross sites. */
type Props = {siteId: string; siteName?: string; siteDomain?: string; gamPath?: string};
type Checks = {expectedNetwork: string; expectedAdUnitRoot: string; expectedAdUnitId: string; prebidOrderIds: string; prebidLineItemIds: string; currency: string; timeZone: string};
const emptyChecks: Checks = {expectedNetwork: '', expectedAdUnitRoot: '', expectedAdUnitId: '', prebidOrderIds: '', prebidLineItemIds: '', currency: '', timeZone: ''};
const splitIds = (text: string) => text.split(/[\s,;]+/).filter(Boolean);
export default function GamCsvImportPanel({siteId, siteName, siteDomain, gamPath}: Props) {
  const [draft, setDraft] = useState<Checks>(emptyChecks);
  const [checks, setChecks] = useState<Checks>(emptyChecks);
  const [settingsError, setSettingsError] = useState('');
  const context: GamCsvContext = {...checks, siteName, gamPath, prebidOrderIds: splitIds(checks.prebidOrderIds), prebidLineItemIds: splitIds(checks.prebidLineItemIds)};
  const [loaded, setLoaded] = useState<Partial<Record<ReportId, Loaded>>>({});
  const [selected, setSelected] = useState<ReportId>('01');
  const [busy, setBusy] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [message, setMessage] = useState('');
  const generation = useRef(0), revision = useRef(0);
  useEffect(() => {
    generation.current++; setLoaded({}); setBusy(''); setErrors([]); setMessage(''); setDraft(emptyChecks); setChecks(emptyChecks); setSettingsError('');
    return () => { generation.current++; };
  }, [siteId, siteName, siteDomain, gamPath]);
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
        if (file.size > GAM_CSV_BYTES) throw new Error('File exceeds 20 MiB. Export a shorter date range.');
        const csv = await file.text();
        await new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
        if (ticket !== generation.current) return;
        const report = parseGamCsv(csv, context);
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
  const scopes = new Set(Object.values(loaded).map(x => JSON.stringify([x.report.scope.network, x.report.scope.networkCode, x.report.currency, x.report.timeZone, [...x.report.scope.adUnitIds].sort(), [...x.report.scope.inventoryRoots].sort()])));
  const current = loaded[selected];
  function applyChecks() {
    try {
      if (draft.currency && !/^[A-Z]{3}$/.test(draft.currency)) throw new Error('Use a three-letter currency code.');
      if (draft.timeZone) { try { new Intl.DateTimeFormat('en', {timeZone: draft.timeZone}).format(); } catch { throw new Error('Use a valid IANA time zone.'); } }
      for (const field of ['expectedAdUnitId', 'prebidOrderIds', 'prebidLineItemIds'] as const) {
        const ids = splitIds(draft[field]);
        if (field === 'expectedAdUnitId' && ids.length > 1 || ids.length > 5000 || ids.some(id => !/^[1-9]\d{0,19}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('Use distinct positive inventory, order and line item IDs.');
      }
      generation.current++; setChecks(draft); setSettingsError(''); setLoaded({}); setBusy(''); setErrors([]); setMessage('Report checks applied. Select the exports again to validate them.');
    } catch (error) { setSettingsError(error instanceof Error ? error.message : 'Check the report settings.'); }
  }
  return <section className="gam-csv-import" aria-labelledby="gam-csv-import-title">
    <div className="measurement-heading"><h3 id="gam-csv-import-title">GAM display reports</h3>{Object.keys(loaded).length || busy ? <button type="button" onClick={() => { generation.current++; setLoaded({}); setBusy(''); setErrors([]); setMessage('Reports cleared.'); }}>Clear imported reports</button> : null}</div>
    <p>Import supported GAM display CSV exports for {siteName || siteId}. No saved A/B package is required to review earlier Variant-only reports. Each key family stays separate.</p>
    {gamPath ? <p className="ab-tests-help">Selected site's GAM path: <code>{gamPath}</code>. Exported network names and inventory labels are checked only when they can be matched explicitly; MCM parent and child networks can differ.</p> : <p className="gam-csv-import-note">This site has no configured GAM path. Verify the export network and inventory before interpreting the results.</p>}
    <label className="gam-csv-import-file">Choose GAM CSV files<input type="file" accept=".csv,text/csv" multiple disabled={!!busy} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) void importFiles(files); }}/></label>
    <p className="ab-tests-help">Up to 5 files, 20 MiB and 200,000 detail rows each. Files stay in this browser view and are cleared when you leave the site or reload. Nothing is uploaded or saved.</p>
    <details className="gam-csv-import-details"><summary>GAM export settings and saved reports</summary>
      <p>Use the same completed date range, report currency and time zone for every report. These presets cover web display inventory; video pod reporting needs a separate report. Export a flat table as CSV. Include report properties is supported and recommended. Turn off totals, hidden/filtered data, formatting fields and API column names.</p>
      <p>In GAM, open Reporting → Interactive reports and create these presets for this site's display inventory. Names are your choice; the column set identifies each preset. Metric availability depends on your network.</p>
      <ul>{GAM_REPORTS.map(r => <li key={r.id}><strong>{r.title}</strong><br/>Dimensions: {r.dimensions.join(' · ')}<br/>Metrics: {gamCsvHeaders(r.id).slice(r.dimensions.length).join(' · ')}{r.id === '02' ? <><br/>Filter by your exact Prebid Order or Line item IDs.</> : <><br/>Do not add Order, Line item or Creative filters.</>}</li>)}</ul>
      <p>Use a site-specific Ad unit ID filter including child ad units. For report 01 select Variant=A and Variant=B; 02 also aq_bid_origin=fresh, cached and none; 04 select refresh_bucket=initial, r1_3 and r4_plus plus refresh_interval=initial, unscheduled and this site's numeric interval values; 05 select aq_first_request and aq_consent_wait values lt_500, 500_999, 1000_1499, 1500_1999, 2000_2999 and 3000_plus, plus na and timeout for aq_consent_wait. Report 03 includes unlabeled inventory and has no Key-values filter. Raw Key-values families overlap; do not sum their totals.</p>
      <p>For a package-specific comparison, use the actual VersionId or TestId filter and supported joint dimensions in the saved A/B report flow. These five raw-Key-values presets do not verify that identity; separate Version ID rows cannot be joined to Variant rows.</p>
      <p>Counts use whole numbers and revenue uses decimal points. Missing values remain unknown. Keep the XLSX export for its higher revenue precision. This view supports the displayed human-label column sets, not arbitrary GAM or joint-custom-dimension exports.</p>
      <details><summary>Optional expected export identifiers</summary><p>Check all five files against identifiers you know belong to this site. A publisher network name is different from a network code; enter the value shown in the export. Unknown scope stays unverified. Currency and time zone declarations fill missing properties and must match properties that are present. Applying checks clears current imported results.</p>
        <div className="gam-csv-import-filters">{([
          ['expectedNetwork','Expected export network name or code'],['expectedAdUnitRoot','Expected ad unit root name'],['expectedAdUnitId','Expected ad unit filter ID'],['prebidOrderIds','Expected Prebid order IDs'],['prebidLineItemIds','Expected Prebid line item IDs'],['currency','Currency when absent from export'],['timeZone','Time zone when absent from export'],
        ] as const).map(([key,label]) => <label key={key}>{label}<input value={draft[key]} maxLength={key.includes('Ids') ? 100000 : 500} onChange={event => setDraft(current => ({...current, [key]: event.target.value.trimStart()}))}/></label>)}</div>
        <button type="button" onClick={applyChecks}>Apply report checks</button>{settingsError ? <p role="alert">{settingsError}</p> : null}
      </details>
    </details>
    {busy ? <p role="status">{busy}</p> : message ? <p role="status">{message}</p> : null}
    {errors.length ? <div role="alert" className="runtime-error"><p>Some files could not be imported. Correct the export and select it again.</p><ul>{errors.map((error, i) => <li key={i}>{error}</li>)}</ul></div> : null}
    {periods.size > 1 ? <p role="alert" className="gam-csv-import-note">The imported reports cover different date ranges. Export matching periods before comparing them. Reports remain separate.</p> : null}
    {scopes.size > 1 ? <p role="alert" className="gam-csv-import-note">The imported reports declare different networks, inventory filters, currencies or time zones. Keep them separate and export matching scope before comparing them.</p> : null}
    <div className="gam-csv-import-tabs" role="group" aria-label="Select GAM report">{GAM_REPORTS.map(r => <button type="button" key={r.id} aria-pressed={selected === r.id} onClick={() => setSelected(r.id)}>{r.title}<span>{loaded[r.id] ? 'Loaded' : 'No file'}</span></button>)}</div>
    {current ? <ReportReview key={`${selected}:${current.revision}`} {...current}/> : <p>No CSV loaded for report {selected}. Choose its export above; the columns identify the report automatically.</p>}
  </section>;
}
