/** Serialized at build time; no eval or Function#toString in the Worker. */
export function adRuleMatches(condition, keywords) {
  var own = keywords && Object.prototype.hasOwnProperty.call(keywords, condition.key);
  var raw = own ? keywords[condition.key] : null;
  var values = (Array.isArray(raw) ? raw : [raw]).filter(function(value) {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  }).map(function(value) { return String(value); }).filter(function(value) { return value.trim().length > 0; });
  if (condition.operator === 'exists') return values.length > 0;
  if (condition.operator === 'notExists') return values.length === 0;
  // An absent value does not accidentally satisfy a negative comparison.
  if (!values.length) return false;
  var contains = condition.operator === 'contains' || condition.operator === 'notContains';
  var matched = values.some(function(value) { return contains ? value.indexOf(condition.value) !== -1 : value === condition.value; });
  return condition.operator === 'notEquals' || condition.operator === 'notContains' ? !matched : matched;
}

export function adConditionalConfig(id, config) {
  var setting = AD_CONDITIONAL_UNITS[id];
  if (!config || !setting) return config;
  var decision = AD_CONDITIONAL_DECISIONS[id];
  if (!decision) {
    var keywords = window.adsKeywords || {};
    var selected = setting.rules.find(function(rule) {
      return rule.match === 'any'
        ? rule.conditions.some(function(condition) { return adRuleMatches(condition, keywords); })
        : rule.conditions.every(function(condition) { return adRuleMatches(condition, keywords); });
    });
    decision = {map: selected && selected.sizeMapKey || setting.baseMap, disabled: !!selected && selected.slotAction === 'disable'};
    AD_CONDITIONAL_DECISIONS[id] = decision;
  }
  // A position keeps one decision for GPT, Prebid and refresh. Resize still uses
  // responsive rows of that same map. Set page keywords before loading ads.js.
  var element = document.getElementById(id);
  if (element) element.setAttribute('data-ad-rule-map', decision.disabled ? 'disabled' : String(setting.maps.indexOf(decision.map)));
  if (decision.disabled) return null;
  config.sizeMapName = decision.map;
  config.prebidSizeConfigName = decision.map;
  return config;
}
