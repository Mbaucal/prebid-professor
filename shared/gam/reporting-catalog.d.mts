export type ReportingKey = {
  key: string;
  type: 'FREEFORM' | 'PREDEFINED';
  reportableType: 'ON';
  values: string[];
  openDomain: boolean;
};
export type ReportingSetup = {
  schemaVersion: 1;
  profile: 'ads-js-3.25';
  keys: ReportingKey[];
};
export const REPORTING_PROFILE: 'ads-js-3.25';
export const OPEN_REPORTING_KEYS: readonly string[];
export type ReportingSelection = {key:string;values?:(string|number)[]}[];
export function reportingSetup(extra?: unknown, selection?: unknown): ReportingSetup;
export function reportingOnlyPlan(networkCode: string, extra?: unknown, selection?: unknown): {
  schemaVersion: 2; mode: 'reporting'; networkCode: string; allowOverbook: false;
  advertiser: {mode: 'none'; name: string}; orders: never[]; inventory: {kind:'none';ids:never[]};
  currency: string; sizes: string; creative: {mode:'none'}; rules: never[]; ranges: never[]; rows: never[];
  namePrefix: string; type: 'REPORTING'; costType: string;
  goal: {goalType:'NONE';unitType:'IMPRESSIONS';units:0}; start: null; end: null;
  counts: {lineItems:0;orders:0;creatives:0;associations:0}; reporting: ReportingSetup;
};
