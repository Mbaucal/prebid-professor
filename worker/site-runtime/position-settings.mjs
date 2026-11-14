/** Mutable editor contract. Frozen runtimes keep their original validation. */
import {normalizeOverlay} from '../runtime-next/position-settings.mjs';
import {validateAdUnitCode} from '../../shared/gam/ad-unit-code.mjs';
export {defaultOverlay, normalizeOverlay, normalizeLazy} from '../runtime-next/position-settings.mjs';
export function readPositions(config, units) {
  const saved = config.runtimeControls?.adPositions ?? {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw Error('Saved ad position settings need review.');
  const result = Object.create(null);
  for (const [code, value] of Object.entries(saved)) {
    if (validateAdUnitCode(code).length || code === 'Interstitial' || code.startsWith('adsx-') || code.startsWith('close_sticky') || !units.some(u => u.code === code)) throw Error('Ad position settings refer to a missing or reserved unit.');
    result[code] = normalizeOverlay(value);
  }
  if (Object.keys(result).length > 1) throw Error('Use one TakeOver position per site.');
  return result;
}
