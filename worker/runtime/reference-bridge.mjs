/** Pure bridge from Tessera's normalized compiler input to the approved 3.9.1 builder.
 * Dependencies must be statically imported by the trusted build/Worker, never supplied by HTTP.
 * This module performs no storage writes, fetches, or deployment. It is not a release route.
 */
const BLOCKED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ENGINE = 'legacy-advanced-refresh-v1';
const DISABLED_STICKY_SEED = '__TESSERA_DISABLED_STICKY__';
const CORE_KEYS = new Set([
  'engine', 'buildVersion', 'siteId', 'generatorProfileId', 'gamPath', 'bidders',
  'bidderSlotParams', 'bidderDeviceParams', 'bidderAdUnitParams', 'adUnitRules',
  'explicitUnits', 'sizeMapsRaw', 'prebidSizeConfigsRaw', 'userSync', 'defaultTimeout',
  'atfTimeout', 'btfTimeout', 'stickyTimeout', 'globalRefresh', 'maxCmpTimeout',
]);
const TAKEOVER_KEYS = {
  enabled: 'TAKEOVER_ENABLED', adUnitCode: 'TAKEOVER_AD_UNIT_CODE',
  desktopMinWidth: 'TAKEOVER_DESKTOP_MIN_WIDTH', desktopSize: 'TAKEOVER_DESKTOP_SIZE',
  mobileSize: 'TAKEOVER_MOBILE_SIZE', autoCloseDesktopSec: 'TAKEOVER_AUTO_CLOSE_DESKTOP_SEC',
  autoCloseMobileSec: 'TAKEOVER_AUTO_CLOSE_MOBILE_SEC', showCountdown: 'TAKEOVER_SHOW_COUNTDOWN',
  closeLabel: 'TAKEOVER_CLOSE_LABEL', adLabel: 'TAKEOVER_AD_LABEL',
  requestTimeoutMs: 'TAKEOVER_REQUEST_TIMEOUT_MS', renderFallbackMs: 'TAKEOVER_RENDER_FALLBACK_MS',
  overlayOpacity: 'TAKEOVER_OVERLAY_OPACITY', overlayPaddingPx: 'TAKEOVER_OVERLAY_PADDING_PX',
  allowEscapeClose: 'TAKEOVER_ALLOW_ESCAPE_CLOSE', closeOnBackdrop: 'TAKEOVER_CLOSE_ON_BACKDROP',
  pauseTimerWhenHidden: 'TAKEOVER_PAUSE_TIMER_WHEN_HIDDEN', strictSize: 'TAKEOVER_STRICT_SIZE',
  blockCodeless: 'TAKEOVER_BLOCK_CODELESS', releaseCodelessOnNoFill: 'TAKEOVER_RELEASE_CODELESS_ON_NO_FILL',
  codelessAdUnitPath: 'TAKEOVER_CODELESS_AD_UNIT_PATH',
};

function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}
function cloneJson(value, path = 'input', depth = 0) {
  if (depth > 32) throw new Error(`${path} is too deeply nested.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, i) => cloneJson(item, `${path}[${i}]`, depth + 1));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (BLOCKED_KEYS.has(key)) throw new Error(`${path}.${key} is not allowed.`);
      out[key] = cloneJson(item, `${path}.${key}`, depth + 1);
    }
    return out;
  }
  throw new Error(`${path} must contain only JSON values; no undefined, functions or non-finite numbers.`);
}
function keys(value, allowed, label) {
  record(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label}.${key} is not supported by this bridge.`);
}
function finite(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be a number between ${min} and ${max}.`);
  }
  return value;
}
function bool(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} must be a non-empty string without control characters.`);
  }
  return value.trim();
}
function unitId(value, label) {
  if (value === null || value === '') return '';
  const id = text(value, label);
  if (!/^[A-Za-z][A-Za-z0-9_:-]*$/.test(id)) throw new Error(`${label} is not a safe ad unit ID.`);
  return id;
}
function replaceDeclaration(source, name, value) {
  const regex = new RegExp(`^([\\t ]*var ${name} = )[^\\r\\n]*;[\\t ]*$`, 'gm');
  if ([...source.matchAll(regex)].length !== 1) throw new Error(`Reference declaration ${name} changed; review required.`);
  return source.replace(regex, (_match, prefix) => `${prefix}${JSON.stringify(value).replace(/</g, '\\u003c')};`);
}

