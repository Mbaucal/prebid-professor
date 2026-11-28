/** Which ad positions may reuse earlier Prebid bids, and which runtimes can do it.
 *
 * Shared by the admin/API (saving per-position bid cache settings) and by the
 * built-in runtime 3.23.0 (applying them at Generate). It has no imports and
 * no clock, locale or random input, because it is part of the 3.23.0 engine
 * closure (codeSha256). Once 3.23.0 is registered, this file is frozen: a rule
 * change needs a new versioned file and a new runtime version.
 *
 * Eligible means: a regular banner position that is included in generated
 * output now. TakeOver (and its Interstitial fallback), Outstream and every
 * non-banner position always run fresh auctions only; they are never dropped.
 * Malformed saved containers return no codes, so every position stays
 * fresh-only and nothing is cached by mistake.
 */
export const BID_CACHE_CAPABILITY = 'bid-cache';
export const BID_CACHE_RUNTIME_VERSION = '3.23.0';

const INTERSTITIAL = 'Interstitial';
const LEGACY_TAKEOVER = 'TakeOver';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const included = type => type === 'ATF' || type === 'BTF';
const usableCode = code => typeof code === 'string' && code !== '';
/** Code-unit order, so the result never depends on the host locale. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = codes => [...new Set(codes)].sort(byCodeUnit);

/** True only for a runtime descriptor whose capabilities list 'bid-cache'.
 * Pass the catalog descriptor (runtimeCatalog / descriptorForPin), not a saved pin. */
export function runtimeSupportsBidCache(descriptor) {
  const capabilities = record(descriptor) ? descriptor.capabilities : undefined;
  return Array.isArray(capabilities) && capabilities.includes(BID_CACHE_CAPABILITY);
}

/** TakeOver codes as takeOverForBuild resolves them: a TakeOver ad position
 * replaces the legacy TakeOver control. Returns null when it cannot tell. */
function savedTakeOverCodes(controls) {
  const positions = controls.adPositions ?? {};
  const legacy = Object.hasOwn(controls, 'takeOver') ? controls.takeOver : {enabled: false};
  if (!record(positions) || !record(legacy)) return null;
  const codes = Object.keys(positions);
  if (codes.length) return [...codes, INTERSTITIAL];
  return legacy.enabled ? [typeof legacy.adUnitCode === 'string' ? legacy.adUnitCode : LEGACY_TAKEOVER, INTERSTITIAL] : [];
}

/** Saved Outstream positions: every format other than plain 'banner'
 * ('outstream' and 'banner-outstream'). Returns null when it cannot tell. */
function savedOutstreamCodes(controls) {
  const outstream = controls.outstream ?? {}, units = record(outstream) ? outstream.units ?? {} : null;
  if (!record(units)) return null;
  return Object.entries(units).filter(([, value]) => !record(value) || value.format !== 'banner').map(([code]) => code);
}

/** Saved site shape, used by the admin/API and by the 3.23.0 snapshot step.
 * units: ad_units rows as D1 returns them ({code, type, media_type, enabled}, enabled 0 or 1).
 * config: the parsed publisher_configs.config_json object.
 * The result does not depend on enablePrebid, so settings stay editable while Prebid is off. */
export function bidCacheEligibleCodes(units, config) {
  if (!Array.isArray(units) || !record(config)) return [];
  const controls = config.runtimeControls ?? {};
  if (!record(controls)) return [];
  const takeOver = savedTakeOverCodes(controls), outstream = savedOutstreamCodes(controls);
  if (!takeOver || !outstream) return [];
  const excluded = new Set([...takeOver, ...outstream]);
  return sortedUnique(units.filter(unit => record(unit) && usableCode(unit.code) && unit.enabled === 1
    && included(unit.type) && unit.media_type === 'banner' && !excluded.has(unit.code)).map(unit => unit.code));
}

/** Compiled shape: the object the 3.21.2 previewInput returns (and so 3.23.0's
 * compiler receives), with the codes it carries. A GAM-only input (enablePrebid
 * not true) returns no codes. For a Prebid-on snapshot that previewInput
 * accepts, this equals bidCacheEligibleCodes(snapshot.units, config). */
export function bidCacheEligibleInputCodes(input) {
  if (!record(input) || !record(input.core) || !Array.isArray(input.core.explicitUnits) || !record(input.options)) return [];
  if (input.options.enablePrebid !== true) return [];
  const outstream = input.outstream;
  if (!record(outstream) || !record(outstream.units) || !Array.isArray(outstream.disabledRefreshCodes)) return [];
  const excluded = new Set([...outstream.disabledRefreshCodes, ...Object.keys(outstream.units)]);
  if (input.overlay !== null && input.overlay !== undefined) {
    if (!record(input.overlay) || !usableCode(input.overlay.code)) return [];
    excluded.add(input.overlay.code).add(INTERSTITIAL);
  }
  const takeOver = input.options.takeOver;
  if (takeOver !== undefined && !record(takeOver)) return [];
  if (takeOver?.enabled) excluded.add(typeof takeOver.adUnitCode === 'string' ? takeOver.adUnitCode : LEGACY_TAKEOVER).add(INTERSTITIAL);
  return sortedUnique(input.core.explicitUnits.filter(unit => record(unit) && usableCode(unit.id) && included(unit.type)
    && Array.isArray(unit.formats) && unit.formats.length === 1 && unit.formats[0] === 'banner'
    && unit.video == null && unit.native == null && !excluded.has(unit.id)).map(unit => unit.id));
}
