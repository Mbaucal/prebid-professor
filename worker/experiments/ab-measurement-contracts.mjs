/** Public phase-one formats. These constants never enable collection or publication. */
export const AB_REPORT_PLAN_KIND='tessera-ab-report-plan';
export const AB_MEASUREMENT_KIND='tessera-ab-memory-measurement';
export const AB_GAM_CSV_LIMIT=128*1024;
export const AB_GAM_COLUMNS=Object.freeze(['date','TestId','Variant','impressions','revenue','adRequests','responsesServed','measurableImpressions','viewableImpressions']);
