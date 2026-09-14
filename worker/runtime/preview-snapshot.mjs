/** Read-only preview adapter. No implicit profile selection and no persistence. */
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const [key, child] of Object.entries(value)) {
    if (BLOCKED.has(key)) throw new Error(`${label}: unsafe property.`);
    if (child && typeof child === 'object') {
      if (Array.isArray(child)) child.forEach((v) => { if (v && typeof v === 'object' && !Array.isArray(v)) object(v, label); });
      else object(child, label);
    }
  }
  return value;
}
function parsed(value, label) {
  let result;
  try { result = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error(`${label} contains invalid JSON.`); }
  return object(result ?? {}, label);
}
function merge(...values) {
  const result = {};
  for (const value of values) for (const [key, item] of Object.entries(object(value ?? {}, 'configuration'))) {
    result[key] = item && typeof item === 'object' && !Array.isArray(item)
      ? merge(result[key] && typeof result[key] === 'object' && !Array.isArray(result[key]) ? result[key] : {}, item)
      : item;
  }
  return result;
}
function number(value, fallback, label, min = 0, max = 30000) {
  const n = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}
function numericMap(value, label) {
  const result = object(value ?? {}, label);
  for (const [key, n] of Object.entries(result)) number(n, 0, `${label}.${key}`, 0, 1000);
  return Object.fromEntries(Object.entries(result).map(([key, n]) => [key, Number(n)]));
}
function size(value) {
  if (value === 'fluid') return 'fluid';
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isInteger(n) && n > 0 && n <= 10000)) throw new Error('Invalid ad size.');
  return [...value];
}
function mapRows(value, name) {
  let rows;
  try { rows = typeof value === 'string' ? JSON.parse(value) : value; }
  catch { throw new Error(`Size map ${name} contains invalid JSON.`); }
  if (!Array.isArray(rows) || !rows.length) throw new Error(`Size map ${name} is empty.`);
  return rows.map((row) => {
    const vp = row.minViewPort ?? row.viewport;
    if (!Array.isArray(vp) || vp.length !== 2 || !vp.every((n) => Number.isInteger(n) && n >= 0)) throw new Error(`Size map ${name} has an invalid viewport.`);
    if (!Array.isArray(row.sizes)) throw new Error(`Size map ${name} has invalid sizes.`);
    return { viewport: [...vp], sizes: row.sizes.map(size) };
  }).sort((a, b) => a.viewport[0] - b.viewport[0] || a.viewport[1] - b.viewport[1]);
}

