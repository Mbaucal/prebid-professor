export const GAM_REPORT_V2_KIND:'tessera-gam-report-plan-v2';
export const GAM_REPORT_V2_CSV_LIMIT:number;
export const GAM_REPORT_V2_MAX_ROWS:number;
export const GAM_REPORT_V2_BREAKDOWN_LIMIT:number;
export const GAM_REPORT_V2_BASE_COLUMNS:readonly string[];
export type GamReportV2Purpose='overall'|'prebid'|'refresh'|'startup'|'inventory';
export type GamReportV2Dimension='adUnit'|'deviceCategory'|'country'|'requestedAdSizes'|'creativeSize'|'orderId'|'lineItemId'|'creativeId'|'hb_bidder'|'hb_pb'|'hb_size'|'aq_bid_origin'|'refresh_count'|'refresh_bucket'|'refresh_interval'|'refresh_policy'|'aq_first_request'|'aq_consent_wait'|'aq_bidder_count'|'aq_bid_count'|'aq_timed_out';
export type GamReportV2Metric='impressions'|'revenue'|'clicks'|'adRequests'|'responsesServed'|'unfilledImpressions'|'eligibleImpressions'|'measurableImpressions'|'viewableImpressions';
export type GamReportV2CatalogEntry<K extends string>={key:K;label:string;help?:string;values?:readonly string[]};
export const GAM_REPORT_V2_PURPOSES:readonly GamReportV2CatalogEntry<GamReportV2Purpose>[];
export const GAM_REPORT_V2_DIMENSIONS:readonly GamReportV2CatalogEntry<GamReportV2Dimension>[];
export const GAM_REPORT_V2_METRICS:readonly GamReportV2CatalogEntry<GamReportV2Metric>[];
export type GamReportV2Input={
  networkCode:string;inventoryPath:string;startDate:string;endDate:string;currency:string;timeZone:string;
  revenueBasis:'net'|'gross'|'unknown';revenueMetric:'total'|'cpm-cpc';
  purpose:GamReportV2Purpose;metricFamily:'total'|'ad-server';
  scope:{orderIds:string[];lineItemIds:string[]};dimensions:GamReportV2Dimension[];metrics:GamReportV2Metric[];
  sourceColumns:Record<string,string>;compatibilityMode:'off'|'on'|'unknown';
};
export type GamReportV2Defaults=Omit<GamReportV2Input,'networkCode'|'inventoryPath'|'startDate'|'endDate'|'currency'>&{
  networkCode:string|null;inventoryPath:string|null;startDate:null;endDate:null;currency:null;
};
export type GamReportV2Plan={
  schemaVersion:2;kind:'tessera-gam-report-plan-v2';id:string;site:string;experimentId:string;
  versionId:string;identityKey:'TestId';recordSha256:string;zipSha256:string;
  loader:{version:string;sha256:string};trafficBPercent:number;
  arms:{A:{release:string;runtimeVersion:string;scriptSha256:string;runtimeSha256:string};B:{release:string;runtimeVersion:string;scriptSha256:string;runtimeSha256:string}};
  prebidSha256:string|null;report:GamReportV2Input;
  source:{savedPackageScopeVerified:true;gamReportSourceVerified:false;scopeDeclaration:'operator'};
  measurement:{collection:'disabled';coverage:'unknown';revenueReady:false};createdAt:string;createdBy:string;
};
export type GamReportV2Detail={plan:GamReportV2Plan;planSha256:string};
export type GamReportV2Created=GamReportV2Detail&{created:boolean};
export type GamReportV2Summary=Pick<GamReportV2Plan,'id'|'createdAt'|'report'|'versionId'|'identityKey'>&{planSha256:string};
export type GamReportV2Listing={plans:GamReportV2Summary[];defaults:GamReportV2Defaults;sourceError:string|null};
export type GamReportV2Coverage={provided:number;missing:number};
export type GamReportV2Totals={
  rowCount:number;impressions:number|null;revenueMicros:number|null;revenue:string|null;clicks:number|null;
  adRequests:number|null;responsesServed:number|null;unfilledImpressions:number|null;
  eligibleImpressions:number|null;measurableImpressions:number|null;viewableImpressions:number|null;
  metricCoverage:Partial<Record<GamReportV2Metric,GamReportV2Coverage>>;
  revenuePerThousandImpressions:number|null;clickThroughRatePercent:number|null;
  responseRatePercent:number|null;viewabilityPercent:number|null;measurabilityPercent:number|null;
  pageRpm:null;receivedAssignments:null;impressionsPerAssignedPage:null;
};
export type GamReportV2BreakdownGroup={value:string;A:GamReportV2Totals;B:GamReportV2Totals};
export type GamReportV2Breakdown={dimension:GamReportV2Dimension;groupCount:number;groups:GamReportV2BreakdownGroup[];other:{groupCount:number;A:GamReportV2Totals;B:GamReportV2Totals}|null};
export type GamReportV2Preview={
  schemaVersion:2;kind:'tessera-gam-report-preview-v2';planId:string;experimentId:string;versionId:string;identityKey:'TestId';
  period:Pick<GamReportV2Input,'startDate'|'endDate'|'timeZone'>;
  source:Pick<GamReportV2Input,'currency'|'revenueBasis'|'revenueMetric'|'metricFamily'|'purpose'|'scope'|'dimensions'|'metrics'|'sourceColumns'|'compatibilityMode'>&{
    format:'tessera-gam-detailed-v2';csvSha256:string;gamReportSourceVerified:false;scopeDeclaration:'operator';
  };
  totals:{A:GamReportV2Totals;B:GamReportV2Totals};breakdowns:GamReportV2Breakdown[];
  missingDays:Array<{date:string;variant:'A'|'B'}>;providedRows:number;dataComplete:false;
  coverage:'unknown';revenueReady:false;winner:null;upliftPercent:null;blockers:string[];notes:string[];
};
export function gamReportV2Columns(report:Pick<GamReportV2Input,'dimensions'|'metrics'>):string[];
