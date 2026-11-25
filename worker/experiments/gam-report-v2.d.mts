import type {GamReportV2Plan,GamReportV2Preview} from './gam-report-v2-contracts.mjs';
export function gamReportV2Template(plan:GamReportV2Plan):string;
export function previewGamReportV2(plan:GamReportV2Plan,input:{csv:string},now?:number):Promise<GamReportV2Preview>;
