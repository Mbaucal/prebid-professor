/** Original, flat GAM exports for the legacy Politika pilot. No experiment attribution or persistence. */
export const POLITIKA_CSV_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 200_000;
export type ReportId = '01' | '02' | '03' | '04' | '05';
export type Metric = 'impressions' | 'revenue' | 'clicks' | 'eligible' | 'measurable' | 'viewable' | 'responses' | 'unfilled' | 'requests';
export type Metrics = Record<Metric, number | null>; // Revenue is integer micros until presentation.
export type ReportRow = {dimensions: Record<string, string>; family: string; value: string; metrics: Metrics; invalidViewability: boolean};
export type PolitikaReport = {
  id: ReportId; name: string; rows: ReportRow[]; dimensions: string[]; metrics: Metric[];
  families: string[]; start: string; end: string; periodFromProperties: boolean;
  warnings: string[]; requestBasis: 'direct' | 'components' | 'unavailable';
};
const monetary = ['impressions', 'revenue', 'clicks', 'eligible', 'measurable', 'viewable'] as Metric[];
const timeBuckets = ['lt_500', '500_999', '1000_1499', '1500_1999', '2000_2999', '3000_plus'];
const values: Record<string, string[]> = {
  Variant: ['A', 'B'], aq_bid_origin: ['fresh', 'cached', 'none'],
  refresh_bucket: ['initial', 'r1_3', 'r4_plus'], refresh_interval: ['30', 'initial', 'unscheduled'],
  aq_first_request: timeBuckets, aq_consent_wait: [...timeBuckets, 'na', 'timeout'],
};
const base = ['Date', 'Ad unit (all levels)'];
const keyed = [...base, 'Device category', 'Key-values'];
export const POLITIKA_REPORTS: {id: ReportId; title: string; reportId: string; dimensions: string[]; metrics: Metric[]; families: string[]}[] = [
  {id: '01', title: '01 · Monetization by A/B variant', reportId: '9048452008', dimensions: keyed, metrics: [...monetary, 'responses', 'unfilled'], families: ['Variant']},
  {id: '02', title: '02 · Prebid and bid origin', reportId: '9048476072', dimensions: [...base, 'Line item ID', 'Key-values'], metrics: monetary, families: ['Variant', 'aq_bid_origin']},
  {id: '03', title: '03 · Unfilled inventory', reportId: '9048502156', dimensions: [...base, 'Device category', 'Requested ad sizes'], metrics: ['requests', 'responses', 'unfilled'], families: ['Inventory']},
  {id: '04', title: '04 · Refresh', reportId: '9048507266', dimensions: keyed, metrics: monetary, families: ['refresh_bucket', 'refresh_interval']},
  {id: '05', title: '05 · First request and CMP', reportId: '9048512695', dimensions: keyed, metrics: ['impressions', 'responses'], families: ['aq_first_request', 'aq_consent_wait']},
];
export const METRIC_LABELS: Record<Metric, string> = {
  impressions: 'Impressions', revenue: 'Revenue (EUR)', clicks: 'Clicks', eligible: 'AV eligible impressions',
  measurable: 'AV measurable impressions', viewable: 'AV viewable impressions', responses: 'Code served',
  unfilled: 'Unfilled impressions', requests: 'Ad requests',
};
const metricNames: Record<Metric, string> = {
  impressions: 'impressions', revenue: 'CPM and CPC revenue', clicks: 'clicks',
  eligible: 'Active View eligible impressions', measurable: 'Active View measurable impressions',
  viewable: 'Active View viewable impressions', responses: 'code served count',
  unfilled: 'Unfilled impressions', requests: 'ad requests',
};
export function politikaHeaders(id: ReportId): string[] {
  const spec = POLITIKA_REPORTS.find(x => x.id === id)!;
  return [...spec.dimensions, ...spec.metrics.map(m => m === 'unfilled' ? metricNames[m] : `${id === '02' ? 'Ad server' : 'Total'} ${metricNames[m]}`)];
}
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const emptyMetrics = (): Metrics => ({impressions: null, revenue: null, clicks: null, eligible: null, measurable: null, viewable: null, responses: null, unfilled: null, requests: null});

