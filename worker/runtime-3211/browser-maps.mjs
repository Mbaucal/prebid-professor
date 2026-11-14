/** Preserve the real base decision when a conditional rule does not replace a map. */
export function adConditionalConfig(id, config) {
  var setting = AD_CONDITIONAL_UNITS[id];
  if (!config || !setting) return config;
  if (setting.usesGeo && !AD_GEO_STATE.settled) return null;
  var decision = AD_CONDITIONAL_DECISIONS[id];
  if (!decision) {
    var selected = adGeoSelect(setting), map = selected && selected.sizeMapKey;
    decision = {
      map: map || config.sizeMapName,
      prebidMap: map || config.prebidSizeConfigName,
      disabled: !!selected && selected.slotAction === 'disable'
    };
    AD_CONDITIONAL_DECISIONS[id] = decision;
  }
  var element = document.getElementById(id);
  if (element) element.setAttribute('data-ad-rule-map', decision.disabled ? 'disabled' : String(setting.maps.indexOf(decision.map)));
  if (decision.disabled) return null;
  // Keep GPT and Prebid's independently chosen base maps. An explicit override
  // changes both. This stored decision survives category changes and refresh;
  // a resize only chooses the corresponding responsive row of each same map.
  config.sizeMapName = decision.map;
  config.prebidSizeConfigName = decision.prebidMap;
  return config;
}
