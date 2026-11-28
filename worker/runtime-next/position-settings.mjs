/** Data contract shared by the editor and the versioned compiler. */
const blocked = new Set(['__proto__', 'constructor', 'prototype']);
export function defaultOverlay() {
  return { demand: 'gam', desktopMinWidth: 1024, desktopSeconds: 10, mobileSeconds: 5, countdown: true, frequencyMinutes: 0 };
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(`${label} must be a whole number between ${min} and ${max}.`);
  return value;
}
export function normalizeOverlay(value) {
  const keys = Object.keys(defaultOverlay());
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) throw Error('TakeOver needs demand, closing and frequency settings.');
  if (!['gam', 'site'].includes(value.demand) || typeof value.countdown !== 'boolean') throw Error('Choose GAM only or the site Prebid bidders for TakeOver.');
  return { demand:value.demand, desktopMinWidth:integer(value.desktopMinWidth,320,5000,'Desktop width'),
    desktopSeconds:integer(value.desktopSeconds,0,300,'Desktop closing time'), mobileSeconds:integer(value.mobileSeconds,0,300,'Mobile closing time'),
    countdown:value.countdown, frequencyMinutes:integer(value.frequencyMinutes,0,10080,'TakeOver interval') };
}
export function normalizeLazy(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['enabled','fetchMarginPx','renderMarginPx'].includes(k))) throw Error('Unsupported lazy-load rule.');
  if (typeof value.enabled !== 'boolean') throw Error('Lazy loading needs an enabled choice.');
  return {enabled:value.enabled, fetchMarginPx:integer(value.fetchMarginPx??500,0,20000,'Fetch margin'), renderMarginPx:integer(value.renderMarginPx??200,0,20000,'Render margin')};
}
export function readPositions(config, units) {
  const saved = config.runtimeControls?.adPositions ?? {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('Saved ad position settings need review.');
  const result = {};
  for (const [code, value] of Object.entries(saved)) {
    if (blocked.has(code)||code==='Interstitial'||code.startsWith('adsx-')||code.startsWith('close_sticky') || !units.some(u=>u.code===code)) throw Error('Ad position settings refer to a missing or reserved unit.');
    result[code] = normalizeOverlay(value);
  }
  if (Object.keys(result).length > 1) throw Error('Use one TakeOver position per site.');
  return result;
}