/** RFC-style quoted cells, including embedded newlines; no silent truncation or permissive quote repair. */
function csvRows(input: string): string[][] {
  requireValue(typeof input === 'string' && new TextEncoder().encode(input).length <= POLITIKA_CSV_BYTES, 'CSV exceeds the 20 MiB limit. Export a shorter date range.');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, closed = false;
  function field() { row.push(cell.trim()); cell = ''; closed = false; }
  function line() { field(); if (row.some(x => x !== '')) rows.push(row); row = []; requireValue(rows.length <= MAX_ROWS + 100, 'CSV exceeds 200,000 rows. Export a shorter date range.'); }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') { cell += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === ',') field();
    else if (c === '\n') line();
    else if (c === '"') { requireValue(!cell && !closed, 'Malformed CSV quotes. Export the original CSV again.'); quoted = true; }
    else { requireValue(!closed, 'Unexpected text after a quoted CSV cell.'); cell += c; }
  }
  requireValue(!quoted, 'Unclosed CSV quote. Export the complete file again.');
  if (cell || row.length || closed) line();
  return rows;
}
function isoDate(value: string): string {
  requireValue(/^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, `Invalid date: ${value}. Use the original flat GAM CSV.`);
  return value;
}
function period(value: string): [string, string] {
  const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}) - (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/.exec(value);
  requireValue(match, 'Unrecognized Date range property. Export with English GAM labels.');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const date = (offset: number) => isoDate(`${match[offset + 2]}-${String(months.indexOf(match[offset]) + 1).padStart(2, '0')}-${match[offset + 1].padStart(2, '0')}`);
  const start = date(1), end = date(4); requireValue(start <= end, 'Reversed report date range.'); return [start, end];
}
function numberCell(value: string, money: boolean, row: number, label: string): number | null {
  if (['', '-', 'N/A', '(not applicable)'].includes(value)) return null;
  // Human-label GAM CSV uses a dot decimal and may quote comma-grouped counts.
  const match = /^(\d+|[1-9]\d{0,2}(?:,\d{3})+)(?:\.(\d{1,6}))?$/.exec(value);
  requireValue(match && (money || !match[2]), `Row ${row}: invalid ${label}. Expected a nonnegative ${money ? 'decimal with a dot' : 'whole number'}.`);
  const whole = Number(match[1].replaceAll(',', ''));
  const result = money ? whole * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0')) : whole;
  requireValue(Number.isSafeInteger(result), `Row ${row}: ${label} is too large.`); return result;
}
function safeAdd(a: number, b: number): number { const sum = a + b; requireValue(Number.isSafeInteger(sum), 'Report totals exceed safe numeric precision. Export a shorter period.'); return sum; }
const ORDERS = ['4071347028', '4071372871', '4071372874', '4071347031', '4071372877'].sort();
function checkProperties(props: Map<string, string>, id: ReportId, warnings: string[]) {
  for (const [key, expected] of [['Report currency', 'EUR'], ['Time zone', 'Europe/Belgrade'], ['Report type', 'Historical'], ['Publisher network', 'Politika novine i magazini doo']]) {
    if (props.has(key)) requireValue(props.get(key) === expected, `${key} must be ${expected} for this Politika import.`);
  }
  if (!props.has('Report currency') || !props.has('Time zone')) warnings.push('Currency and time zone are assumed: EUR / Europe/Belgrade. Export with Include report properties to verify them.');
  const name = props.get('Report name');
  if (name) requireValue(new RegExp(`^Politika \\| ${id} `).test(name), `Report name does not match detected report ${id}. Use the saved Politika report.`);
  const filters = props.get('Filters');
  if (!filters) { warnings.push('Filter metadata is absent. Scope is assumed from the saved Politika report; re-export with Include report properties to verify the filters.'); return; }
  const parts = filters.split(' AND ');
  requireValue(parts.includes('Ad unit ID (all levels) = 23338702405'), 'Use the Politika.rs - Display ad unit filter, including child ad units.');
  const allowed = parts.every(part => part === 'Ad unit ID (all levels) = 23338702405' ||
    (id !== '03' && /^Key-values ID = \d+(?:, \d+)*$/.test(part)) || (id === '02' && /^Order ID = \d+(?:, \d+)*$/.test(part)));
  requireValue(allowed && parts.length === new Set(parts.map(x => x.split(' = ')[0])).size, 'Unexpected or repeated filters. Export the saved Politika report without extra filters.');
  if (id !== '03') {
    const keyFilter = parts.find(x => x.startsWith('Key-values ID = '));
    const count = keyFilter ? new Set(keyFilter.slice('Key-values ID = '.length).split(', ')).size : 0;
    const expected = {'01': 2, '02': 5, '04': 6, '05': 14}[id];
    if (count !== expected) warnings.push(`The export filter selects ${count} key-values; saved report ${id} expects ${expected}. Categories may be excluded. Re-export the corrected saved report.`);
  }
  if (id === '02') {
    const order = parts.find(x => x.startsWith('Order ID = '));
    requireValue(order && JSON.stringify(order.slice('Order ID = '.length).split(', ').sort()) === JSON.stringify(ORDERS), 'Prebid report must include exactly the five saved Prebid orders.');
  }
}

