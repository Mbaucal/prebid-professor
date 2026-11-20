import {assertReportPlan} from './ab-report-plan.mjs';
import {AB_MEASUREMENT_KIND} from './ab-measurement-contracts.mjs';
import {canonical,check,isRecord} from './ab-measurement-utils.mjs';

// Offline inspection only. These observations do not prove collection coverage,
// source authenticity, CMP eligibility or a GAM revenue/pageview cohort join.
const TOP='arms,assignment,collection,consentPolicy,coverage,createdAt,droppedEvents,events,experimentId,kind,loader,pageId,schemaVersion,site,testId,trafficBPercent';
const EVENTS={assignment:['variant'],'script-requested':['arm'],'script-loaded':['arm'],'runtime-started':['arm'],
  'arm-failed':['arm','reason'],fallback:['fromArm','toArm','reason'],exclusion:['reason','phase'],
  'terminal-failure':['arm','reason'],'qa-forced':['arm'],'random-unavailable':[],'duplicate-loader':[]};
const exact=(value,keys)=>isRecord(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const side=value=>value==='A'||value==='B';
function instant(value){return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;}
export function validateAbMemoryMeasurement(plan,value){
  assertReportPlan(plan);
  check(exact(value,TOP.split(','))&&value.schemaVersion===1&&value.kind===AB_MEASUREMENT_KIND,'Use a complete memory measurement export.');
  check(value.site===plan.site&&value.experimentId===plan.experimentId&&value.testId===plan.testId&&value.trafficBPercent===plan.trafficBPercent&&canonical(value.loader)===canonical(plan.loader),'Measurement belongs to another saved experiment.');
  const pins=Object.fromEntries(['A','B'].map(key=>[key,{release:plan.arms[key].release,scriptSha256:plan.arms[key].scriptSha256}]));
  check(canonical(value.arms)===canonical(pins),'Measurement script pins differ from the reporting plan.');
  check(value.collection==='memory-only'&&value.coverage==='unknown'&&value.consentPolicy==='native-runtime-unchanged','Memory observations cannot claim collector coverage or a different consent policy.');
  check((value.pageId===null||typeof value.pageId==='string'&&/^[a-f0-9]{32}$/.test(value.pageId))&&instant(value.createdAt),'Invalid page observation identity.');
  check(Number.isSafeInteger(value.droppedEvents)&&value.droppedEvents>=0&&Array.isArray(value.events)&&value.events.length<=64,'Invalid bounded memory event sequence.');
  check(value.assignment===null||exact(value.assignment,['variant','at'])&&side(value.assignment.variant)&&instant(value.assignment.at),'Invalid original assignment.');
  let assignment=null,execution=null,preAssignmentTerminal=false;
  for(let index=0;index<value.events.length;index++){
    const row=value.events[index],fields=EVENTS[row?.type];
    check(fields&&exact(row,['seq','at','type',...fields])&&row.seq===index+1&&instant(row.at),'Invalid memory event.');
    for(const key of ['variant','arm','fromArm','toArm'])if(key in row)check(side(row[key]),'Invalid observed arm.');
    if('reason' in row)check(typeof row.reason==='string'&&/^[a-z-]{1,64}$/.test(row.reason),'Invalid observation reason.');
    if(row.type==='assignment'){check(!assignment&&!preAssignmentTerminal&&value.assignment&&row.variant===value.assignment.variant,'The original assignment changed or followed excluded/QA traffic.');assignment=row.variant;}
    if(row.type==='runtime-started'){check(execution===null&&(!value.assignment||assignment),'More than one runtime or execution before assignment was observed.');execution=row.arm;}
    if(row.type==='fallback')check(assignment&&row.toArm==='A','Fallback must retain its original assignment and use control A.');
    if(row.type==='exclusion'){check(row.phase===(assignment?'after-assignment':'before-assignment'),'Exclusion phase does not match the assignment sequence.');if(!assignment)preAssignmentTerminal=true;}
    if(row.type==='qa-forced'||row.type==='random-unavailable'){check(!assignment,'QA-forced/random-unavailable traffic cannot be a randomized assignment.');preAssignmentTerminal=true;}
  }
  check((assignment===null)===(value.assignment===null),'Original assignment is missing from the event sequence.');
  return value;
}

/** Inspect copied exports in memory, without accepting a coverage claim or CSV revenue join. */
export function previewAbMemoryMeasurements(plan,snapshots){
  assertReportPlan(plan);check(Array.isArray(snapshots)&&snapshots.length<=10000,'Use at most 10,000 copied memory exports per offline inspection.');
  const pages=new Map();let duplicateExports=0,unidentifiedExports=0;
  for(const value of snapshots){
    validateAbMemoryMeasurement(plan,value);
    if(value.pageId===null){unidentifiedExports++;continue;}
    const old=pages.get(value.pageId);
    if(old){
      duplicateExports++;
      const stable=row=>canonical({...row,events:[],droppedEvents:0});
      check(stable(old)===stable(value),'The same page identifier has conflicting immutable metadata.');
      const shorter=old.events.length<=value.events.length?old:value,longer=shorter===old?value:old;
      check(canonical(shorter.events)===canonical(longer.events.slice(0,shorter.events.length)),'Conflicting event history for the same page identifier.');
      if(value.events.length<old.events.length||value.events.length===old.events.length&&value.droppedEvents<old.droppedEvents)continue;
    }
    pages.set(value.pageId,value);
  }
  const assignments={A:0,B:0},execution={A:{A:0,B:0,none:0},B:{A:0,B:0,none:0}},fallbacks={A:0,B:0},exclusions={beforeAssignment:0,afterAssignment:0};
  let droppedEvents=0,terminalFailures=0;
  for(const value of pages.values()){
    droppedEvents+=value.droppedEvents;check(Number.isSafeInteger(droppedEvents),'Observation counters exceed supported precision.');
    const original=value.assignment?.variant;
    if(original){assignments[original]++;const executed=value.events.find(row=>row.type==='runtime-started')?.arm??'none';execution[original][executed]++;if(value.events.some(row=>row.type==='fallback'))fallbacks[original]++;}
    if(value.events.some(row=>row.type==='exclusion'&&row.phase==='before-assignment'))exclusions.beforeAssignment++;
    if(value.events.some(row=>row.type==='exclusion'&&row.phase==='after-assignment'))exclusions.afterAssignment++;
    if(value.events.some(row=>row.type==='terminal-failure'))terminalFailures++;
  }
  const count=assignments.A+assignments.B;
  return {schemaVersion:1,kind:'tessera-ab-memory-preview',planId:plan.id,experimentId:plan.experimentId,testId:plan.testId,
    receivedExports:snapshots.length,identifiedPages:pages.size,duplicateExports,unidentifiedExports,assignments,execution,fallbacks,exclusions,terminalFailures,droppedEvents,
    srm:{status:'unavailable',reason:'The all-assigned collection population and missingness are unknown.',expectedBPercent:plan.trafficBPercent,observedBPercent:count?100*assignments.B/count:null},
    coverage:'unknown',revenueReady:false,pageRpm:{A:null,B:null},upliftPercent:null,winner:null,
    blockers:['Copied memory exports are not a verified all-assigned population; missing pages cannot be zero.',
      'Runtime start is not an impression or paid win. GAM aggregate revenue is not joined to these pages.',
      'CMP eligibility and collector legal basis, population, retention and activation are not configured.',
      'Assignment-day and impression-day cohorts require an explicit join, including midnight and Stop.',
      ...(exclusions.afterAssignment?['Post-assignment exclusions retain their assigned cohort and can leave unlabelled revenue.']:[]),
      ...(unidentifiedExports?['Some exports have no page identifier and cannot be deduplicated.']:[]),
      ...(droppedEvents?['The bounded memory ledger dropped events; outcomes are incomplete.']:[])]};
}
