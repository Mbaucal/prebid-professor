/** Both engines are actually bundled; selection never upgrades implicitly. */
import { runtimeDescriptor as reference } from '../runtime/builtin-preview-service.mjs';
import { descriptor as next } from '../../.generated/runtime-next-manifest.mjs';
import { validateRuntimeDescriptor, assertPinnedRuntime } from '../runtime/version-pin.mjs';
import { previewInput as referenceInput } from '../runtime/preview-snapshot.mjs';
import { previewInput as positionsInput } from '../runtime-next/snapshot.mjs';
import { buildArtifactCandidate as referenceCandidate } from '../runtime/artifact-candidate.mjs';
import { buildArtifactCandidate as positionsCandidate } from '../runtime-next/artifact-candidate.mjs';
import { prepareSiteRuntimeSelection as prepare, readPinnedSiteRuntime as read } from '../runtime/site-runtime-selection.mjs';
import { takeOverForBuild } from './takeover-settings.mjs';
export const runtimeCatalog=[validateRuntimeDescriptor(next),reference];
export const runtimeDescriptor=runtimeCatalog[0];
export function descriptorForPin(pin){
  const descriptor=runtimeCatalog.find(r=>r.id===pin?.runtimeId&&r.version===pin?.runtimeVersion);
  assertPinnedRuntime(pin,descriptor,{configSchemaVersion:1,capabilities:['config-preview']});
  return descriptor;
}
export function previewInput(snapshot,descriptor,time,takeOver){
  const config=JSON.parse(snapshot.config.config_json);
  if(descriptor.id===next.id){
    const codes=Object.keys(config.runtimeControls?.adPositions??{});
    if(codes.some(code=>snapshot.units.find(unit=>unit.code===code)?.enabled!==1))throw Error('Enable the TakeOver ad position, or explicitly change its display to Standard before disabling it.');
    const input=positionsInput(snapshot,descriptor,time,takeOver??takeOverForBuild(snapshot));
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
export const readPinnedSiteRuntime=(args,bucket)=>read({...args,inputAdapter:previewInput},bucket);
export async function buildArtifactCandidate(args){
  const descriptor=descriptorForPin(args.pin);
  previewInput(args.snapshot,descriptor,args.buildTimestamp,args.takeOver);
  return descriptor.id===next.id?positionsCandidate(args):referenceCandidate(args);
}
