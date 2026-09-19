import { previewInput as positionsInput } from '../runtime-next/snapshot.mjs';
export const PREBID_SHA256='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b';
export function previewInput(snapshot,descriptor,timestamp,takeOver={enabled:false}) {
  const saved=JSON.parse(snapshot.config.config_json),policy=saved.runtimeControls?.bidCache;
  if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.keys(policy).some(k=>!['mode','maxAgeSeconds'].includes(k))
    ||!['fresh-only','auction-with-cache'].includes(policy.mode)||!Number.isInteger(policy.maxAgeSeconds)||policy.maxAgeSeconds<1||policy.maxAgeSeconds>300)throw Error('Choose an explicit supported bid-cache mode and maximum age (1–300 seconds).');
  const input=positionsInput(snapshot,descriptor,timestamp,takeOver);
  if(!input.options.enablePrebid||!input.core.bidders.length)throw Error('The cache candidate requires an enabled Prebid setup.');
  if(input.core.explicitUnits.length>100)throw Error('The cache candidate supports at most 100 owned positions.');
  if(input.options.takeOver.enabled&&!input.overlay)throw Error('Move legacy TakeOver into Ad positions before using the cache candidate.');
  if(Object.values(input.core.sizeMapsRaw).some(rows=>rows.some(r=>r.sizes.some(s=>!Array.isArray(s)||s.some(v=>v<2)))))throw Error('The cache candidate supports concrete banner sizes only.');
  return {...input,bidCache:{mode:policy.mode,maxAgeSeconds:policy.maxAgeSeconds}};
}
