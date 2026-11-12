import {descriptor as rules322} from '../../.generated/runtime-322-manifest.mjs';
import {buildArtifactCandidate as rules322Candidate} from '../runtime-322/artifact-candidate.mjs';
import {previewInput as rules322Input} from '../runtime-322/snapshot.mjs';
import {requireBidderRulesRuntime} from '../../shared/bidder-rules/settings.mjs';
import {descriptor as contextual321} from '../../.generated/runtime-321-manifest.mjs';
import {buildArtifactCandidate as contextual321Candidate} from '../runtime-321/artifact-candidate.mjs';
import {previewInput as contextual321Input} from '../runtime-321/snapshot.mjs';
import {requireContextualRuntime} from '../../shared/contextual-signals/settings.mjs';
import {descriptor as combined3201} from '../../.generated/runtime-3201-manifest.mjs';
import {buildArtifactCandidate as combined3201Candidate} from '../runtime-3201/artifact-candidate.mjs';
import {previewInput as combined3201Input} from '../runtime-3201/snapshot.mjs';
import {descriptor as codes3191} from '../../.generated/runtime-3191-manifest.mjs';
import {buildArtifactCandidate as codes3191Candidate} from '../runtime-3191/artifact-candidate.mjs';
import {previewInput as codes3191Input} from '../runtime-3191/snapshot.mjs';
import {descriptor as maps320} from '../../.generated/runtime-320-manifest.mjs';
import {buildArtifactCandidate as maps320Candidate} from '../runtime-320/artifact-candidate.mjs';
import {previewInput as maps320Input} from '../runtime-320/snapshot.mjs';
import {descriptor as geo319} from '../../.generated/runtime-319-manifest.mjs';
import {buildArtifactCandidate as geo319Candidate} from '../runtime-319/artifact-candidate.mjs';
import {previewInput as geo319Input} from '../runtime-319/snapshot.mjs';
import {requireCountryRules} from '../runtime-319/settings-guard.mjs';
import {descriptor as geo318} from '../../.generated/runtime-318-manifest.mjs';
import {buildArtifactCandidate as geo318Candidate} from '../runtime-318/artifact-candidate.mjs';
import {previewInput as geo318Input} from '../runtime-318/snapshot.mjs';
import {descriptor as conditional317} from '../../.generated/runtime-317-manifest.mjs';
import {buildArtifactCandidate as conditional317Candidate} from '../runtime-317/artifact-candidate.mjs';
import {previewInput as conditional317Input} from '../runtime-317/snapshot.mjs';
import {descriptor as patch3162} from '../../.generated/runtime-3162-manifest.mjs';
import {buildArtifactCandidate as patch3162Candidate} from '../runtime-3162/artifact-candidate.mjs';
import {previewInput as patch3162Input} from '../runtime-3162/snapshot.mjs';
import {descriptor as patch3161} from '../../.generated/runtime-3161-manifest.mjs';
import {buildArtifactCandidate as patch3161Candidate} from '../runtime-3161/artifact-candidate.mjs';
import {previewInput as patch3161Input} from '../runtime-3161/snapshot.mjs';
import {descriptor as stable316} from '../../.generated/runtime-316-manifest.mjs';
import {buildArtifactCandidate as stable316Candidate} from '../runtime-316/artifact-candidate.mjs';
import {previewInput as stable316Input} from '../runtime-316/snapshot.mjs';
import {descriptor as revenueV3} from '../../.generated/runtime-revenue-v3-manifest.mjs';
import {buildArtifactCandidate as revenueV3Candidate} from '../runtime-revenue-v3/artifact-candidate.mjs';
import {previewInput as revenueV3Input} from '../runtime-revenue-v3/snapshot.mjs';
import {descriptor as revenueV2} from '../../.generated/runtime-revenue-v2-manifest.mjs';
import {buildArtifactCandidate as revenueV2Candidate} from '../runtime-revenue-v2/artifact-candidate.mjs';
import {previewInput as revenueV2Input} from '../runtime-revenue-v2/snapshot.mjs';
import {descriptor as revenue} from '../../.generated/runtime-revenue-manifest.mjs';
import {buildArtifactCandidate as revenueCandidate} from '../runtime-revenue-v1/artifact-candidate.mjs';
import {previewInput as revenueInput} from '../runtime-revenue-v1/snapshot.mjs';
import {requireRevenueRuntime} from '../runtime-322/settings-guard.mjs';
import {descriptor as readiness} from '../../.generated/runtime-readiness-manifest.mjs';
import {buildArtifactCandidate as readinessCandidate} from '../runtime-readiness-v1/artifact-candidate.mjs';
/** All listed engines are bundled; selection never upgrades implicitly. */
import {descriptor as reporting} from '../../.generated/runtime-reporting-manifest.mjs';
import {buildArtifactCandidate as reportingCandidate} from '../runtime-reporting-v1/artifact-candidate.mjs';
import { runtimeDescriptor as reference } from '../runtime/builtin-preview-service.mjs';
import { descriptor as next } from '../../.generated/runtime-next-manifest.mjs';
import { validateRuntimeDescriptor, assertPinnedRuntime } from '../runtime/version-pin.mjs';
import { previewInput as referenceInput } from '../runtime/preview-snapshot.mjs';
import { previewInput as positionsInput } from '../runtime-next/snapshot.mjs';
import { buildArtifactCandidate as referenceCandidate } from '../runtime/artifact-candidate.mjs';
import { buildArtifactCandidate as positionsCandidate } from '../runtime-next/artifact-candidate.mjs';
import {outstreamSizingReview,outstreamContext} from '../../shared/outstream/settings-v3.mjs';
import { prepareSiteRuntimeSelection as prepare, readPinnedSiteRuntime as read, RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
import {requireSupportedCacheGenerator} from '../site-runtime/prebid-cache-settings.mjs';
import { takeOverForBuild } from './takeover-settings.mjs';
import { assertSizeMapCompatibility } from '../site-runtime/size-map-compatibility.mjs';
export const runtimeCatalog=[validateRuntimeDescriptor(next),reference,validateRuntimeDescriptor(reporting),validateRuntimeDescriptor(readiness),validateRuntimeDescriptor(revenue),validateRuntimeDescriptor(revenueV2),validateRuntimeDescriptor(revenueV3),validateRuntimeDescriptor(stable316),validateRuntimeDescriptor(patch3161),validateRuntimeDescriptor(patch3162),validateRuntimeDescriptor(conditional317),validateRuntimeDescriptor(geo318),validateRuntimeDescriptor(geo319),validateRuntimeDescriptor(codes3191),validateRuntimeDescriptor(maps320),validateRuntimeDescriptor(combined3201),validateRuntimeDescriptor(contextual321),validateRuntimeDescriptor(rules322)];
export const runtimeDescriptor=runtimeCatalog[0];
export function descriptorForPin(pin){
  const descriptor=runtimeCatalog.find(r=>r.id===pin?.runtimeId&&r.version===pin?.runtimeVersion);
  assertPinnedRuntime(pin,descriptor,{configSchemaVersion:1,capabilities:['config-preview']});
  return descriptor;
}
export function previewInput(snapshot,descriptor,time,takeOver){
  const config=JSON.parse(snapshot.config.config_json);
  if (!descriptor.capabilities.includes('gam-code-compatibility')) {
    const extended = (snapshot.units ?? []).filter(u => u.enabled === 1 && u.type !== 'DRAFT').map(u => u.code).find(code => !/^[A-Za-z][A-Za-z0-9_:-]*$/.test(code) || ['__proto__','constructor','prototype','toString','hasOwnProperty','valueOf'].includes(code));
    if (extended) throw Error(`Ad unit ${extended} uses a GAM code supported by script 3.19.1 or 3.20.1. Select 3.20.1 in Script setup and save; the exact code and existing packages are kept.`);
  }
  assertSizeMapCompatibility(snapshot,descriptor);
  requireRevenueRuntime(config,descriptor);
  requireContextualRuntime(config,descriptor);
  requireBidderRulesRuntime(config,descriptor);
  requireCountryRules(snapshot,descriptor);
  if(!descriptor.capabilities.includes('conditional-size-maps')){
    const rules=new Map((snapshot.rules??[]).map(row=>[row.rule_key,JSON.parse(row.rule_json)?.conditionalMappings]));
    for(const [key,rule] of Object.entries(config.advancedUnitRules??{})){
      if(rule&&Object.hasOwn(rule,'conditionalMappings'))rules.set(key,rule.conditionalMappings);
    }
    if([...rules.values()].some(mappings=>mappings?.length))throw Error('Saved key-value mappings require script 3.17.0. Select 3.17.0 in Script setup and save to generate with these rules. Your saved settings are kept.');
  }
  if(descriptor.id===rules322.id||descriptor.id===contextual321.id||descriptor.id===combined3201.id||descriptor.id===maps320.id||descriptor.id===codes3191.id||descriptor.id===geo319.id||descriptor.id===geo318.id||descriptor.id===conditional317.id||descriptor.id===patch3162.id||descriptor.id===patch3161.id||descriptor.id===stable316.id||descriptor.id===revenueV3.id||descriptor.id===revenueV2.id||descriptor.id===revenue.id||descriptor.id===next.id||descriptor.id===reporting.id||descriptor.id===readiness.id){
    const codes=Object.keys(config.runtimeControls?.adPositions??{});
    if(codes.some(code=>snapshot.units.find(unit=>unit.code===code)?.enabled!==1))throw Error('Enable the TakeOver ad position, or explicitly change its display to Standard before disabling it.');
    const input=(descriptor.id===rules322.id?rules322Input:descriptor.id===contextual321.id?contextual321Input:descriptor.id===combined3201.id?combined3201Input:descriptor.id===maps320.id?maps320Input:descriptor.id===codes3191.id?codes3191Input:descriptor.id===geo319.id?geo319Input:descriptor.id===geo318.id?geo318Input:descriptor.id===conditional317.id?conditional317Input:descriptor.id===patch3162.id?patch3162Input:descriptor.id===patch3161.id?patch3161Input:descriptor.id===stable316.id?stable316Input:descriptor.id===revenueV3.id?revenueV3Input:descriptor.id===revenueV2.id?revenueV2Input:descriptor.id===revenue.id?revenueInput:positionsInput)(snapshot,descriptor,time,takeOver??takeOverForBuild(snapshot));
    if(input.overlay?.demand==='site'&&config.enablePrebid!==true)throw Error('This TakeOver uses Prebid + GAM. Enable Prebid or explicitly change its demand to GAM only.');
    if(input.overlay){
      const base=input.overlay.unit.sizeMapName,maps=input.core.sizeMapsRaw;
      if(Object.entries(maps).some(([name,rows])=>name.endsWith('_'+base)&&JSON.stringify(rows)!==JSON.stringify(maps[base])))throw Error('This script version does not support TakeOver maps by page type. Your maps are kept; this requires a future script version, or an explicit change to Standard display.');
    }
    return input;
  }
  if(Object.keys(config.runtimeControls?.adPositions??{}).length)throw Error('TakeOver ad units require version 3.10.0. Earlier packages remain available in Releases.');
  return referenceInput(snapshot,descriptor,time,takeOver??takeOverForBuild(snapshot));
}
export const prepareSiteRuntimeSelection=(args,bucket)=>prepare({...args,inputAdapter:previewInput},bucket);
export function readPinnedSiteRuntime(args,bucket){
  const config=JSON.parse(args.snapshot.config.config_json),pin=config.builtinRuntimeSelection?.runtime;
  if(config.enablePrebid===true&&((pin?.runtimeId==='tessera-3.22.0'&&pin.runtimeVersion==='3.22.0')||(pin?.runtimeId==='tessera-3.21.0'&&pin.runtimeVersion==='3.21.0')||(pin?.runtimeId==='tessera-3.20.1'&&pin.runtimeVersion==='3.20.1')||(pin?.runtimeId==='tessera-3.20.0'&&pin.runtimeVersion==='3.20.0')||(pin?.runtimeId==='tessera-3.19.1'&&pin.runtimeVersion==='3.19.1')||(pin?.runtimeId==='tessera-3.19.0'&&pin.runtimeVersion==='3.19.0')||(pin?.runtimeId==='tessera-3.18.0'&&pin.runtimeVersion==='3.18.0')||(pin?.runtimeId==='tessera-3.17.0'&&pin.runtimeVersion==='3.17.0')||(pin?.runtimeId==='tessera-3.16.2'&&pin.runtimeVersion==='3.16.2')||(pin?.runtimeId==='tessera-3.16.1'&&pin.runtimeVersion==='3.16.1')||(pin?.runtimeId==='tessera-revenue-preview-3'&&pin.runtimeVersion==='3.16.0-revenue.preview.3')||(pin?.runtimeId==='tessera-3.16.0'&&pin.runtimeVersion==='3.16.0'))){
    const pending=outstreamSizingReview(config.runtimeControls?.outstream,outstreamContext(args.snapshot));
    if(pending.length)throw new RuntimeSelectionError('outstream_sizes_review_required','Review Outstream sizes in Formats before Generate. '+pending.map(issue=>issue.message).join(' '));
  }
  return read({...args,inputAdapter:previewInput},bucket);
}
export async function buildArtifactCandidate(args){
  requireSupportedCacheGenerator(JSON.parse(args.snapshot.config.config_json));
  const descriptor=descriptorForPin(args.pin);
  previewInput(args.snapshot,descriptor,args.buildTimestamp,args.takeOver);
  return descriptor.id===rules322.id?rules322Candidate(args):descriptor.id===contextual321.id?contextual321Candidate(args):descriptor.id===combined3201.id?combined3201Candidate(args):descriptor.id===maps320.id?maps320Candidate(args):descriptor.id===codes3191.id?codes3191Candidate(args):descriptor.id===geo319.id?geo319Candidate(args):descriptor.id===geo318.id?geo318Candidate(args):descriptor.id===conditional317.id?conditional317Candidate(args):descriptor.id===patch3162.id?patch3162Candidate(args):descriptor.id===patch3161.id?patch3161Candidate(args):descriptor.id===stable316.id?stable316Candidate(args):descriptor.id===revenueV3.id?revenueV3Candidate(args):descriptor.id===revenueV2.id?revenueV2Candidate(args):descriptor.id===revenue.id?revenueCandidate(args):descriptor.id===readiness.id?readinessCandidate(args):descriptor.id===reporting.id?reportingCandidate(args):descriptor.id===next.id?positionsCandidate(args):referenceCandidate(args);
}
