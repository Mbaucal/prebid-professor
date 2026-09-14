/** Saved TEST controls for the existing built-in TakeOver implementation. */
import { WorkspaceError } from './boundary.mjs';
export const defaultTakeOver=()=>({enabled:false,adUnitCode:'TakeOver',desktopMinWidth:1024,desktopSize:[800,600],mobileSize:[300,250],autoCloseDesktopSec:10,autoCloseMobileSec:5,showCountdown:true});
const fail=message=>{throw new WorkspaceError(422,message);};
export function normalizeTakeOver(value){
  const keys=Object.keys(defaultTakeOver());
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))fail('Review the TakeOver settings.');
  if(typeof value.enabled!=='boolean'||typeof value.showCountdown!=='boolean')fail('Choose ON or OFF for TakeOver and its countdown.');
  if(typeof value.adUnitCode!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.adUnitCode)||['__proto__','prototype','constructor'].includes(value.adUnitCode.toLowerCase()))fail('Use a valid TakeOver GAM ad unit code.');
  if(!Number.isInteger(value.desktopMinWidth)||value.desktopMinWidth<320||value.desktopMinWidth>5000)fail('TakeOver desktop width must be between 320 and 5000px.');
  for(const key of ['desktopSize','mobileSize'])if(!Array.isArray(value[key])||value[key].length!==2||!value[key].every(n=>Number.isInteger(n)&&n>=1&&n<=5000))fail('TakeOver sizes must have a width and height between 1 and 5000px.');
  for(const key of ['autoCloseDesktopSec','autoCloseMobileSec'])if(!Number.isInteger(value[key])||value[key]<0||value[key]>300)fail('TakeOver auto-close must be 0–300 seconds. Use 0 for manual close only.');
  return structuredClone(value);
}
export function savedTakeOver(config){
  if(!Object.hasOwn(config.runtimeControls??{},'takeOver'))return defaultTakeOver();
  try{return normalizeTakeOver(config.runtimeControls.takeOver);}
  catch{throw new WorkspaceError(409,'Saved TakeOver settings need review. They have not been changed.');}
}
export function takeOverForBuild(snapshot,legacyEnabled){
  const config=JSON.parse(snapshot.config.config_json),saved=savedTakeOver(config);
  const configured=Object.hasOwn(config.runtimeControls??{},'takeOver');
  // Keep already reviewed legacy packages reproducible until a saved setting changes.
  if(configured&&legacyEnabled!==undefined&&legacyEnabled!==saved.enabled)throw new WorkspaceError(409,'TakeOver is now controlled by saved site settings. Reload Generate before continuing.');
  const options=configured?saved:{enabled:legacyEnabled??false};
  if(options.enabled&&(snapshot.units??[]).some(u=>u.enabled===1&&[saved.adUnitCode,'Interstitial'].includes(u.code)))throw new WorkspaceError(409,'TakeOver and its Interstitial fallback must be separate from regular ad positions. Review site settings.');
  return {...options,codelessAdUnitPath:snapshot.site.gam_path+'Interstitial'};
}