export function parsePolitikaCsv(csv: string): PolitikaReport {
  const all = csvRows(csv), headerAt = all.findIndex(row => row.includes('Date') && row.includes('Ad unit (all levels)'));
  requireValue(headerAt >= 0 && headerAt <= 30, 'No Date header found. Export CSV with English labels and Use API column names turned off.');
  const headers = all[headerAt], props = new Map<string, string>();
  for (const row of all.slice(0, headerAt)) {
    requireValue(row.length === 2 && !props.has(row[0]), 'Unrecognized or repeated report properties. Export the original CSV again.'); props.set(row[0], row[1]);
  }
  requireValue(new Set(headers).size === headers.length, 'Duplicate CSV headers are ambiguous.');
  if (headers.some(h => /^(Variant|aq_\w+|refresh_\w+) \(/.test(h))) throw new Error('This export uses custom dimensions, which can contain (not applicable) for earlier dates. Export the corrected Politika 01–05 reports with the Key-values dimension.');
  const spec = POLITIKA_REPORTS.find(candidate => { const expected = politikaHeaders(candidate.id); return expected.length === headers.length && expected.every(h => headers.includes(h)); });
  requireValue(spec, 'Columns do not match Politika reports 01–05. Use the saved flat report, no totals or extra columns, with Use API column names off. Report 01 needs Total code served count and Unfilled impressions.');
  const warnings: string[] = []; checkProperties(props, spec.id, warnings);
  const declaredPeriod = props.has('Date range') ? period(props.get('Date range')!) : null;
  const metricHeaders = politikaHeaders(spec.id).slice(spec.dimensions.length);
  const positions = new Map(headers.map((h, i) => [h, i]));
  const seen = new Set<string>(), days = new Set<string>(), families = new Set<string>();
  const aggregateBounds = new Map<string, Metrics>();
  const missing = new Set<Metric>(); const rows: ReportRow[] = []; let invalidViewabilityRows = 0;
  requireValue(all.length - headerAt - 1 <= MAX_ROWS, 'CSV exceeds 200,000 detail rows.');
  for (let i = headerAt + 1; i < all.length; i++) {
    const cells = all[i], rowNumber = i + 1;
    requireValue(cells.length === headers.length, `Row ${rowNumber}: wrong column count.`);
    const cell = (name: string) => cells[positions.get(name)!];
    const date = isoDate(cell('Date')); days.add(date);
    requireValue(!declaredPeriod || date >= declaredPeriod[0] && date <= declaredPeriod[1], `Row ${rowNumber}: date is outside report properties.`);
    requireValue(/^Politika\.rs - Display(?: » .+)?$/.test(cell('Ad unit (all levels)')), `Row ${rowNumber}: ad unit is outside Politika.rs - Display.`);
    const dimensions = Object.fromEntries(spec.dimensions.filter(d => d !== 'Key-values').map(d => [d, cell(d)]));
    requireValue(Object.values(dimensions).every(v => v.length > 0 && v.length <= 2000), `Row ${rowNumber}: missing or oversized dimension.`);
    if (spec.id === '02') requireValue(/^\d+$/.test(cell('Line item ID')), `Row ${rowNumber}: invalid Line item ID.`);
    let family = 'Inventory', value = 'All reported inventory';
    if (spec.id !== '03') {
      const pair = /^([^=]+)=([^=]+)$/.exec(cell('Key-values'));
      requireValue(pair && spec.families.includes(pair[1]) && values[pair[1]].includes(pair[2]), `Row ${rowNumber}: unsupported Key-values entry. Missing labels are not zero traffic; use the corrected saved report.`);
      family = pair[1]; value = pair[2];
    }
    families.add(family);
    const grain = JSON.stringify([...Object.values(dimensions), family, value]);
    requireValue(!seen.has(grain), `Row ${rowNumber}: duplicate report grain. Do not append overlapping exports or subtotals.`); seen.add(grain);
    const metrics = emptyMetrics();
    spec.metrics.forEach((metric, j) => { metrics[metric] = numberCell(cell(metricHeaders[j]), metric === 'revenue', rowNumber, metricHeaders[j]); if (metrics[metric] === null) missing.add(metric); });
    if (spec.id === '01') metrics.requests = metrics.responses === null || metrics.unfilled === null ? null : safeAdd(metrics.responses, metrics.unfilled);
    if (spec.id === '03' && metrics.requests !== null && metrics.responses !== null && metrics.unfilled !== null)
      requireValue(metrics.requests === safeAdd(metrics.responses, metrics.unfilled), `Row ${rowNumber}: requests do not equal code served plus unfilled for this display report.`);
    const invalidViewability = metrics.viewable !== null && metrics.measurable !== null && metrics.viewable > metrics.measurable;
    if (invalidViewability) invalidViewabilityRows++;
    // Validate sums before returning data to React; no accepted file can crash a later filtered summary.
    const boundKey = `${family}=${value}`, bounds = aggregateBounds.get(boundKey) ?? emptyMetrics();
    for (const metric of Object.keys(metrics) as Metric[]) if (metrics[metric] !== null) bounds[metric] = safeAdd(bounds[metric] ?? 0, metrics[metric]!);
    aggregateBounds.set(boundKey, bounds);
    rows.push({dimensions, family, value, metrics, invalidViewability});
  }
  requireValue(rows.length, 'The report has no detail rows. Export a completed date range with data.');
  if (missing.size) warnings.push(`Missing values remain unknown: ${[...missing].map(m => METRIC_LABELS[m]).join(', ')}. Affected totals and ratios are unavailable.`);
  if (invalidViewabilityRows) warnings.push(`${invalidViewabilityRows} row(s) have viewable impressions above measurable impressions in the source. Raw counters are preserved; viewability is unavailable for affected groups.`);
  for (const family of spec.families) if (!families.has(family)) warnings.push(`No rows for ${family}; this does not prove zero traffic.`);
  if (families.has('Variant') && !['A', 'B'].every(value => rows.some(r => r.family === 'Variant' && r.value === value))) warnings.push('Only one A/B variant has rows. Missing variants are unknown, not zero.');
  const sortedDays = [...days].sort(), [start, end] = declaredPeriod ?? [sortedDays[0], sortedDays.at(-1)!];
  if (!declaredPeriod) warnings.push('Date range comes from observed rows; completeness outside those dates is unknown.');
  const expectedDays = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (days.size !== expectedDays) warnings.push(`${expectedDays - days.size} date(s) have no rows. Missing days are unknown, not zero.`);
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Belgrade', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
  if (end >= today) warnings.push('The date range includes an unfinished or future day in Europe/Belgrade.');
  if (spec.metrics.includes('revenue')) warnings.push('GAM CSV revenue is rounded per row. Keep the XLSX export for higher precision; small differences may be rounding.');
  return {id: spec.id, name: props.get('Report name') ?? spec.title, rows, dimensions: spec.dimensions.filter(d => d !== 'Key-values'),
    metrics: spec.id === '01' ? [...spec.metrics, 'requests'] : [...spec.metrics], families: spec.families.filter(f => families.has(f)),
    start, end, periodFromProperties: !!declaredPeriod, warnings, requestBasis: spec.id === '01' ? 'components' : spec.id === '03' ? 'direct' : 'unavailable'};
}

export type Group = {value: string; rows: number; totals: Metrics; ecpm: number | null; requestRpm: number | null; responseRate: number | null; unfilledRate: number | null; ctr: number | null; viewability: number | null; measurability: number | null};
/** Each result has exactly one key family. There is deliberately no cross-family or cross-file grand total. */
export function summarizePolitika(report: PolitikaReport, family: string, filters: Record<string, string> = {}): Group[] {
  requireValue(report.families.includes(family), 'Select a key family present in this report.');
  requireValue(Object.keys(filters).every(k => report.dimensions.includes(k)), 'Unknown breakdown dimension.');
  const groups = new Map<string, {rows: number; totals: Metrics; invalidViewability: boolean}>();
  for (const row of report.rows) {
    if (row.family !== family || Object.entries(filters).some(([key, value]) => value && row.dimensions[key] !== value)) continue;
    let group = groups.get(row.value);
    if (!group) { group = {rows: 0, totals: emptyMetrics(), invalidViewability: false}; report.metrics.forEach(m => { group!.totals[m] = 0; }); groups.set(row.value, group); }
    group.rows++;
    group.invalidViewability ||= row.invalidViewability;
    for (const m of report.metrics) group.totals[m] = group.totals[m] === null || row.metrics[m] === null ? null : safeAdd(group.totals[m]!, row.metrics[m]!);
  }
  const ratio = (a: number | null, b: number | null, factor: number) => a === null || b === null || !b ? null : a / b * factor;
  return [...groups].sort(([a], [b]) => values[family] ? values[family].indexOf(a) - values[family].indexOf(b) : a.localeCompare(b, 'en')).map(([value, group]) => {
    const t = group.totals; return {value, ...group, ecpm: ratio(t.revenue, t.impressions, .001), requestRpm: ratio(t.revenue, t.requests, .001),
      responseRate: ratio(t.responses, t.requests, 100), unfilledRate: ratio(t.unfilled, t.requests, 100), ctr: ratio(t.clicks, t.impressions, 100), viewability: group.invalidViewability ? null : ratio(t.viewable, t.measurable, 100), measurability: ratio(t.measurable, t.eligible, 100)};
  });
}
