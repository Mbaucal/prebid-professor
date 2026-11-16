/** Pure, standalone projection. Serialized into the publisher console command. */
export function summarizeSchainPosition(report, target, slots = [], includeDetails = false) {
  target = typeof target === 'string' ? target.trim() : '';
  const result = {
    report: 'Ad request report', generatedAt: report.generatedAt,
    prebidVersion: report.prebidVersion, target, bidderFilter: report.scope.bidder || null,
    selection: 'Latest matching auction in retained event order; prefer its latest mapped HTTP call, otherwise its latest Prebid input. Choose a bidder to narrow it.',
    status: 'selection-required', evidence: 'none', request: null,
    environment: report.environment,
    schainCheck: { status: 'not-checked', errors: [] },
    otherChecks: { adsTxt: 'not-checked', sellersJson: 'not-checked', paymentRelationships: 'not-checked', sspAcceptance: 'not-checked' },
    capture: { active: report.capture.active, pending: report.capture.pending,
      droppedRequests: report.capture.droppedRequests, droppedNetwork: report.capture.droppedNetwork },
    warnings: [...report.warnings],
    limits: 'Summary fields are an extract. details(), copy() and download() include the selected original payload when available. Basic SChain checks do not verify ads.txt, sellers.json, payment relationships or SSP acceptance. Not checked does not mean missing.',
  };
  if (report.blockedReason) { result.status = report.blockedReason; return result; }
  if (!target) { result.warnings.push('Choose one ad unit name or full GAM path.'); return result; }
  const isPath = target.startsWith('/');
  const string = value => typeof value === 'string' && value.length > 0;
  const paths = bid => [...new Set([bid?.ortb2Imp?.ext?.gpid, bid?.ortb2Imp?.ext?.data?.adserver?.adslot].filter(string))];
  const candidates = [];
  const codes = new Set();
  for (const request of report.requests) {
    for (const item of request.filteredBids) {
      const directPaths = paths(item.bid);
      const gptPaths = slots.filter(s => s.elementId === item.adUnitCode).map(s => s.path).filter(string);
      // Current GPT slots are only a fallback when the recorded bid has no path.
      const matching = item.adUnitCode === target || (isPath && (directPaths.length ? directPaths : gptPaths).includes(target));
      if (!matching) continue;
      codes.add(item.adUnitCode);
      candidates.push({ request, item, paths: directPaths.length ? directPaths : gptPaths,
        match: item.adUnitCode === target ? 'exact adUnitCode' : directPaths.includes(target) ? 'exact recorded GPID/adslot' : 'current GPT path + exact slot element ID' });
    }
  }
  if (isPath) for (const slot of slots) if (slot.path === target && slot.elementId) codes.add(slot.elementId);
  if (codes.size > 1) {
    result.status = 'ambiguous-position'; result.candidates = [...codes].sort();
    result.warnings.push('This path identifies multiple positions. Enter one exact adUnitCode.'); return result;
  }
  if (!candidates.length) { result.status = 'not-found'; result.warnings.push('No exact match in retained Prebid history. Check the name/path and bidder, or wait for a natural request.'); return result; }
  let selected = candidates[candidates.length - 1];
  const latestAuction = selected.request.auctionId;
  // With All bidders, the last Prebid input may be an unsupported adapter.
  // Prefer a mapped supported call in the SAME latest auction, not an older one.
  for (const record of report.network) {
    const matches = candidates.filter(c => c.request.auctionId === latestAuction && c.request.bidder === record.bidder &&
      record.matches.some(m => m.bidId === c.item.bidId && m.auctionId === c.request.auctionId && m.adUnitCode === c.item.adUnitCode));
    if (matches.length === 1) selected = matches[0];
  }
  const { request, item } = selected;
  const siblings = candidates.filter(c => c.request === request && c.item.adUnitCode === item.adUnitCode);
  if (siblings.length > 1) { result.status = 'ambiguous-bids'; result.warnings.push('The latest batch has multiple bids for this position; inspect the full batch.'); return result; }
  result.status = 'matched';
  const recorded = report.network.filter(n => n.bidder === request.bidder && n.matches.some(m =>
    m.bidId === item.bidId && m.auctionId === request.auctionId && m.adUnitCode === item.adUnitCode));
  const wire = recorded[recorded.length - 1];
  const impressions = wire?.body?.value?.imp;
  const matchingImpressions = Array.isArray(impressions) ? impressions.filter(imp => imp?.id === item.bidId) : [];
  const http = wire && matchingImpressions.length === 1 ? wire : null;
  if (wire && !http) result.warnings.push('HTTP impression mapping is ambiguous; showing Prebid evidence only.');
  const found = http ? [
    ['body.source.schain', http.body.value.source?.schain],
    ['body.source.ext.schain', http.body.value.source?.ext?.schain],
    ['body.ext.schain', http.body.value.ext?.schain],
  ].filter(([, value]) => value != null).map(([path, value]) => ({ path, value })) : item.schain;
  // Compare objects independent of property insertion order; array order is meaningful.
  function canonical(value) {
    if (!value || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  const variants = [...new Map(found.map(s => [canonical(s.value), s.value])).values()];
  if (JSON.stringify(found).length > 24000) {
    result.status = 'evidence-too-large';
    result.warnings.push('SChain evidence exceeds the short report limit. Inspect the full snapshot.');
    return result;
  }
  const errors = [];
  const chain = variants.length === 1 ? variants[0] : null;
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const domain = v => string(v) && v.length <= 253 && v.includes('.') &&
    v.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (variants.length > 1) errors.push('Conflicting SChain values at captured paths.');
  else if (variants.length && !object(chain)) errors.push('SChain must be an object; serialized strings are not validated here.');
  else if (chain) {
    if (/"\[(?:Unsupported (?:function|bigint)|Circular)\]"/.test(JSON.stringify(chain))) errors.push('SChain contains values replaced during JSON capture; its structure cannot be verified.');
    if (chain.ver !== '1.0') errors.push('Only SChain 1.0 is checked.');
    if (chain.complete !== 0 && chain.complete !== 1) errors.push('complete must be integer 0 or 1.');
    if (!Array.isArray(chain.nodes) || !chain.nodes.length) errors.push('nodes must be a non-empty array.');
    for (const [i, node] of (Array.isArray(chain.nodes) ? chain.nodes : []).entries()) {
      if (!object(node)) { errors.push('nodes[' + i + '] must be an object.'); continue; }
      if (!domain(node.asi)) errors.push('nodes[' + i + '].asi must be a domain, without a URL scheme/path.');
      if (!string(node.sid) || !node.sid.trim()) errors.push('nodes[' + i + '].sid must be a non-empty string.');
      if (string(node.sid) && node.sid.length > 64) result.warnings.push('nodes[' + i + '].sid exceeds the recommended 64 characters.');
      if (node.hp !== 1) errors.push('nodes[' + i + '].hp must be integer 1 for SChain 1.0.');
      for (const key of ['rid', 'name', 'domain']) if (node[key] != null && typeof node[key] !== 'string') errors.push('nodes[' + i + '].' + key + ' must be a string.');
      if (node.domain != null && !domain(node.domain)) errors.push('nodes[' + i + '].domain must be a domain.');
      if (node.ext != null && !object(node.ext)) errors.push('nodes[' + i + '].ext must be an object.');
    }
    if (chain.ext != null && !object(chain.ext)) errors.push('ext must be an object.');
    if (chain.complete === 0) result.warnings.push('complete=0 declares an incomplete chain.');
  }
  result.evidence = http ? 'captured-http-call' : 'prebid-only';
  result.schainCheck = {
    status: !variants.length ? 'not-found-in-selected-evidence' : errors.length ? 'check-failed' : 'basic-fields-pass',
    errors,
  };
  const impression = http ? matchingImpressions[0] : item.bid.ortb2Imp;
  const banner = http ? impression?.banner : item.bid.mediaTypes?.banner;
  const sizes = http ? (banner?.format || (banner?.w && banner?.h ? [{ w: banner.w, h: banner.h }] : [])) : banner?.sizes;
  result.request = {
    adUnitCode: item.adUnitCode, paths: selected.paths, matchedBy: selected.match,
    bidder: request.bidder, auctionId: request.auctionId, bidId: item.bidId,
    observedAt: http ? http.observedAt : request.observedAt,
    prebidElapsedTime: request.elapsedTime,
    requestId: http ? http.body.value.id || null : request.bidderRequestId,
    ...(http ? { endpoint: new URL(http.url).origin + new URL(http.url).pathname, method: http.method,
      originalBatchImpressions: impressions.length, decoding: http.body.status } : { originalBatchBids: request.originalRequest.bids?.length || 0 }),
    impression: { id: http ? impression.id : item.bidId, sizes: sizes || [],
      gpid: impression?.ext?.gpid || null, adslot: impression?.ext?.data?.adserver?.adslot || null },
    schainPaths: found.map(s => s.path), schain: chain,
    ...(variants.length > 1 ? { conflictingSchain: found } : {}),
  };
  if (includeDetails) result.originalRequest = http ? {
    kind: 'captured-http-call', observedAt: http.observedAt, method: http.method, url: http.url,
    query: http.query, body: http.body, selectedImpressionId: item.bidId,
    batchSize: impressions.length,
    note: 'Original captured body, unchanged. A batch may include other positions. Headers and browser-added transport fields are not recorded; use DevTools for those.',
  } : {
    kind: 'prebid-input', observedAt: request.observedAt, serialization: request.serialization,
    selectedBidId: item.bidId, batchSize: request.originalRequest.bids?.length || 0,
    body: request.originalRequest,
    note: 'Complete retained Prebid batch, not the outgoing HTTP payload. Non-JSON values may be marked as replaced.',
  };
  if (!http) result.warnings.push('No decoded HTTP payload mapped to this exact bid. Prebid input is not proof of transmission.');
  else result.warnings.push('Observed page fetch/XHR call; delivery and SSP acceptance are not verified.');
  if (result.capture.droppedRequests || result.capture.droppedNetwork) result.warnings.push('Capture limits dropped records; latest means latest retained matching request.');
  return result;
}
