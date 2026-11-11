import {CONTEXTUAL_TAXONOMIES} from './catalog.mjs';

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(Error(message), {status: 422}); };
const identifiers = new Map(CONTEXTUAL_TAXONOMIES.map(taxonomy => [taxonomy.id, new Set(taxonomy.categories.map(category => category.id))]));
function keys(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}: use the displayed fields only.`);
}
function exactText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}: enter a non-empty value of at most ${max} characters.`);
  // Page metadata is matched literally. Do not silently trim or change case.
  return value;
}
export function defaultContextualSignals() {
  return {schemaVersion: 1, enabled: false, sourceKey: 'category', gam: {enabled: false}, bidders: [], mappings: []};
}

/** Validate configuration, never the value of a future publisher page. */
export function normalizeContextualSignals(value = defaultContextualSignals(), _context = {}) {
  keys(value, ['schemaVersion', 'enabled', 'sourceKey', 'gam', 'bidders', 'mappings'], 'Contextual signals');
  if (value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') fail('Unsupported contextual signal settings version.');
  const sourceKey = exactText(value.sourceKey, 'Page category key', 100);
  keys(value.gam, ['enabled'], 'GAM PPS');
  if (typeof value.gam.enabled !== 'boolean') fail('Choose whether GAM PPS is enabled.');
  if (!Array.isArray(value.bidders) || value.bidders.length > 200) fail('Use at most 200 bidder destinations.');
  const bidderNames = new Set();
  const bidders = value.bidders.map(route => {
    keys(route, ['bidder', 'taxonomy'], 'Bidder destination');
    const bidder = exactText(route.bidder, 'Bidder code', 100);
    if (!/^[A-Za-z0-9_-]+$/.test(bidder)) fail(`Invalid bidder code ${bidder}.`);
    if (bidderNames.has(bidder)) fail(`Choose one taxonomy for ${bidder}.`);
    if (!identifiers.has(route.taxonomy)) fail(`${bidder}: select a supported contextual taxonomy.`);
    bidderNames.add(bidder);
    return {bidder, taxonomy: route.taxonomy};
  });
  if (!Array.isArray(value.mappings) || value.mappings.length > 500) fail('Use at most 500 page category mappings.');
  const categoryNames = new Set();
  const mappings = value.mappings.map(row => {
    keys(row, ['value', 'taxonomies'], 'Category mapping');
    const category = exactText(row.value, 'Category value', 200);
    if (categoryNames.has(category)) fail(`Category ${category} has more than one mapping. Combine its IDs in one row.`);
    categoryNames.add(category);
    keys(row.taxonomies, [...identifiers.keys()], `Category ${category}`);
    const taxonomies = {};
    for (const taxonomy of identifiers.keys()) {
      if (!own(row.taxonomies, taxonomy)) continue;
      const raw = row.taxonomies[taxonomy];
      if (!Array.isArray(raw) || raw.length > 100) fail(`${category}: enter at most 100 IDs for ${taxonomy}.`);
      const ids = [];
      for (const id of raw) {
        if (typeof id !== 'string' || !identifiers.get(taxonomy).has(id)) fail(`${category}: ${String(id)} is not an ID in ${taxonomy}. Choose an ID from that version's catalog.`);
        if (!ids.includes(id)) ids.push(id);
      }
      taxonomies[taxonomy] = ids;
    }
    return {value: category, taxonomies};
  });
  return {schemaVersion: 1, enabled: value.enabled, sourceKey, gam: {enabled: value.gam.enabled}, bidders, mappings};
}

/** Old runtimes must not silently discard enabled new settings. Draft saves remain allowed. */
export function requireContextualRuntime(config, descriptor) {
  if (config?.runtimeControls?.contextualSignals?.enabled === true && !descriptor?.capabilities?.includes('contextual-signals')) {
    fail('Contextual signals require script 3.21.0. Select it in Script setup and save, or turn off contextual signals. Your mappings are kept.');
  }
}

export function contextualSignalsInput(snapshot) {
  const config = JSON.parse(snapshot.config.config_json);
  const settings = normalizeContextualSignals(config.runtimeControls?.contextualSignals);
  // Inactive/removed destinations keep their saved mapping, but receive no signal.
  const active = new Set((snapshot.bidders || []).filter(row => row.enabled === 1).map(row => row.bidder));
  const bidders = config.enablePrebid === true ? settings.bidders.filter(route => active.has(route.bidder)) : [];
  return {...settings, bidders, providerName: String(snapshot.site.domain || snapshot.site.id),
    prebidVersion: snapshot.prebidBuilds?.find(build => build.status === 'current')?.version || null};
}
