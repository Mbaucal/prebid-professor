// Passive, page-local diagnostics. Never requests bids, changes targeting/config,
// reserves bids, renders creatives, or drives a refresh timer.
export function createBidReadinessObserver({pbjs, service, codes, contextForCode,
  now = Date.now, maxAgeSeconds = 60, renderBudgetSeconds = 2, bidLimit = 2048}) {
  if (!/^v?11\.34\.0$/.test(pbjs?.version || '')) throw Error('Reviewed Prebid 11.34.0 required');
  if (!Array.isArray(codes) || !codes.length || codes.length > 100 || new Set(codes).size !== codes.length
    || codes.some(c => typeof c !== 'string' || !/^[\w.-]{1,100}$/.test(c))) throw Error('Explicit owned codes required');
  if (typeof contextForCode !== 'function' || typeof now !== 'function'
    || !Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 300
    || !Number.isFinite(renderBudgetSeconds) || renderBudgetSeconds < 0 || renderBudgetSeconds > 30
    || !Number.isInteger(bidLimit) || bidLimit < 1 || bidLimit > 4096) throw Error('Invalid readiness settings');
  for (const key of ['onEvent','offEvent','getConfig','getBidResponseByAdId'])
    if (typeof pbjs[key] !== 'function') throw Error('Required public Prebid API unavailable');
  if (!service?.addEventListener || !service?.removeEventListener || !service?.getSlots) throw Error('GPT observation unavailable');
  const allowed = new Set(codes), auctions = new Map(), bids = new Map(), hooks = [], gptHooks = [];
  const stats = new Map(codes.map(code => [code, {received:0, submitted:0, bidWon:0,
    renderSucceeded:0, renderFailed:0, gamRequests:0, gamFilled:0, gamEmpty:0}]));
  let stopped = false, capacityReached = false, errors = 0;
  function inc(row,key) { row[key] = Math.min(Number.MAX_SAFE_INTEGER,row[key]+1); }
  function guarded(fn) { return (...args) => { if (!stopped) try { fn(...args); } catch { errors++; } }; }
  function context(code) {
    if (!allowed.has(code)) return null;
    const c = contextForCode(code);
    if (!c?.slot || !service.getSlots().includes(c.slot) || !Number.isSafeInteger(c.epoch) || c.epoch < 0
      || !Array.isArray(c.sizes) || c.sizes.length > 64 || !Number.isFinite(c.floor) || c.floor < 0
      || !/^[A-Z]{3}$/.test(c.currency || '')) return null;
    const sizes = c.sizes.filter(s => Array.isArray(s) && s.length === 2
      && s.every(v => Number.isInteger(v) && v > 0 && v <= 10000)).map(s => s.join('x')).sort();
    return {slot:c.slot, epoch:c.epoch, sizes, floor:c.floor, currency:c.currency,
      consentReady:c.consentReady === true, bidderFloors:c.bidderFloors || {}};
  }
  function same(a,b) { return a && b && a.slot === b.slot && a.epoch === b.epoch
    && a.sizes.join(',') === b.sizes.join(',') && a.currency === b.currency; }
  function ownedSlot(slot) {
    const code = slot?.getSlotElementId?.();
    return allowed.has(code) && context(code)?.slot === slot ? code : null;
  }
  function recordUse(id,stage,code) {
    const row = bids.get(id);
    if (!row || (code && row.code !== code)) return;
    if (!row[stage]) { row[stage] = true; if (stage in stats.get(row.code)) inc(stats.get(row.code),stage); }
  }
  function targetingIds(slot) {
    return new Set(slot.getTargetingKeys().filter(k => k === 'hb_adid' || k.startsWith('hb_adid_'))
      .flatMap(k => slot.getTargeting(k) || []).flatMap(v => String(v).split(',')));
  }
  function scanTargeting(code,c) {
    // Also covers manual map copying and automatic preset targeting, including
    // secondary deals. Conservatively consider every targeted offer unavailable.
    for (const id of targetingIds(c.slot)) recordUse(id,'submitted',code);
  }
  function on(name,fn) { const cb = guarded(fn); pbjs.onEvent(name,cb); hooks.push([name,cb]); }
  function gpt(name,fn) { const cb = guarded(fn); service.addEventListener(name,cb); gptHooks.push([name,cb]); }
  function auctionInit(e) {
    if (typeof e?.auctionId !== 'string' || !Array.isArray(e.adUnits)) return;
    const rows = new Map();
    for (const unit of e.adUnits) { const c = context(unit.code); if (c) rows.set(unit.code,c); }
    if (!rows.size) return;
    auctions.set(e.auctionId,{rows,ended:false});
    while (auctions.size > 128) auctions.delete(auctions.keys().next().value);
  }
  function bidResponse(b) {
    if (!allowed.has(b?.adUnitCode) || typeof b.adId !== 'string' || bids.has(b.adId)) return;
    const start = auctions.get(b.auctionId)?.rows.get(b.adUnitCode);
    if (!start) return; // A late installation never certifies historical bids.
    inc(stats.get(b.adUnitCode),'received');
    if (bids.size >= bidLimit) { capacityReached = true; return; }
    // Keep identity/context only. Creatives, consent strings and user IDs stay in Prebid.
    bids.set(b.adId,{code:b.adUnitCode,auctionId:b.auctionId,start,submitted:false,
      bidWon:false,renderSucceeded:false,renderFailed:false,rejected:false});
  }
  function classify(id,row,c) {
    if (capacityReached) return {reason:'capacity'};
    if (!c || !same(row.start,c)) return {reason:'context-changed'};
    if (!c.consentReady || !row.start.consentReady) return {reason:'consent-unavailable'};
    const bid = pbjs.getBidResponseByAdId(id);
    if (!bid || bid.adUnitCode !== row.code || bid.auctionId !== row.auctionId) return {reason:'bid-unavailable'};
    if (row.submitted || row.bidWon || row.renderSucceeded || row.renderFailed || row.rejected
      || ['targetingSet','rendered','bidRejected'].includes(bid.status)) return {reason:'already-used'};
    const auction = auctions.get(row.auctionId);
    if (!auction) return {reason:'history-unavailable'};
    if (!auction.ended) return {reason:'auction-pending'};
    if (bid.mediaType !== 'banner' || !c.sizes.includes(bid.width+'x'+bid.height)) return {reason:'size-or-format'};
    if (bid.currency !== c.currency) return {reason:'currency'};
    const floor = Math.max(c.floor,Number(c.bidderFloors[bid.bidderCode]) || 0);
    if (!Number.isFinite(bid.cpm) || bid.cpm <= 0 || bid.cpm < floor) return {reason:'floor'};
    if (!(typeof bid.ad === 'string' && bid.ad.length) && !(typeof bid.adUrl === 'string' && /^https?:\/\//.test(bid.adUrl)))
      return {reason:'creative-unavailable'};
    const configuredBuffer = pbjs.getConfig('ttlBuffer');
    const buffer = Object.hasOwn(bid,'ttlBuffer') ? bid.ttlBuffer : configuredBuffer ?? 1;
    const age = now() - bid.responseTimestamp;
    if (!Number.isFinite(age) || age < 0 || !Number.isFinite(bid.ttl) || bid.ttl <= 0
      || !Number.isFinite(buffer) || buffer < 0) return {reason:'invalid-lifetime'};
    const remaining = Math.min((bid.ttl-buffer)*1000,maxAgeSeconds*1000) - age;
    if (remaining <= renderBudgetSeconds*1000) return {reason:'expired-or-too-close'};
    // These are conservative screening results, not a native targeting selection.
    // Public getHighestCpmBids mutates latestTargetedAuctionId in this pinned core,
    // so it is deliberately NOT called by an observational debugger.
    if (pbjs.getConfig('bidCacheFilterFunction') || pbjs.getConfig('bidderSettings')
      || pbjs.getConfig('targetingControls.bidTargetingExclusion')) return {reason:'custom-selection-unverified'};
    return {reason:null,remainingMs:Math.floor(remaining),ageMs:Math.floor(age)};
  }
  try {
    on('auctionInit',auctionInit);
    on('auctionEnd',e => { const a=auctions.get(e?.auctionId); if(a) a.ended=true; });
    on('bidResponse',bidResponse);
    on('bidRejected',b => recordUse(b?.adId,'rejected'));
    on('bidWon',b => recordUse(b?.adId,'bidWon'));
    on('adRenderSucceeded',e => recordUse(e?.bid?.adId || e?.adId,'renderSucceeded'));
    on('adRenderFailed',e => recordUse(e?.bid?.adId || e?.adId,'renderFailed'));
    on('setTargeting',map => {
      for (const code of codes) for (const [key,value] of Object.entries(map?.[code] || {}))
        if (key === 'hb_adid' || key.startsWith('hb_adid_'))
          for (const id of (Array.isArray(value)?value:[value]).flatMap(v=>String(v).split(','))) recordUse(id,'submitted',code);
    });
    gpt('slotRequested',e => { const code=ownedSlot(e?.slot); if(code) { scanTargeting(code,context(code)); inc(stats.get(code),'gamRequests'); } });
    gpt('slotRenderEnded',e => { const code=ownedSlot(e?.slot); if(code) inc(stats.get(code),e.isEmpty?'gamEmpty':'gamFilled'); });
  } catch (error) { stop(); throw error; }
  function snapshot() {
    const rows = codes.map(code => {
      const counters={...stats.get(code)},rejected={};
      let candidates=0,earliestExpiryMs=null,bestAgeMs=null,c=null;
      try {
        c=context(code);
        if (!stopped && c) scanTargeting(code,c);
        for (const [id,row] of bids) if (row.code===code) {
          const result=stopped?{reason:'stopped'}:classify(id,row,c);
          if (result.reason) rejected[result.reason]=(rejected[result.reason]||0)+1;
          else { candidates++; earliestExpiryMs=Math.min(earliestExpiryMs??Infinity,result.remainingMs); bestAgeMs=Math.min(bestAgeMs??Infinity,result.ageMs); }
        }
      } catch { errors++; candidates=0;earliestExpiryMs=null;bestAgeMs=null;rejected['inspection-error']=1; }
      return {position:code,registered:!!c,candidates,earliestExpiryMs,youngestAgeMs:bestAgeMs,
        rejected,counters:{...counters,submitted:stats.get(code).submitted}};
    });
    let cacheEnabled=null;try{cacheEnabled=pbjs.getConfig('useBidCache')===true;}catch{}
    return {profile:'bid-readiness-observer-1.0.0',mode:'observe-only',prebidVersion:pbjs.version,
      cacheEnabled,maxAgeSeconds,renderBudgetSeconds,stopped,capacityReached,errors,
      nativeSelectionVerified:false,guaranteedAds:null,trackedBids:bids.size,trackedAuctions:auctions.size,
      rows,notes:['Candidates passed local screening; native targeting and GAM have not selected them.',
        'Cache mode and refresh schedule are unchanged. Candidate counts do not enable cached reuse.',
        'Render succeeded is a Prebid event, not proof of a billable impression.',
        'Only auctions observed since installation are counted; no historical reconstruction.']};
  }
  function stop() {
    if(stopped)return;stopped=true;
    for(const [name,cb] of hooks)try{pbjs.offEvent(name,cb);}catch{}
    for(const [name,cb] of gptHooks)try{service.removeEventListener(name,cb);}catch{}
  }
  return Object.freeze({snapshot,stop});
}
