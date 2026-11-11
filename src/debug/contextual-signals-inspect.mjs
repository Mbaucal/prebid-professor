/** Read-only console report. Does not start auctions, change config or send data. */
export function contextualSignalsInspectCommand(){
  return `(() => {
  const helper = window.__AD_CONTEXT;
  if (!helper || typeof helper.snapshot !== 'function') {
    console.warn('Contextual signals diagnostics are unavailable. Select the top page frame and use a generated script with contextual signal support.');
    return null;
  }
  const report = helper.snapshot();
  console.table((report.outputs || []).map(row => ({
    destination: row.destination, taxonomy: row.taxonomy,
    ids: row.ids.join(', ') || '(unmapped)', evidence: row.evidence,
    prebidVersion: report.prebidVersion, providerRegistered: report.providerRegistered
  })));
  console.log('Contextual signals report', report);
  console.log('Evidence limit: ' + report.evidence);
  return report;
})();`;
}
