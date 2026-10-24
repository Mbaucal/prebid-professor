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
import {requireRevenueRuntime} from '../runtime-3161/settings-guard.mjs';
import {descriptor as readiness} from '../../.generated/runtime-readiness-manifest.mjs';
import {buildArtifactCandidate as readinessCandidate} from '../runtime-readiness-v1/artifact-candidate.mjs';
import {descriptor as demand} from '../../.generated/runtime-demand-manifest.mjs';
import {buildArtifactCandidate as demandCandidate} from '../runtime-demand-v1/artifact-candidate.mjs';
import {previewInput as demandInput} from '../runtime-demand-v1/snapshot.mjs';
/** All listed engines are bundled; selection never upgrades implicitly. */
import {descriptor as reporting} from '../../.generated/runtime-reporting-manifest.mjs';
import {buildArtifactCandidate as reportingCandidate} from '../runtime-reporting-v1/artifact-candidate.mjs';
import { runtimeDescriptor as reference } from '../runtime/builtin-preview-service.mjs';
import {descriptor as creative} from '../../.generated/runtime-creative-manifest.mjs';
import {buildArtifactCandidate as creativeCandidate} from '../runtime-creative-v1/artifact-candidate.mjs';
import { descriptor as next } from '../../.generated/runtime-next-manifest.mjs';
import { validateRuntimeDescriptor, assertPinnedRuntime } from '../runtime/version-pin.mjs';
import { previewInput as referenceInput } from '../runtime/preview-snapshot.mjs';
import { previewInput as positionsInput } from '../runtime-next/snapshot.mjs';
import { buildArtifactCandidate as referenceCandidate } from '../runtime/artifact-candidate.mjs';
import { buildArtifactCandidate as positionsCandidate } from '../runtime-next/artifact-candidate.mjs';
import {outstreamSizingReview,outstreamContext} from '../../shared/outstream/settings-v3.mjs';
import { prepareSiteRuntimeSelection as prepare, readPinnedSiteRuntime as read, RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
import { takeOverForBuild } from './takeover-settings.mjs';
import {requireSupportedCacheGenerator} from '../site-runtime/prebid-cache-settings.mjs';
export const runtimeCatalog=[validateRuntimeDescriptor(next),reference,validateRuntimeDescriptor(creative),validateRuntimeDescriptor(reporting),validateRuntimeDescriptor(demand),validateRuntimeDescriptor(readiness),validateRuntimeDescriptor(revenue),validateRuntimeDescriptor(revenueV2),validateRuntimeDescriptor(revenueV3),validateRuntimeDescriptor(stable316),validateRuntimeDescriptor(patch3161)];
export const runtimeDescriptor=runtimeCatalog[0];
export function descriptorForPin(pin){
  const descriptor=runtimeCatalog.find(r=>r.id===pin?.runtimeId&&r.version===pin?.runtimeVersion);
  assertPinnedRuntime(pin,descriptor,{configSchemaVersion:1,capabilities:['config-preview']});
  return descriptor;
}
export function previewInput(snapshot,descriptor,time,takeOver){
  const config=JSON.parse(snapshot.config.config_json);
  requireRevenueRuntime(config,descriptor);
  if(descriptor.id===patch3161.id||descriptor.id===stable316.id||descriptor.id===revenueV3.id||descriptor.id===revenueV2.id||descriptor.id===revenue.id||descriptor.id===next.id||descriptor.id===creative.id||descriptor.id===reporting.id||descriptor.id===demand.id||descriptor.id===readiness.id){
    const codes=Object.keys(config.runtimeControls?.adPositions??{});
    if(codes.some(code=>snapshot.units.find(unit=>unit.code===code)?.enabled!==1))throw Error('Enable the TakeOver ad position, or explicitly change its display to Standard before disabling it.');
    const input=(descriptor.id===patch3161.id?patch3161Input:descriptor.id===stable316.id?stable316Input:descriptor.id===revenueV3.id?revenueV3Input:descriptor.id===revenueV2.id?revenueV2Input:descriptor.id===revenue.id?revenueInput:descriptor.id===demand.id?demandInput:positionsInput)(snapshot,descriptor,time,takeOver??takeOverForBuild(snapshot));
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
  if(config.enablePrebid===true&&((pin?.runtimeId==='tessera-3.16.1'&&pin.runtimeVersion==='3.16.1')||(pin?.runtimeId==='tessera-revenue-preview-3'&&pin.runtimeVersion==='3.16.0-revenue.preview.3')||(pin?.runtimeId==='tessera-3.16.0'&&pin.runtimeVersion==='3.16.0'))){
    const pending=outstreamSizingReview(config.runtimeControls?.outstream,outstreamContext(args.snapshot));
    if(pending.length)throw new RuntimeSelectionError('outstream_sizes_review_required','Review Outstream sizes in Formats before Generate. '+pending.map(issue=>issue.message).join(' '));
  }
  return read({...args,inputAdapter:previewInput},bucket);
}
export async function buildArtifactCandidate(args){
  const descriptor=descriptorForPin(args.pin);
  if(descriptor.id===stable316.id||descriptor.id===patch3161.id)requireSupportedCacheGenerator(JSON.parse(args.snapshot.config.config_json));
  previewInput(args.snapshot,descriptor,args.buildTimestamp,args.takeOver);
  return descriptor.id===patch3161.id?patch3161Candidate(args):descriptor.id===stable316.id?stable316Candidate(args):descriptor.id===revenueV3.id?revenueV3Candidate(args):descriptor.id===revenueV2.id?revenueV2Candidate(args):descriptor.id===revenue.id?revenueCandidate(args):descriptor.id===readiness.id?readinessCandidate(args):descriptor.id===demand.id?demandCandidate(args):descriptor.id===reporting.id?reportingCandidate(args):descriptor.id===creative.id?creativeCandidate(args):descriptor.id===next.id?positionsCandidate(args):referenceCandidate(args);
}
