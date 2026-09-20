import {validatePackageSettings} from './package-settings-v1.mjs';

export const SCRIPT_ID=/^tanjug-script-1\.0\.0-[a-f0-9]{64}$/;
export const TEST_ID=/^tanjug-test-1\.0\.0-[a-f0-9]{64}$/;
export const DEFAULT_SCRIPT_SETTINGS=Object.freeze({mode:'fresh-only',refreshSeconds:null});
export function displayName(value) {
  if(typeof value!=='string'||!value.trim()||value.trim().length>80||/[\u0000-\u001f\u007f]/.test(value))throw Error('Enter a name of 1–80 characters.');
  return value.trim();
}
export function scriptSettings(value) {
  return validatePackageSettings({schemaVersion:1,trafficBPercent:50,arms:{A:value,B:value}}).arms.A;
}
