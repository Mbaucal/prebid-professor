/** Private TEST adapter only. Main application keeps the existing catalog. */
import { runtimeDescriptor as measured, buildArtifactCandidate as measuredCandidate } from '../runtime-measured/artifact-candidate.mjs';
import { runtimeDescriptor as variant, buildArtifactCandidate as variantCandidate } from '../runtime-variant/artifact-candidate.mjs';
import { runtimeDescriptor as cached, buildArtifactCandidate as cachedCandidate } from '../runtime-cache/artifact-candidate.mjs';
import { previewInput as cachedInput, PREBID_SHA256 } from '../runtime-cache/snapshot.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
import { normalizeBidCache, usesBidCache } from './cache-settings.mjs';
export { readCacheSettings, validateCacheSelection } from './cache-settings.mjs';
import { runtimeDescriptor as observed, buildArtifactCandidate as observedCandidate } from '../runtime-observed/artifact-candidate.mjs';
import { runtimeDescriptor as reference } from '../runtime/builtin-preview-service.mjs';
import { descriptor as next } from '../../.generated/runtime-next-manifest.mjs';
import { validateRuntimeDescriptor, assertPinnedRuntime } from '../runtime/version-pin.mjs';
import { previewInput as referenceInput } from '../runtime/preview-snapshot.mjs';
import { previewInput as positionsInput } from '../runtime-next/snapshot.mjs';
import { buildArtifactCandidate as referenceCandidate } from '../runtime/artifact-candidate.mjs';
import { buildArtifactCandidate as positionsCandidate } from '../runtime-next/artifact-candidate.mjs';
import { prepareSiteRuntimeSelection as prepare, readPinnedSiteRuntime as read } from '../runtime/site-runtime-selection.mjs';
import { takeOverForBuild } from './takeover-settings.mjs';
export const runtimeCatalog=[validateRuntimeDescriptor(next),reference,observed,measured,cached,variant];
export const runtimeDescriptor=runtimeCatalog[0];
export function descriptorForPin(pin){
  const descriptor=runtimeCatalog.find(r=>r.id===pin?.runtimeId&&r.version===pin?.runtimeVersion);
  assertPinnedRuntime(pin,descriptor,{configSchemaVersion:1,capabilities:['config-preview']});
  return descriptor;
}
export function previewInput(snapshot,descriptor,time,takeOver){
  const config=JSON.parse(snapshot.config.config_json);
  if(descriptor.id===next.id||descriptor.id===observed.id||descriptor.id===measured.id||descriptor.id===cached.id||descriptor.id===variant.id){
    const codes=Object.keys(config.runtimeControls?.adPositions??{});
    if(codes.some(code=>snapshot.units.find(unit=>unit.code===code)?.enabled!==1))throw Error('Enable the TakeOver ad position, or explicitly change its display to Standard before disabling it.');
    const input=((descriptor.id===cached.id||descriptor.id===variant.id)?cachedInput:positionsInput)(snapshot,descriptor,time,takeOver??takeOverForBuild(snapshot));
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
function exactCachePrebid(pin,prebid){
  if(usesBidCache(pin)&&prebid?.sha256!==PREBID_SHA256)throw new RuntimeSelectionError('cache_prebid_mismatch','This cache version requires the exact reviewed Prebid 11.34.0 file. Keep the current script version or explicitly choose that file in Prebid and bidders.');
}
export async function prepareSiteRuntimeSelection(args,bucket){
  const copy=structuredClone(args),original=copy.snapshot,selection=copy.selection,reviewedRevision=copy.expectedRevision;
  if(Object.hasOwn(selection??{},'bidCache')){
    if(!usesBidCache(selection.runtime))throw new RuntimeSelectionError('unsupported_cache_settings','Bid-cache settings require the explicit cache-capable TEST version.');
    const policy=normalizeBidCache(selection.bidCache);delete selection.bidCache;
    if(copy.expectedRevision!==await digest(original))throw new RuntimeSelectionError('configuration_changed','Site settings changed. Reload before saving.',409);
    const config=JSON.parse(original.config.config_json);config.runtimeControls??={};config.runtimeControls.bidCache=policy;
    copy.snapshot={...original,config:{...original.config,config_json:JSON.stringify(config)}};
    copy.expectedRevision=await digest(copy.snapshot);
  }
  const plan=await prepare({...copy,inputAdapter:previewInput},bucket);
  exactCachePrebid(plan.selection.runtime,plan.selection.prebid);
  return {...plan,basedOnRevision:reviewedRevision,changed:await digest(JSON.parse(original.config.config_json))!==await digest(JSON.parse(plan.configJson))};
}
export async function readPinnedSiteRuntime(args,bucket){
  const resolved=await read({...args,inputAdapter:previewInput},bucket);
  exactCachePrebid(resolved.pin,resolved.prebid?.report?.build);return resolved;
}
export async function buildArtifactCandidate(args){
  const descriptor=descriptorForPin(args.pin);
  previewInput(args.snapshot,descriptor,args.buildTimestamp,args.takeOver);
  return descriptor.id===variant.id?variantCandidate(args):descriptor.id===cached.id?cachedCandidate(args):descriptor.id===measured.id?measuredCandidate(args):descriptor.id===observed.id?observedCandidate(args):descriptor.id===next.id?positionsCandidate(args):referenceCandidate(args);
}
