import {normalizeOutstream as normalizeV1, outstreamContext as contextV1} from './settings.mjs';
export {hasEnabledOutstream} from './settings.mjs';

/** Position-scoped validation for revenue preview.2. Frozen preview.1 stays intact. */
export function outstreamContext(snapshot) {
  const context=contextV1(snapshot), runtime=JSON.parse(snapshot.config.config_json).runtimeControls??{};
  const blockedReasons=Object.create(null);
  for(const code of Object.keys(runtime.adPositions??{}))blockedReasons[code]='TakeOver';
  const bottom=Object.hasOwn(runtime.sticky??{},'bottomAdUnitId')?runtime.sticky.bottomAdUnitId
    :snapshot.units.some(u=>u.code==='Sticky'&&u.enabled===1)?'Sticky':null;
  if(bottom)blockedReasons[bottom]='bottom Sticky';
  if(runtime.sticky?.topAdUnitId)blockedReasons[runtime.sticky.topAdUnitId]='top Sticky';
  if(runtime.takeOver?.enabled){
    blockedReasons[runtime.takeOver.adUnitCode??'TakeOver']='legacy TakeOver';
  }
  if(runtime.takeOver?.enabled||Object.keys(runtime.adPositions??{}).some(code=>snapshot.units.some(u=>u.code===code&&u.enabled===1)))
    blockedReasons.Interstitial='TakeOver Interstitial fallback';
  return {...context,blockedCodes:Object.keys(blockedReasons),blockedReasons};
}
export function normalizeOutstream(value,context) {
  for(const [code,raw] of Object.entries(value?.units??{})) {
    if(raw?.format!=='banner'&&context.blockedReasons?.[code])
      throw Object.assign(Error(`${code}: this position is configured as ${context.blockedReasons[code]}. The Outstream pilot requires Standard display. Review this position in Ad positions.`),{status:422});
  }
  return normalizeV1(value,context);
}
export function buildOutstreamInput(snapshot) {
  const config=JSON.parse(snapshot.config.config_json);
  if(config.enablePrebid!==true)return {units:{},disabledRefreshCodes:[],cacheUrl:null};
  const normalized=normalizeOutstream(config.runtimeControls?.outstream,outstreamContext(snapshot));
  const units=normalized.units;
  return {units,disabledRefreshCodes:Object.keys(units),cacheUrl:Object.values(units)[0]?.cacheUrl??null};
}
