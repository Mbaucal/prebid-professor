// TEST editor policy only; never part of a frozen runtime source closure.
import { RuntimeSelectionError } from '../runtime/site-runtime-selection.mjs';
export const CACHE_RUNTIME_ID='tessera-cache-preview-1';
export const usesBidCache=pin=>[CACHE_RUNTIME_ID,'variant-labels-preview-1','variant-labels-en-preview-1'].includes(pin?.runtimeId);
export function normalizeBidCache(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!=='maxAgeSeconds|mode'
    ||!['fresh-only','auction-with-cache'].includes(value.mode)||!Number.isInteger(value.maxAgeSeconds)||value.maxAgeSeconds<1||value.maxAgeSeconds>300)
    throw new RuntimeSelectionError('invalid_cache_settings','Choose an explicit auction mode and a whole-number maximum bid age from 1 to 300 seconds.');
  return {mode:value.mode,maxAgeSeconds:value.maxAgeSeconds};
}
export function readCacheSettings(snapshot){
  try{return normalizeBidCache(JSON.parse(snapshot.config.config_json).runtimeControls?.bidCache);}catch{return null;}
}
export function validateCacheSelection(selection){
  if(usesBidCache(selection?.runtime))normalizeBidCache(selection.bidCache);
  else if(Object.hasOwn(selection??{},'bidCache'))throw new RuntimeSelectionError('unsupported_cache_settings','Bid-cache settings require the explicit cache-capable TEST version.');
}
