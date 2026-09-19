// Serialized into the new runtime only. Context is page-local, never a user ID.
export function createMeasurement(siteId, runtimeVersion) {
  var state = window.__tesseraExperiments && window.__tesseraExperiments[siteId];
  var c = state && state.context;
  var hash = /^[a-f0-9]{64}$/;
  var valid = c && c.profile === 'experiment-preview-v1' && c.siteId === siteId
    && c.runtimeVersion === runtimeVersion && c.active === true
    && (c.variant === 'A' || c.variant === 'B')
    && typeof c.experimentId === 'string' && /^[a-z0-9][a-z0-9-]{0,97}$/.test(c.experimentId)
    && Number.isSafeInteger(c.revision) && c.revision > 0
    && typeof c.deliverySha256 === 'string' && hash.test(c.deliverySha256)
    && typeof c.packageSha256 === 'string' && hash.test(c.packageSha256)
    && window.__tesseraExperimentOwner === siteId
    && (state.status === 'loading' || state.status === 'loaded');
  // Public GAM labels are deliberately simple. Full delivery identity stays local.
  var value = valid ? c.variant : null;
  var identity = valid ? {experimentId:c.experimentId, revision:c.revision,
    deliverySha256:c.deliverySha256, packageSha256:c.packageSha256, variant:c.variant} : null;
  var applied = new WeakSet(), counts = {applied:0, failed:0};
  function snapshot() {
    return {runtimeVersion:runtimeVersion, key:'Varijant', value:value,
      identity:identity && Object.assign({},identity), appliedSlots:counts.applied, failedSlots:counts.failed};
  }
  var registry = window.__tesseraGamMeasurement || (window.__tesseraGamMeasurement = Object.create(null));
  registry[siteId] = {snapshot:snapshot};
  return function apply(slot) {
    if (!value || !slot || applied.has(slot)) return;
    try {
      slot.setConfig({targeting:{Varijant:value}});
      applied.add(slot); counts.applied++;
    } catch (_) { counts.failed++; }
  };
}