/** UI/storage callers supply normalized, snapshotted values; no ad.js template is accepted. */
export function prepareReferenceBuild(coreInput, optionsInput) {
  const core = cloneJson(coreInput, 'core');
  const options = cloneJson(optionsInput, 'options');
  keys(core, CORE_KEYS, 'core');
  if (core.engine !== ENGINE) throw new Error('The built-in bridge requires the advanced-refresh compiler; no silent fallback.');
  for (const key of ['buildVersion', 'siteId', 'generatorProfileId']) {
    const value = text(core[key], `core.${key}`);
    if (!/^[A-Za-z0-9._-]+$/.test(value) || value.includes('..')) throw new Error(`core.${key} is not a safe immutable identifier.`);
  }
  const gamPath = text(core.gamPath, 'core.gamPath', 1024);
  if (!/^\/[A-Za-z0-9_.:/-]+\/$/.test(gamPath) || gamPath.includes('//') || gamPath.includes('..')) {
    throw new Error('core.gamPath must be a complete GAM path starting and ending with /.');
  }
  for (const key of ['bidders', 'explicitUnits']) if (!Array.isArray(core[key])) throw new Error(`core.${key} must be an array.`);
  for (const key of ['bidderSlotParams', 'bidderDeviceParams', 'bidderAdUnitParams', 'adUnitRules',
    'sizeMapsRaw', 'prebidSizeConfigsRaw', 'userSync', 'globalRefresh']) record(core[key], `core.${key}`);
  for (const key of ['defaultTimeout', 'atfTimeout', 'btfTimeout', 'stickyTimeout', 'maxCmpTimeout']) {
    finite(core[key], `core.${key}`, 100, 30000);
  }
  if (!Array.isArray(core.userSync.userIds)) throw new Error('core.userSync.userIds must be explicit, including an empty array.');
  for (const refresh of [core.globalRefresh, ...Object.values(core.adUnitRules).map((rule) => record(rule, 'adUnitRule').refresh ?? {})]) {
    record(refresh, 'refresh');
    if (refresh.schedule !== undefined) {
      const schedule = record(refresh.schedule, 'refresh.schedule');
      if (!['fixed', 'firstThenFixed', 'percentage', 'sequence'].includes(schedule.mode)) {
        throw new Error('Unknown refresh schedule; refusing a silent fixed-interval fallback.');
      }
      if (schedule.mode === 'sequence') {
        if (!Array.isArray(schedule.sequenceSeconds) || !schedule.sequenceSeconds.length) throw new Error('Refresh sequence must not be empty.');
        schedule.sequenceSeconds.forEach((seconds) => finite(seconds, 'refresh.sequenceSeconds', 1, 7200));
      }
    }
  }
  keys(options, new Set(['buildTimestamp', 'adContainerSelector', 'enablePrebid', 'debug', 'sticky',
    'floors', 'takeOver', 'schain', 'adKeywords', 'currencyConversion', 'unitRange', 'unitDefaults',
    'unitOverrides']), 'options');
  const selector = text(options.adContainerSelector, 'options.adContainerSelector', 512);
  const timestamp = text(options.buildTimestamp, 'options.buildTimestamp', 15);
  if (!/^\d{8}_\d{6}$/.test(timestamp)) throw new Error('options.buildTimestamp must be YYYYMMDD_HHmmss UTC.');
  const enablePrebid = bool(options.enablePrebid, 'options.enablePrebid');
  const sticky = record(options.sticky, 'options.sticky');
  keys(sticky, new Set(['bottomAdUnitId', 'topAdUnitId', 'refreshSeconds', 'emptyRetryDelays',
    'lazyEnabled', 'lazyScrollPx']), 'options.sticky');
  const bottomId = unitId(sticky.bottomAdUnitId, 'options.sticky.bottomAdUnitId');
  const topId = unitId(sticky.topAdUnitId, 'options.sticky.topAdUnitId');
  if (topId) throw new Error('Top sticky timers in reference 3.9.1 are inactive; this candidate cannot enable top sticky.');
  if (bottomId && !core.explicitUnits.some((unit) => unit.id === bottomId)) {
    throw new Error('Bottom sticky must reference an enabled explicit ad unit.');
  }
  const floors = record(options.floors, 'options.floors');
  keys(floors, new Set(['enabled', 'hardFloor', 'currency', 'bidderFloors', 'rules']), 'options.floors');
  const floorsEnabled = bool(floors.enabled, 'options.floors.enabled');
  finite(floors.hardFloor, 'options.floors.hardFloor', 0, 1000);
  const currency = text(floors.currency, 'options.floors.currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('options.floors.currency must have three letters.');
  for (const key of ['bidderFloors', 'rules']) {
    record(floors[key], `options.floors.${key}`);
    for (const [name, value] of Object.entries(floors[key])) finite(value, `options.floors.${key}.${name}`, 0, 1000);
  }
  const takeOver = options.takeOver ?? { enabled: false };
  keys(takeOver, new Set(Object.keys(TAKEOVER_KEYS)), 'options.takeOver');
  bool(takeOver.enabled, 'options.takeOver.enabled');
  if (takeOver.enabled && !text(takeOver.codelessAdUnitPath, 'options.takeOver.codelessAdUnitPath', 1024).startsWith('/')) {
    throw new Error('TakeOver needs the full, explicit interstitial fallback path.');
  }
  for (const [name, value] of Object.entries(takeOver)) {
    if (['enabled', 'showCountdown', 'allowEscapeClose', 'closeOnBackdrop', 'pauseTimerWhenHidden',
      'strictSize', 'blockCodeless', 'releaseCodelessOnNoFill'].includes(name)) bool(value, `options.takeOver.${name}`);
  }
  const settings = {
    GAM_PATH: gamPath, AD_CONTAINER_SELECTOR: selector,
    STICKY_TARGET_ID: bottomId || DISABLED_STICKY_SEED, STICKY_TOP_TARGET_ID: '',
    ENABLE_PREBID: enablePrebid, DEBUG_MODE: options.debug === undefined ? false : bool(options.debug, 'options.debug'),
    PREBID_TIMEOUT: core.defaultTimeout, PREBID_TIMEOUT_ATF: core.atfTimeout,
    PREBID_TIMEOUT_BTF: core.btfTimeout, PREBID_TIMEOUT_STICKY: core.stickyTimeout,
    CMP_TIMEOUT_MS: core.maxCmpTimeout, HARD_FLOOR_EUR: floorsEnabled ? floors.hardFloor : 0,
    AD_SERVER_CURRENCY: currency, BIDDER_FLOORS: floorsEnabled ? floors.bidderFloors : {},
    PREBID_FLOORS: floorsEnabled ? floors.rules : {},
    BIDDERS: core.bidders.map((bidder, index) => ({
      name: text(bidder.bidder, `core.bidders[${index}].bidder`),
      params: record(bidder.params, `core.bidders[${index}].params`),
    })),
    BIDDER_SLOT_PARAMS: core.bidderSlotParams, BIDDER_DEVICE_PARAMS: core.bidderDeviceParams,
    BIDDER_ADUNIT_PARAMS: core.bidderAdUnitParams, AD_UNIT_RULES: core.adUnitRules,
    AD_UNITS: core.explicitUnits, SIZE_MAPS: core.sizeMapsRaw,
    PREBID_SIZE_CONFIGS: core.prebidSizeConfigsRaw, USER_ID_MODULES: core.userSync.userIds,
    TAKEOVER_ENABLED: false,
  };
  for (const [key, value] of Object.entries(takeOver)) settings[TAKEOVER_KEYS[key]] = value;
  if (sticky.refreshSeconds !== undefined) settings.STICKY_REFRESH_SEC = finite(sticky.refreshSeconds, 'sticky.refreshSeconds', 1, 7200);
  if (sticky.lazyEnabled !== undefined) settings.STICKY_LAZY_ENABLED = bool(sticky.lazyEnabled, 'sticky.lazyEnabled');
  if (sticky.lazyScrollPx !== undefined) settings.STICKY_LAZY_SCROLL_PX = finite(sticky.lazyScrollPx, 'sticky.lazyScrollPx', 1, 100000);
  if (sticky.emptyRetryDelays !== undefined) {
    if (!Array.isArray(sticky.emptyRetryDelays) || !sticky.emptyRetryDelays.length) throw new Error('Explicit sticky retry delays cannot be empty.');
    settings.STICKY_EMPTY_RETRY_DELAYS = sticky.emptyRetryDelays.map((ms) => finite(ms, 'sticky.emptyRetryDelays', 1, 7200000));
  }
  for (const [key, target] of Object.entries({ schain: 'SCHAIN', adKeywords: 'ADS_KEYWORDS',
    unitRange: 'AD_UNIT_RANGE', unitDefaults: 'AD_UNIT_DEFAULTS', unitOverrides: 'AD_UNIT_OVERRIDES' })) {
    if (options[key] !== undefined) settings[target] = record(options[key], `options.${key}`);
  }
  const conversion = record(options.currencyConversion, 'options.currencyConversion');
  keys(conversion, new Set(['enabled', 'url']), 'options.currencyConversion');
  settings.ENABLE_CURRENCY_CONVERSION = bool(conversion.enabled, 'options.currencyConversion.enabled');
  const conversionUrl = new URL(text(conversion.url, 'options.currencyConversion.url', 2048));
  if (conversionUrl.protocol !== 'https:' || conversionUrl.username || conversionUrl.password) throw new Error('Currency URL must be credential-free HTTPS.');
  settings.CURRENCY_CONVERSION_URL = conversionUrl.toString();
  const id5 = core.userSync.userIds.find((entry) => entry.name === 'id5Id');
  const id5Partner = id5 ? finite(id5.params?.partner, 'id5Id.params.partner', 1, Number.MAX_SAFE_INTEGER) : 0;
  if (!Number.isSafeInteger(id5Partner)) throw new Error('id5Id.params.partner must be an integer.');
  settings.ID5_PARTNER_ID = id5Partner;
  return { core, settings, buildTimestamp: timestamp, bottomId, id5Partner, floorsEnabled };
}

/** Trusted in-memory generation, not a public API. Release overlays and module validation still apply. */
export function compileReferenceBuild(core, options, { buildReference391, compileRuntime }) {
  if (typeof buildReference391 !== 'function' || typeof compileRuntime !== 'function') throw new Error('Trusted builder and compiler are required.');
  const prepared = prepareReferenceBuild(core, options);
  let template = buildReference391(prepared.settings, { buildTimestamp: prepared.buildTimestamp });
  if (typeof template !== 'string' || !template.trim()) throw new Error('The reference builder did not return source.');
  // The reference's must(STICKY_TARGET_ID) and ID5 fallback are build-time defaults,
  // not permission to create a phantom sticky or inherit another site's partner ID.
  template = replaceDeclaration(template, 'STICKY_TARGET_ID', prepared.bottomId);
  template = replaceDeclaration(template, 'ID5_PARTNER_ID', prepared.id5Partner);
  const id5Assignment = 'window.ID5EspConfig = { partnerId: ID5_PARTNER_ID };';
  if (template.split(id5Assignment).length !== 2) throw new Error('Reference ID5 setup changed; review required.');
  template = template.replace(id5Assignment, `if (ID5_PARTNER_ID > 0) ${id5Assignment}`);
  const floorsMarker = 'floors: {\n  enabled: true,';
  if (template.split(floorsMarker).length !== 2) throw new Error('Reference floors setup changed; review required.');
  template = template.replace(floorsMarker, `floors: {\n  enabled: ${prepared.floorsEnabled},`);
  const prefetchMarker = 'var prefetchIO = new IntersectionObserver(function(entries, obs){';
  if (template.split(prefetchMarker).length !== 2) throw new Error('Reference lazy prefetch changed; review required.');
  template = template.replace(prefetchMarker,
    `${prefetchMarker}\n      if (!HAS_PREBID || !BIDDERS || !BIDDERS.length) return;`);
  const bootMarker = "(function(){\n  'use strict';";
  if (template.split(bootMarker).length !== 2) throw new Error('Reference boot changed; review required.');
  template = template.replace(bootMarker, `${bootMarker}
  if (window.__TESSERA_RUNTIME_STARTED) return;
  window.__TESSERA_RUNTIME_STARTED = ${JSON.stringify({siteId: prepared.core.siteId, version: prepared.core.buildVersion})};`);
  const result = compileRuntime({ ...prepared.core, template });
  if (!result || typeof result.adsJs !== 'string' || typeof result.adsMinJs !== 'string') throw new Error('Compiler did not return complete JavaScript.');
  if (result.adsJs.includes(DISABLED_STICKY_SEED)) throw new Error('Disabled sticky seed leaked into the compiled runtime.');
  return { ...result,
    patches: [...result.patches, 'explicit sticky selection', 'explicit ID5 partner', 'explicit floor enablement',
      'GPT-only lazy prefetch guard', 'single initialization per page'],
    generationMode: 'builtin-reference-bridge', requiresReleasePostprocessing: true,
  };
}
