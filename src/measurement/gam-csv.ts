/** Five flat display GAM export presets. Source declarations stay separate from verified site scope. No persistence. */
export const GAM_CSV_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 200_000;
export type ReportId = '01' | '02' | '03' | '04' | '05';
export type Metric = 'impressions' | 'revenue' | 'clicks' | 'eligible' | 'measurable' | 'viewable' | 'responses' | 'unfilled' | 'requests';
export type Metrics = Record<Metric, number | null>; // Revenue is integer micros until presentation.
export type ReportRow = {dimensions: Record<string, string>; family: string; value: string; metrics: Metrics; invalidViewability: boolean; invalidMeasurability: boolean};
export type GamCsvReport = {
  id: ReportId; name: string; rows: ReportRow[]; dimensions: string[]; metrics: Metric[];
  families: string[]; start: string; end: string; periodFromProperties: boolean;
  warnings: string[]; requestBasis: 'direct' | 'components' | 'unavailable';
  currency: string | null; timeZone: string | null;
  scope: {network: string | null; networkCode: string | null; adUnitIds: string[]; inventoryRoots: string[]; orderIds: string[]; lineItemIds: string[]; networkVerified: boolean; inventoryVerified: boolean; prebidVerified: boolean};
};
const monetary = ['impressions', 'revenue', 'clicks', 'eligible', 'measurable', 'viewable'] as Metric[];
const timeBuckets = ['lt_500', '500_999', '1000_1499', '1500_1999', '2000_2999', '3000_plus'];
const values: Record<string, string[]> = {
  Variant: ['A', 'B'], aq_bid_origin: ['fresh', 'cached', 'none'],
  refresh_bucket: ['initial', 'r1_3', 'r4_plus'], refresh_interval: ['initial', 'unscheduled'],
  aq_first_request: timeBuckets, aq_consent_wait: [...timeBuckets, 'na', 'timeout'],
};
const base = ['Date', 'Ad unit (all levels)'];
const keyed = [...base, 'Device category', 'Key-values'];
export const GAM_REPORTS: {id: ReportId; title: string; dimensions: string[]; metrics: Metric[]; families: string[]}[] = [
  {id: '01', title: '01 · Monetization by A/B variant', dimensions: keyed, metrics: [...monetary, 'responses', 'unfilled'], families: ['Variant']},
  {id: '02', title: '02 · Prebid and bid origin', dimensions: [...base, 'Line item ID', 'Key-values'], metrics: monetary, families: ['Variant', 'aq_bid_origin']},
  {id: '03', title: '03 · Unfilled inventory', dimensions: [...base, 'Device category', 'Requested ad sizes'], metrics: ['requests', 'responses', 'unfilled'], families: ['Inventory']},
  {id: '04', title: '04 · Refresh', dimensions: keyed, metrics: monetary, families: ['refresh_bucket', 'refresh_interval']},
  {id: '05', title: '05 · First request and CMP', dimensions: keyed, metrics: ['impressions', 'responses'], families: ['aq_first_request', 'aq_consent_wait']},
];
export const METRIC_LABELS: Record<Metric, string> = {
  impressions: 'Impressions', revenue: 'Revenue', clicks: 'Clicks', eligible: 'AV eligible impressions',
  measurable: 'AV measurable impressions', viewable: 'AV viewable impressions', responses: 'Code served',
  unfilled: 'Unfilled impressions', requests: 'Ad requests',
};
const metricNames: Record<Metric, string> = {
  impressions: 'impressions', revenue: 'CPM and CPC revenue', clicks: 'clicks',
  eligible: 'Active View eligible impressions', measurable: 'Active View measurable impressions',
  viewable: 'Active View viewable impressions', responses: 'code served count',
  unfilled: 'Unfilled impressions', requests: 'ad requests',
};
export function gamCsvHeaders(id: ReportId): string[] {
  const spec = GAM_REPORTS.find(x => x.id === id)!;
  return [...spec.dimensions, ...spec.metrics.map(m => m === 'unfilled' ? metricNames[m] : `${id === '02' ? 'Ad server' : 'Total'} ${metricNames[m]}`)];
}
function requireValue(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const emptyMetrics = (): Metrics => ({impressions: null, revenue: null, clicks: null, eligible: null, measurable: null, viewable: null, responses: null, unfilled: null, requests: null});

/** RFC-style quoted cells, including embedded newlines; no silent truncation or permissive quote repair. */
function csvRows(input: string): string[][] {
  requireValue(typeof input === 'string' && new TextEncoder().encode(input).length <= GAM_CSV_BYTES, 'CSV exceeds the 20 MiB limit. Export a shorter date range.');
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
export type GamCsvContext = {
  siteName?: string; gamPath?: string;
  expectedNetwork?: string; expectedAdUnitRoot?: string; expectedAdUnitId?: string;
  prebidOrderIds?: string[]; prebidLineItemIds?: string[];
  currency?: string; timeZone?: string;
};
const clean = (value: string | undefined) => (value ?? '').trim();
const sameText = (a: string, b: string) => a.toLocaleLowerCase('en') === b.toLocaleLowerCase('en');
const equalIds = (a: string[], b: string[]) => { const left = [...a].sort(), right = [...b].sort(); return left.length === right.length && left.every((value, index) => value === right[index]); };
function knownIds(values: string[] | undefined, label: string): string[] {
  const ids = values ?? [];
  requireValue(ids.length <= 5000 && ids.every(value => /^[1-9]\d{0,19}$/.test(value)) && new Set(ids).size === ids.length, `Use distinct positive ${label} IDs.`);
  return ids;
}
function checkProperties(props: Map<string, string>, id: ReportId, warnings: string[], context: GamCsvContext) {
  if (props.has('Report type')) requireValue(props.get('Report type') === 'Historical', 'Use a Historical display report. Other report types need a separate importer.');
  const currency = props.get('Report currency') || clean(context.currency) || null;
  requireValue(currency === null || /^[A-Z]{3}$/.test(currency), 'Report currency must be an ISO currency code such as EUR or USD.');
  if (props.has('Report currency') && clean(context.currency)) requireValue(currency === context.currency, 'Report currency does not match the declared report settings.');
  const timeZone = props.get('Time zone') || clean(context.timeZone) || null;
  if (timeZone) { try { new Intl.DateTimeFormat('en', {timeZone}).format(); } catch { throw new Error('Report time zone is not a supported IANA time zone.'); } }
  if (props.has('Time zone') && clean(context.timeZone)) requireValue(timeZone === context.timeZone, 'Time zone does not match the declared report settings.');
  if (!props.has('Report currency') || !props.has('Time zone')) warnings.push('Currency or time zone is absent from the export. Missing settings remain unknown unless declared in report settings; export with Include report properties.');
  const network = props.get('Publisher network') || null;
  const networkCode = props.get('Network code') || (network && /^\d+$/.test(network) ? network : null);
  if (networkCode) requireValue(/^[1-9]\d{0,19}$/.test(networkCode), 'Invalid network code in report properties.');
  const expectedNetwork = clean(context.expectedNetwork);
  let networkVerified = false;
  if (expectedNetwork) {
    const actual = /^\d+$/.test(expectedNetwork) ? networkCode : network;
    if (actual) { requireValue(sameText(actual, expectedNetwork), 'Publisher network does not match the expected export network.'); networkVerified = true; }
  }
  if (!networkVerified) warnings.push('Export network is not verified against this site. A publisher network name does not prove the numeric network in the saved GAM path; parent/child MCM networks may differ.');
  const filters = props.get('Filters');
  const parsed = new Map<string, string[]>();
  if (filters && filters !== '(none)' && filters !== 'None') {
    for (const part of filters.split(' AND ')) {
      const match = /^(Ad unit ID \(all levels\)|Key-values ID|Order ID|Line item ID) = ([1-9]\d*(?:, [1-9]\d*)*)$/.exec(part);
      requireValue(match && !parsed.has(match[1]), 'Unsupported or repeated report filters. Use only the displayed inventory, key-value and delivery ID filters.');
      parsed.set(match[1], knownIds(match[2].split(', '), match[1]));
    }
  }
  const adUnitIds = parsed.get('Ad unit ID (all levels)') ?? [];
  const orderIds = parsed.get('Order ID') ?? [], lineItemIds = parsed.get('Line item ID') ?? [];
  requireValue(id === '02' || (!orderIds.length && !lineItemIds.length), 'Only report 02 may use Order or Line item filters. Overall and request reports need all demand in the selected inventory.');
  requireValue(id !== '03' || !parsed.has('Key-values ID'), 'Inventory report 03 must not filter by key-values; it includes unlabeled requests too.');
  const expectedAdUnitId = clean(context.expectedAdUnitId);
  if (expectedAdUnitId) requireValue(equalIds(adUnitIds, knownIds([expectedAdUnitId], 'ad unit')), 'Ad unit ID filter does not match the expected site inventory.');
  const expectedOrders = knownIds(context.prebidOrderIds, 'Prebid order'), expectedLines = knownIds(context.prebidLineItemIds, 'Prebid line item');
  if (id === '02' && expectedOrders.length) requireValue(equalIds(orderIds, expectedOrders), 'Order filter does not match the expected Prebid order IDs.');
  if (id === '02' && expectedLines.length) requireValue(equalIds(lineItemIds, expectedLines), 'Line item filter does not match the expected Prebid line item IDs.');
  const prebidVerified = id === '02' && (expectedOrders.length > 0 || expectedLines.length > 0);
  if (id === '02' && !prebidVerified) warnings.push('The delivery subset is not verified as Prebid. Check the export Order/Line item IDs against your Prebid setup or enter their expected IDs in report settings.');
  if (id === '02' && !orderIds.length && !lineItemIds.length) warnings.push('No delivery ID filter is declared. Do not interpret this report as Prebid-only revenue.');
  if (!filters) warnings.push('Filter metadata is absent. Inventory and delivery scope are unverified; re-export with Include report properties.');
  if (id !== '03' && id !== '04') {
    const count = parsed.get('Key-values ID')?.length ?? 0;
    const expected = {'01': 2, '02': 5, '05': 14}[id];
    if (filters && count !== expected) warnings.push(`The export filter selects ${count} key-values; report ${id} expects ${expected}. Categories may be excluded. Re-export the complete preset.`);
  }
  return {currency, timeZone, network, networkCode, adUnitIds, orderIds, lineItemIds, networkVerified, prebidVerified};
}

export function parseGamCsv(csv: string, context: GamCsvContext = {}): GamCsvReport {
  const all = csvRows(csv), headerAt = all.findIndex(row => row.includes('Date') && row.includes('Ad unit (all levels)'));
  requireValue(headerAt >= 0 && headerAt <= 30, 'No Date header found. Export CSV with English labels and Use API column names turned off.');
  const headers = all[headerAt], props = new Map<string, string>(), propertyNames = new Set<string>();
  for (const row of all.slice(0, headerAt)) {
    requireValue(row.length === 2 && row[0].length > 0 && row[0].length <= 160 && row[1].length <= (row[0] === 'Filters' ? 200000 : 2000) && !propertyNames.has(row[0].toLocaleLowerCase('en')), 'Unrecognized or repeated report properties. Export the original CSV again.');
    propertyNames.add(row[0].toLocaleLowerCase('en')); props.set(row[0], row[1]);
  }
  requireValue(new Set(headers).size === headers.length, 'Duplicate CSV headers are ambiguous.');
  if (headers.some(h => /^(Variant|aq_\w+|refresh_\w+) \(/.test(h))) throw new Error('This export uses custom dimensions, which can contain (not applicable) for earlier dates. Use these five presets with the Key-values dimension, or the saved A/B report importer for joint custom dimensions.');
  const spec = GAM_REPORTS.find(candidate => { const expected = gamCsvHeaders(candidate.id); return expected.length === headers.length && expected.every(h => headers.includes(h)); });
  requireValue(spec, 'Columns do not match display report presets 01–05. Use the listed flat columns, no totals or extra fields, with Use API column names off. Report 01 needs Total code served count and Unfilled impressions.');
  const warnings: string[] = []; const metadata = checkProperties(props, spec.id, warnings, context);
  const declaredPeriod = props.has('Date range') ? period(props.get('Date range')!) : null;
  const metricHeaders = gamCsvHeaders(spec.id).slice(spec.dimensions.length);
  const positions = new Map(headers.map((h, i) => [h, i]));
  const seen = new Set<string>(), days = new Set<string>(), families = new Set<string>();
  const aggregateBounds = new Map<string, Metrics>();
  const missing = new Set<Metric>(); const rows: ReportRow[] = []; let invalidViewabilityRows = 0, invalidMeasurabilityRows = 0;
  requireValue(all.length - headerAt - 1 <= MAX_ROWS, 'CSV exceeds 200,000 detail rows.');
  for (let i = headerAt + 1; i < all.length; i++) {
    const cells = all[i], rowNumber = i + 1;
    requireValue(cells.length === headers.length, `Row ${rowNumber}: wrong column count.`);
    const cell = (name: string) => cells[positions.get(name)!];
    const date = isoDate(cell('Date')); days.add(date);
    requireValue(!declaredPeriod || date >= declaredPeriod[0] && date <= declaredPeriod[1], `Row ${rowNumber}: date is outside report properties.`);
    const root = clean(context.expectedAdUnitRoot); const actualUnit = cell('Ad unit (all levels)');
    if (root) requireValue(sameText(actualUnit, root) || actualUnit.toLocaleLowerCase('en').startsWith(root.toLocaleLowerCase('en') + ' » '), `Row ${rowNumber}: ad unit is outside the expected site inventory root.`);
    const dimensions = Object.fromEntries(spec.dimensions.filter(d => d !== 'Key-values').map(d => [d, cell(d)]));
    requireValue(Object.values(dimensions).every(v => v.length > 0 && v.length <= 2000), `Row ${rowNumber}: missing or oversized dimension.`);
    if (spec.id === '02') {
      const lineItemId = cell('Line item ID');
      requireValue(/^[1-9]\d{0,19}$/.test(lineItemId), `Row ${rowNumber}: invalid Line item ID.`);
      if (metadata.lineItemIds.length) requireValue(metadata.lineItemIds.includes(lineItemId), `Row ${rowNumber}: Line item ID is outside the declared report filter.`);
    }
    let family = 'Inventory', value = 'All reported inventory';
    if (spec.id !== '03') {
      const pair = /^([^=]+)=([^=]+)$/.exec(cell('Key-values'));
      requireValue(pair && spec.families.includes(pair[1]) && (values[pair[1]].includes(pair[2]) || pair[1] === 'refresh_interval' && /^(?:[1-9]\d*)(?:\.\d{1,6})?$/.test(pair[2]) && Number.isFinite(Number(pair[2])) && Number(pair[2]) <= Number.MAX_SAFE_INTEGER), `Row ${rowNumber}: unsupported Key-values entry. Missing labels are not zero traffic; use the corrected saved report.`);
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
    const invalidMeasurability = metrics.measurable !== null && metrics.eligible !== null && metrics.measurable > metrics.eligible;
    if (invalidMeasurability) invalidMeasurabilityRows++;
    if (invalidViewability) invalidViewabilityRows++;
    // Validate sums before returning data to React; no accepted file can crash a later filtered summary.
    const boundKey = `${family}=${value}`, bounds = aggregateBounds.get(boundKey) ?? emptyMetrics();
    for (const metric of Object.keys(metrics) as Metric[]) if (metrics[metric] !== null) bounds[metric] = safeAdd(bounds[metric] ?? 0, metrics[metric]!);
    aggregateBounds.set(boundKey, bounds);
    rows.push({dimensions, family, value, metrics, invalidViewability, invalidMeasurability});
  }
  requireValue(rows.length, 'The report has no detail rows. Export a completed date range with data.');
  if (missing.size) warnings.push(`Missing values remain unknown: ${[...missing].map(m => METRIC_LABELS[m]).join(', ')}. Affected totals and ratios are unavailable.`);
  if (invalidViewabilityRows) warnings.push(`${invalidViewabilityRows} row(s) have viewable impressions above measurable impressions in the source. Raw counters are preserved; viewability is unavailable for affected groups.`);
  if (invalidMeasurabilityRows) warnings.push(`${invalidMeasurabilityRows} row(s) have measurable impressions above eligible impressions in the source. Raw counters are preserved; measurability is unavailable for affected groups.`);
  for (const family of spec.families) if (!families.has(family)) warnings.push(`No rows for ${family}; this does not prove zero traffic.`);
  if (families.has('Variant') && !['A', 'B'].every(value => rows.some(r => r.family === 'Variant' && r.value === value))) warnings.push('Only one A/B variant has rows. Missing variants are unknown, not zero.');
  const sortedDays = [...days].sort(), [start, end] = declaredPeriod ?? [sortedDays[0], sortedDays.at(-1)!];
  if (!declaredPeriod) warnings.push('Date range comes from observed rows; completeness outside those dates is unknown.');
  const expectedDays = (Date.parse(end) - Date.parse(start)) / 86_400_000 + 1;
  if (days.size !== expectedDays) warnings.push(`${expectedDays - days.size} date(s) have no rows. Missing days are unknown, not zero.`);
  if (metadata.timeZone) {
    const today = new Intl.DateTimeFormat('en-CA', {timeZone: metadata.timeZone, year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
    if (end >= today) warnings.push(`The date range includes an unfinished or future day in ${metadata.timeZone}.`);
  } else warnings.push('Completed-day coverage cannot be checked without the report time zone.');
  const inventoryRoots = [...new Set(rows.map(row => row.dimensions['Ad unit (all levels)'].split(' » ')[0]))];
  const inventoryVerified = !!clean(context.expectedAdUnitRoot) || !!clean(context.expectedAdUnitId);
  if (!inventoryVerified) warnings.push('Inventory scope is unverified against this site. Check the reported ad units and filter IDs or enter the expected export inventory in report settings.');
  if (inventoryRoots.length > 1) warnings.push('This export includes multiple top-level ad units. Verify that every reported root belongs to the selected site.');
  if (spec.metrics.includes('revenue')) warnings.push('GAM CSV revenue is rounded per row. Keep the XLSX export for higher precision; small differences may be rounding.');
  return {id: spec.id, name: props.get('Report name') ?? spec.title, rows, dimensions: spec.dimensions.filter(d => d !== 'Key-values'),
    metrics: spec.id === '01' ? [...spec.metrics, 'requests'] : [...spec.metrics], families: spec.families.filter(f => families.has(f)),
    start, end, periodFromProperties: !!declaredPeriod, warnings, currency: metadata.currency, timeZone: metadata.timeZone,
    scope: {network: metadata.network, networkCode: metadata.networkCode, adUnitIds: metadata.adUnitIds, inventoryRoots, orderIds: metadata.orderIds, lineItemIds: metadata.lineItemIds, networkVerified: metadata.networkVerified, inventoryVerified, prebidVerified: metadata.prebidVerified}, requestBasis: spec.id === '01' ? 'components' : spec.id === '03' ? 'direct' : 'unavailable'};
}

export type Group = {value: string; rows: number; totals: Metrics; ecpm: number | null; requestRpm: number | null; responseRate: number | null; unfilledRate: number | null; ctr: number | null; viewability: number | null; measurability: number | null};
/** Each result has exactly one key family. There is deliberately no cross-family or cross-file grand total. */
export function summarizeGamCsv(report: GamCsvReport, family: string, filters: Record<string, string> = {}): Group[] {
  requireValue(report.families.includes(family), 'Select a key family present in this report.');
  requireValue(Object.keys(filters).every(k => report.dimensions.includes(k)), 'Unknown breakdown dimension.');
  const groups = new Map<string, {rows: number; totals: Metrics; invalidViewability: boolean; invalidMeasurability: boolean}>();
  for (const row of report.rows) {
    if (row.family !== family || Object.entries(filters).some(([key, value]) => value && row.dimensions[key] !== value)) continue;
    let group = groups.get(row.value);
    if (!group) { group = {rows: 0, totals: emptyMetrics(), invalidViewability: false, invalidMeasurability: false}; report.metrics.forEach(m => { group!.totals[m] = 0; }); groups.set(row.value, group); }
    group.rows++;
    group.invalidViewability ||= row.invalidViewability;
    group.invalidMeasurability ||= row.invalidMeasurability;
    for (const m of report.metrics) group.totals[m] = group.totals[m] === null || row.metrics[m] === null ? null : safeAdd(group.totals[m]!, row.metrics[m]!);
  }
  const ratio = (a: number | null, b: number | null, factor: number) => a === null || b === null || !b ? null : a / b * factor;
  return [...groups].sort(([a], [b]) => values[family] ? values[family].indexOf(a) - values[family].indexOf(b) : a.localeCompare(b, 'en')).map(([value, group]) => {
    const t = group.totals; return {value, ...group, ecpm: ratio(t.revenue, t.impressions, .001), requestRpm: ratio(t.revenue, t.requests, .001),
      responseRate: ratio(t.responses, t.requests, 100), unfilledRate: ratio(t.unfilled, t.requests, 100), ctr: ratio(t.clicks, t.impressions, 100), viewability: group.invalidViewability ? null : ratio(t.viewable, t.measurable, 100), measurability: group.invalidMeasurability ? null : ratio(t.measurable, t.eligible, 100)};
  });
}
