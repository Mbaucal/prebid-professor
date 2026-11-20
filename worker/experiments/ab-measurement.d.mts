import type {AbReportPlan,AbVariant} from './ab-measurement-contracts.mjs';

type EventBase={seq:number;at:string};
export type AbMemoryEvent=EventBase&(
  |{type:'assignment';variant:AbVariant}
  |{type:'script-requested'|'script-loaded'|'runtime-started'|'qa-forced';arm:AbVariant}
  |{type:'arm-failed'|'terminal-failure';arm:AbVariant;reason:string}
  |{type:'fallback';fromArm:AbVariant;toArm:'A';reason:string}
  |{type:'exclusion';reason:string;phase:'before-assignment'|'after-assignment'}
  |{type:'random-unavailable'|'duplicate-loader'}
);
export type AbMemoryMeasurement={
  schemaVersion:1;kind:'tessera-ab-memory-measurement';site:string;experimentId:string;testId:string;
  loader:{version:string;sha256:string};trafficBPercent:number;
  arms:Record<AbVariant,{release:string;scriptSha256:string}>;
  pageId:string|null;createdAt:string;assignment:{variant:AbVariant;at:string}|null;
  events:AbMemoryEvent[];droppedEvents:number;collection:'memory-only';coverage:'unknown';consentPolicy:'native-runtime-unchanged';
};
export type AbMemoryPreview={
  schemaVersion:1;kind:'tessera-ab-memory-preview';planId:string;experimentId:string;testId:string;
  receivedExports:number;identifiedPages:number;duplicateExports:number;unidentifiedExports:number;
  assignments:Record<AbVariant,number>;execution:Record<AbVariant,Record<AbVariant|'none',number>>;
  fallbacks:Record<AbVariant,number>;exclusions:{beforeAssignment:number;afterAssignment:number};terminalFailures:number;droppedEvents:number;
  srm:{status:'unavailable';reason:string;expectedBPercent:number;observedBPercent:number|null};
  coverage:'unknown';revenueReady:false;pageRpm:Record<AbVariant,null>;upliftPercent:null;winner:null;blockers:string[];
};
export function validateAbMemoryMeasurement(plan:AbReportPlan,value:unknown):AbMemoryMeasurement;
export function previewAbMemoryMeasurements(plan:AbReportPlan,snapshots:unknown[]):AbMemoryPreview;