export function previewInput(snapshot, descriptor, buildTimestamp, takeOver = { enabled: false }) {
  const site = object(snapshot.site, 'site');
  const config = parsed(snapshot.config?.config_json, 'Saved site configuration');
  const runtime = object(config.runtimeControls ?? {}, 'runtimeControls');
  const sticky = object(runtime.sticky ?? {}, 'sticky');
  const floors = object(runtime.floors ?? {}, 'floors');
  const consent = object(runtime.consent ?? {}, 'consent');
  const schain = object(runtime.schain ?? {}, 'schain');
  if (consent.mode && consent.mode !== 'cmp') throw new Error('This preview preserves CMP mode only. Contextual-test configuration is not supported yet; the saved setting was not changed.');
  if (sticky.topAdUnitId) throw new Error('Top sticky is not supported by this reference candidate. The saved setting was not changed.');
  if (sticky.allowClosePortal === true) throw new Error('Close portal mode requires the release overlay and is not available in this source preview.');

  const units = (snapshot.units ?? []).filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT');
  if (!units.length) throw new Error('Add at least one enabled ad unit before generating a preview.');
  const seen = new Set();
  for (const unit of units) {
    if (!/^[A-Za-z][A-Za-z0-9_:-]*$/.test(unit.code) || seen.has(unit.code) || BLOCKED.has(unit.code)) throw new Error('Ad unit IDs must be unique and safe.');
    seen.add(unit.code);
    if (!['ATF', 'BTF'].includes(unit.type)) throw new Error(`Unsupported ad unit type: ${unit.code}.`);
    if (unit.media_type && unit.media_type !== 'banner') throw new Error(`This preview supports banner units only (${unit.code}).`);
  }
  const maps = {};
  for (const row of snapshot.maps ?? []) {
    if (BLOCKED.has(row.name)) throw new Error('Unsafe size map name.');
    maps[row.name] = mapRows(row.map_json, row.name);
  }
  const explicitUnits = units.map((unit) => {
    if (!unit.size_map_key || !Object.hasOwn(maps, unit.size_map_key)) throw new Error(`${unit.code} needs a saved size map.`);
    const union = new Map();
    for (const bp of maps[unit.size_map_key]) for (const pair of bp.sizes) union.set(JSON.stringify(pair), pair);
    if (!union.size) throw new Error(`${unit.code} has no enabled sizes.`);
    return { id: unit.code, type: unit.type, formats: ['banner'], sizes: [...union.values()],
      video: null, native: null, sizeMapName: unit.size_map_key, prebidSizeConfigName: unit.size_map_key, properties: [] };
  });

  const basic = {};
  for (const row of snapshot.rules ?? []) {
    if (BLOCKED.has(row.rule_key)) throw new Error('Unsafe rule key.');
    basic[row.rule_key] = parsed(row.rule_json, `Rule ${row.rule_key}`);
  }
  const advanced = object(config.advancedUnitRules ?? {}, 'advancedUnitRules');
  const rules = {};
  for (const key of new Set([...Object.keys(basic), ...Object.keys(advanced)])) {
    rules[key] = merge(basic[key], advanced[key]);
    if (rules[key].conditionalMappings?.length) throw new Error(`Conditional mapping in ${key} requires the release overlay; this preview will not silently discard it.`);
    if (rules[key].lazy && Object.keys(rules[key].lazy).length) throw new Error(`Per-slot lazy settings in ${key} require the release overlay; this preview will not silently discard them.`);
  }
  const defaultRule = rules.__DEFAULT__ ?? {};
  const atf = rules.__ATF__ ?? {};
  const btf = rules.__BTF__ ?? {};
  const bottomId = Object.hasOwn(sticky, 'bottomAdUnitId') ? (sticky.bottomAdUnitId || '') : seen.has('Sticky') ? 'Sticky' : '';
  const stickyRule = rules[bottomId] ?? {};
  const enabled = config.enablePrebid !== false;
  const bidders = enabled ? (snapshot.bidders ?? []).filter((row) => row.enabled === 1).map((row) => ({ bidder: row.bidder, params: parsed(row.params_json, `Bidder ${row.bidder}`) })) : [];
  const bySlot = {}, byDevice = {}, byUnit = {};
  for (const row of enabled ? snapshot.overrides ?? [] : []) {
    if (row.enabled !== 1) continue;
    const target = row.scope_type === 'slot' ? bySlot : row.scope_type === 'device' ? byDevice : row.scope_type === 'adunit' ? byUnit : null;
    if (!target) throw new Error('Unsupported bidder override scope.');
    if (BLOCKED.has(row.bidder) || BLOCKED.has(row.scope_key)) throw new Error('Invalid bidder override key.');
    if (row.scope_type === 'adunit' && !seen.has(row.scope_key)) throw new Error(`Bidder override references missing unit ${row.scope_key}.`);
    (target[row.bidder] ??= {})[row.scope_key] = parsed(row.params_json, 'Bidder override');
  }
  const userSync = enabled && config.userSync ? parsed(config.userSync, 'userSync') : {
    syncEnabled: false, aliasSyncEnabled: false, syncsPerBidder: 0, syncDelay: 0, auctionDelay: 0,
    filterSettings: { all: { bidders: '*', filter: 'include' } }, userIds: [],
  };
  if (!Array.isArray(userSync.userIds)) throw new Error('Saved userSync.userIds must be an array.');
  const timeout = (rule, fallback) => number(rule.timeout, fallback, 'Auction timeout', 100, 30000);
  const defaultTimeout = timeout(defaultRule, 2500);
  const core = {
    engine: 'legacy-advanced-refresh-v1', buildVersion: buildTimestamp, siteId: site.id,
    generatorProfileId: descriptor.id, gamPath: site.gam_path, bidders,
    bidderSlotParams: bySlot, bidderDeviceParams: byDevice, bidderAdUnitParams: byUnit,
    adUnitRules: rules, explicitUnits, sizeMapsRaw: maps, prebidSizeConfigsRaw: {}, userSync,
    defaultTimeout, atfTimeout: timeout(atf, defaultTimeout), btfTimeout: timeout(btf, defaultTimeout),
    stickyTimeout: timeout(stickyRule, defaultTimeout),
    globalRefresh: defaultRule.refresh ?? atf.refresh ?? { enabled: false },
    maxCmpTimeout: Math.max(1500, ...Object.values(rules).map((rule) => number(rule.cmpTimeout, 1500, 'CMP timeout', 100, 30000))),
  };
  const options = {
    buildTimestamp, adContainerSelector: '.wrapperAd', enablePrebid: enabled, debug: false,
    sticky: { bottomAdUnitId: bottomId, topAdUnitId: '', refreshSeconds: number(stickyRule.refresh?.minSeconds, 30, 'Sticky refresh', 1, 7200) },
    floors: { enabled: floors.enabled !== false, hardFloor: number(floors.hardFloor, 0.04, 'Hard floor', 0, 1000),
      currency: String(floors.currency ?? 'EUR'), bidderFloors: numericMap(floors.bidderFloors, 'bidderFloors'), rules: numericMap(floors.rules, 'floorRules') },
    takeOver: object(takeOver, 'takeOver'),
    currencyConversion: { enabled: runtime.currencyConversion?.enabled !== false, url: 'https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json' },
  };
  if (schain.enabled !== false && Array.isArray(schain.nodes) && schain.nodes.length) {
    options.schain = { ver: String(schain.version ?? '1.0'), complete: schain.complete === 0 ? 0 : 1, nodes: schain.nodes };
  }
  return { core, options };
}

export async function digest(value) {
  // Object field insertion order is not a configuration change. Arrays retain order.
  const serialized = typeof value === 'string' ? value : JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
  const bytes = new TextEncoder().encode(serialized);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function assertReview(snapshot, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || expected !== await digest(snapshot)) {
    throw new Error('Site configuration changed after review. Click Refresh settings and generate again.');
  }
}
