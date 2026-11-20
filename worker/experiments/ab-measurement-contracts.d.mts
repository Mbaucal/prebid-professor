export const AB_REPORT_PLAN_KIND: 'tessera-ab-report-plan';
export const AB_MEASUREMENT_KIND: 'tessera-ab-memory-measurement';
export const AB_GAM_CSV_LIMIT: number;
export const AB_GAM_COLUMNS: readonly string[];

export type AbVariant = 'A' | 'B';
export type AbReportInput = {
  networkCode: string;
  inventoryPath: string;
  startDate: string;
  endDate: string;
  currency: string;
  timeZone: string;
  revenueBasis: 'net' | 'gross' | 'unknown';
  revenueMetric: 'total' | 'cpm-cpc';
};
export type AbReportDefaults = Omit<AbReportInput, 'networkCode' | 'inventoryPath' | 'startDate' | 'endDate' | 'currency'> & {
  networkCode: string | null;
  inventoryPath: string | null;
  startDate: null;
  endDate: null;
  currency: null;
};
export type AbReportArm = {
  release: string;
  runtimeVersion: string;
  scriptSha256: string;
  runtimeSha256: string;
};
export type AbReportPlan = {
  schemaVersion: 1;
  kind: 'tessera-ab-report-plan';
  id: string;
  site: string;
  experimentId: string;
  testId: string;
  recordSha256: string;
  zipSha256: string;
  loader: { version: string; sha256: string };
  trafficBPercent: number;
  arms: { A: AbReportArm; B: AbReportArm };
  prebidSha256: string | null;
  report: AbReportInput;
  source: { savedPackageScopeVerified: true; gamReportSourceVerified: false };
  measurement: { collection: 'disabled'; coverage: 'unknown'; revenueReady: false };
  createdAt: string;
  createdBy: string;
};
export type AbReportPlanResult = { plan: AbReportPlan; planSha256: string };
export type AbReportPlanCreated = AbReportPlanResult & { created: boolean };
export type AbReportPlanSummary = Pick<AbReportPlan, 'id' | 'createdAt' | 'report'> & { planSha256: string };
export type AbReportPlanList = {
  plans: AbReportPlanSummary[];
  defaults: AbReportDefaults;
  sourceError: string | null;
};
export type AbGamTotals = {
  rowCount: number;
  impressions: number | null;
  revenueMicros: number | null;
  revenue: string | null;
  adRequests: number | null;
  responsesServed: number | null;
  measurableImpressions: number | null;
  viewableImpressions: number | null;
  revenuePerThousandImpressions: number | null;
  responseRatePercent: number | null;
  viewabilityPercent: number | null;
  receivedAssignments: null;
  pageRpm: null;
  impressionsPerAssignedPage: null;
};
export type AbGamPreview = {
  schemaVersion: 1;
  kind: 'tessera-ab-gam-report-preview';
  planId: string;
  experimentId: string;
  testId: string;
  period: Pick<AbReportInput, 'startDate' | 'endDate' | 'timeZone'>;
  source: Pick<AbReportInput, 'currency' | 'revenueBasis' | 'revenueMetric'> & {
    format: 'tessera-ab-gam-daily-v1'; csvSha256: string;
  };
  totals: { A: AbGamTotals; B: AbGamTotals };
  missingRows: Array<{ date: string; variant: AbVariant }>;
  providedRows: number;
  dataComplete: boolean;
  coverage: 'unknown';
  revenueReady: false;
  winner: null;
  upliftPercent: null;
  blockers: string[];
  notes: string[];
};

export type MeasurementReport = AbReportInput;
export type MeasurementPlanSummary = AbReportPlanSummary;
export type MeasurementPlan = AbReportPlan;
export type MeasurementPlanListing = AbReportPlanList;
export type MeasurementPlanDetail = AbReportPlanResult;
export type GamReportPreview = AbGamPreview;
