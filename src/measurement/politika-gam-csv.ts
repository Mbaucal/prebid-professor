/** Compatibility entry for the reviewed original Politika exports. New UI uses site-neutral gam-csv. */
import {GAM_REPORTS,parseGamCsv} from './gam-csv';
export {GAM_CSV_BYTES as POLITIKA_CSV_BYTES,GAM_REPORTS as POLITIKA_REPORTS,METRIC_LABELS,gamCsvHeaders as politikaHeaders,summarizeGamCsv as summarizePolitika} from './gam-csv';
export type {Group,ReportId,Metric,Metrics,ReportRow,GamCsvReport as PolitikaReport} from './gam-csv';
export function parsePolitikaCsv(csv: string) {
  const hasFilters = /(?:^|\n)Filters,/.test(csv.replace(/^\uFEFF/, ''));
  const report = parseGamCsv(csv, {
    expectedNetwork:'Politika novine i magazini doo',expectedAdUnitRoot:'Politika.rs - Display',currency:'EUR',timeZone:'Europe/Belgrade',
    ...(hasFilters ? {expectedAdUnitId:'23338702405',prebidOrderIds:['4071347028','4071372871','4071372874','4071347031','4071372877']} : {}),
  });
  const defaultName = GAM_REPORTS.find(spec=>spec.id===report.id)!.title;
  if (report.name !== defaultName && !report.name.startsWith(`Politika | ${report.id} `)) throw new Error('Report name does not match the detected original Politika preset.');
  if (!/Report currency,/.test(csv) || !/Time zone,/.test(csv)) report.warnings.push('Currency and time zone are assumed for this legacy compatibility entry: EUR / Europe/Belgrade.');
  return report;
}
