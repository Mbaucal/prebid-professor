/** Emitted as source inside the wrapper. No global GPT interception. */
export function adGeoKeywords() {
  var keywords = Object.create(null), source;
  try { source = window.adsKeywords; } catch (_) {}
  Object.keys(source || {}).forEach(function(key) {
    if (key !== 'geo_country') keywords[key] = source[key];
  });
  if (AD_GEO_STATE.country) keywords.geo_country = AD_GEO_STATE.country;
  return keywords;
}

export function adGeoApplyTargeting() {
  try {
    // Replace this reserved key; the legacy keyword merger unions values.
    var value = AD_GEO_STATE.country;
    if (typeof googletag.setConfig === 'function') googletag.setConfig({targeting:{geo_country:value}});
    else if (value) googletag.pubads().setTargeting('geo_country', value);
    else googletag.pubads().clearTargeting('geo_country');
  } catch (_) { /* Optional metadata must not interrupt an auction. */ }
}

export function adGeoSelect(setting) {
  var keywords = adGeoKeywords();
  return setting.rules.find(function(rule) {
    return rule.match === 'any'
      ? rule.conditions.some(function(condition) { return adRuleMatches(condition, keywords); })
      : rule.conditions.every(function(condition) { return adRuleMatches(condition, keywords); });
  });
}

export function adConditionalConfig(id, config) {
  var setting = AD_CONDITIONAL_UNITS[id];
  if (!config || !setting) return config;
  if (setting.usesGeo && !AD_GEO_STATE.settled) return null;
  var decision = AD_CONDITIONAL_DECISIONS[id];
  if (!decision) {
    var selected = adGeoSelect(setting);
    decision = {map:selected && selected.sizeMapKey || setting.baseMap, disabled:!!selected && selected.slotAction === 'disable'};
    AD_CONDITIONAL_DECISIONS[id] = decision;
  }
  var element = document.getElementById(id);
  if (element) element.setAttribute('data-ad-rule-map', decision.disabled ? 'disabled' : String(setting.maps.indexOf(decision.map)));
  if (decision.disabled) return null;
  config.sizeMapName = decision.map;
  config.prebidSizeConfigName = decision.map;
  return config;
}

export function adGeoFallbackAllowed(reason) {
  if (!AD_INTERSTITIAL_RULES.rules.length) return true;
  if (AD_INTERSTITIAL_RULES.usesGeo && !AD_GEO_STATE.settled) {
    // Keep the first release reason. Multiple empty/timeout callbacks share it.
    if (AD_GEO_STATE.fallbackReason === null) AD_GEO_STATE.fallbackReason = reason || 'no-fill';
    _takeOver.guardStatus = 'fallback-waiting-country';
    return false;
  }
  if (AD_GEO_STATE.fallbackAllowed === null) {
    var selected = adGeoSelect(AD_INTERSTITIAL_RULES);
    AD_GEO_STATE.fallbackAllowed = !selected || selected.slotAction !== 'disable';
  }
  if (!AD_GEO_STATE.fallbackAllowed) _takeOver.guardStatus = 'fallback-disabled-by-rule';
  return AD_GEO_STATE.fallbackAllowed;
}

export function adGeoStart() {
  var timer;
  function finish(snapshot) {
    if (AD_GEO_STATE.settled) return;
    var country = null;
    try {
      country = snapshot && snapshot.version === 1 && snapshot.status === 'known' && snapshot.source === 'cloudflare'
        ? adGeoNormalizeCountry(snapshot.country) : null;
    } catch (_) { /* Foreign GEO objects may expose throwing accessors. */ }
    AD_GEO_STATE.settled = true;
    clearTimeout(timer);
    AD_GEO_STATE.country = country;
    googletag.cmd.push(function() { adGeoApplyTargeting(); });
    if (AD_GEO_STATE.initialized) {
      if (Object.keys(AD_CONDITIONAL_UNITS).some(function(id) { return AD_CONDITIONAL_UNITS[id].usesGeo; })) {
        defineAllSlots();
        googletag.cmd.push(function(){ if (AD_GEO_STATE.stickyCheck) AD_GEO_STATE.stickyCheck(); });
      }
      if (AD_GEO_STATE.fallbackReason !== null) {
        var reason = AD_GEO_STATE.fallbackReason;
        AD_GEO_STATE.fallbackReason = null;
        takeOverReleaseCodelessSuppression(reason);
      }
    }
  }
  // Bound integration even if a foreign object already occupies __AD_GEO.
  timer = setTimeout(function(){finish(null);}, 1500);
  try {
    var api = window.__AD_GEO;
    if (!api || typeof api.getSnapshot !== 'function' || typeof api.ready !== 'function') { finish(null); return; }
    var snapshot = api.getSnapshot();
    if (snapshot && (snapshot.status === 'known' || snapshot.status === 'unknown')) { finish(snapshot); return; }
    Promise.resolve(api.ready()).then(finish, function(){finish(null);});
  } catch (_) { finish(null); }
}
