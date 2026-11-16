import {previewInput as previousInput} from '../runtime-3212/snapshot.mjs';
import {bidCacheEligibleCodes} from '../../shared/bid-cache/eligibility.mjs';

/* 3.23.0 input = the 3.21.2 input plus the saved bid cache choice, resolved per
 * position. This file owns its own reading of config.prebidBidCache, so the
 * frozen 3.23.0 closure never depends on admin validation code. */
const DEFAULT_BID_CACHE = Object.freeze({enabled: false, maxBidAgeSeconds: 60});
const MAX_OVERRIDES = 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const byCodeUnit = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);
const invalid = () => Error('Saved bid cache settings are invalid. Open Config → Demand → Prebid and save them again; Generate does not guess them.');

/** Saved settings as {enabled, maxBidAgeSeconds, overrides:[[code, boolean]]}, overrides in code-unit order. */
export function savedBidCache(config) {
  const value = record(config) && Object.hasOwn(config, 'prebidBidCache') ? config.prebidBidCache : DEFAULT_BID_CACHE;
  if (!record(value)) throw invalid();
  const keys = Object.keys(value).filter(key => key !== 'positionOverrides').sort();
  if (keys.join(',') !== 'enabled,maxBidAgeSeconds' || typeof value.enabled !== 'boolean'
    || !Number.isInteger(value.maxBidAgeSeconds) || value.maxBidAgeSeconds < 1 || value.maxBidAgeSeconds > 300) throw invalid();
  const raw = Object.hasOwn(value, 'positionOverrides') ? value.positionOverrides : {};
  if (!record(raw)) throw invalid();
  const overrides = Object.entries(raw);
  if (overrides.length > MAX_OVERRIDES || overrides.some(([code, enabled]) => code === '' || typeof enabled !== 'boolean')) throw invalid();
  return {enabled: value.enabled, maxBidAgeSeconds: value.maxBidAgeSeconds, overrides: overrides.sort(byCodeUnit)};
}

/**
 * bidCache is null when Prebid is off or nothing asks for reuse (site default off
 * and no position override on). Otherwise positions lists every eligible code
 * (shared/bid-cache/eligibility.mjs) with its resolved choice: its override, else
 * the site default. A code missing from positions always runs fresh-only.
 * bidCacheExclusions lists saved overrides that name no eligible position; the
 * compiler reports them as warnings and never applies them.
 */
export function bidCacheInput(snapshot, enablePrebid) {
  const config = JSON.parse(snapshot.config.config_json);
  const saved = savedBidCache(config);
  if (enablePrebid !== true) return {bidCache: null, bidCacheExclusions: []};
  const eligible = bidCacheEligibleCodes(snapshot.units, config), known = new Set(eligible);
  const overrides = new Map(saved.overrides.filter(([code]) => known.has(code)));
  const bidCacheExclusions = saved.overrides.filter(([code]) => !known.has(code)).map(([code, enabled]) => ({code, enabled}));
  if (!saved.enabled && !saved.overrides.some(([, enabled]) => enabled)) return {bidCache: null, bidCacheExclusions};
  // Own data properties only: a code such as __proto__ stays an ordinary key.
  const positions = Object.fromEntries(eligible.map(code => [code, overrides.has(code) ? overrides.get(code) : saved.enabled]));
  return {bidCache: {defaultEnabled: saved.enabled, maxAgeSeconds: saved.maxBidAgeSeconds, positions}, bidCacheExclusions};
}

export function previewInput(snapshot, descriptor, timestamp, takeOver = {enabled: false}, countryTarget = 'main') {
  const input = previousInput(snapshot, descriptor, timestamp, takeOver, countryTarget);
  // The same object stays registered for the 3.19.1+ GAM code compiler.
  Object.assign(input, bidCacheInput(snapshot, input.options.enablePrebid));
  return input;
}
