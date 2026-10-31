import {normalizeOutstream as normalizeV1,outstreamContext as contextV1} from './settings.mjs';
import {normalizeOutstream as normalizeV2,outstreamContext as contextV2} from './settings-v2.mjs';
import {normalizeOutstream as normalizeV3} from './settings-v3.mjs';
export {hasEnabledOutstream} from './settings.mjs';

/** Admin validation follows the saved generator; it never upgrades a site. */
export function outstreamContext(snapshot) {
  const pin=JSON.parse(snapshot.config.config_json).builtinRuntimeSelection?.runtime;
  const next=contextV2(snapshot);
  if((pin?.runtimeId==='tessera-3.16.2'&&pin.runtimeVersion==='3.16.2')||(pin?.runtimeId==='tessera-3.16.1'&&pin.runtimeVersion==='3.16.1')||(pin?.runtimeId==='tessera-3.16.0'&&pin.runtimeVersion==='3.16.0')||(pin?.runtimeId==='tessera-revenue-preview-3'&&pin.runtimeVersion==='3.16.0-revenue.preview.3'))return {...next,positionScoped:true,responsiveSizing:true};
  if(pin?.runtimeId==='tessera-revenue-preview-2'&&pin.runtimeVersion==='3.16.0-revenue.preview.2')return {...next,positionScoped:true};
  const previous=contextV1(snapshot);
  return {...previous,blockedReasons:next.blockedReasons,
    upgradeCodes:previous.blockedCodes.filter(code=>!next.blockedCodes.includes(code))};
}
export function normalizeOutstream(value,context,options) {
  if(context.responsiveSizing)return normalizeV3(value,context,options);
  if(Object.values(value?.units??{}).some(raw=>raw?.playerSizing==='size-map'))throw Object.assign(Error('Responsive video sizes require Script version 3.16.0. Choose Use current version in Script setup and save. Existing saved packages are unchanged.'),{status:422});
  if(context.positionScoped)return normalizeV2(value,context);
  if(Object.entries(value?.units??{}).some(([code,raw])=>raw?.format!=='banner'&&context.upgradeCodes?.includes(code)))
    throw Object.assign(Error('Choose Use current version in Script setup and save Script version 3.16.0 to use Outstream on a Standard position with these site display settings. The saved script version has a broader Sticky/TakeOver restriction.'),{status:422});
  // Report the actual display, while preserving the older generator's acceptance rules.
  normalizeV2(value,context);
  return normalizeV1(value,context);
}
