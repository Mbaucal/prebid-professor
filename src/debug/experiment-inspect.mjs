// Self-contained console command. Reads diagnostics; never starts an auction,
// sets targeting, refreshes a slot, or exports diagnostics to the network.
export function inspectExperiments() {
  const clean = value => typeof value === 'string' ? value.slice(0,180) : null;
  const url = value => { try { const u=new URL(value);return /^https?:$/.test(u.protocol)?u.origin+u.pathname:null; } catch { return null; } };
  const scripts=Array.from(document.scripts||[]).filter(s=>/\/(?:ads(?:\.min)?|prebid)\.js(?:[?#]|$)/.test(s.src)).slice(0,100)
    .map(s=>({url:url(s.src),integrity:clean(s.integrity),evidence:'tag-present; execution unknown'}));
  const experiments=Object.values(window.__tesseraExperiments||{}).slice(0,20).map(state=>{
    const c=state.context||{}, snapshot=typeof state.snapshot==='function'?state.snapshot():{};
    const identity={};
    for(const key of ['siteId','experimentId','variant','packageSha256','deliverySha256','runtimeVersion','prebidVersion'])identity[key]=clean(c[key]);
    return {...identity,revision:Number.isSafeInteger(c.revision)?c.revision:null,active:c.active===true,status:clean(state.status),
      loaderAttempts:Number.isSafeInteger(snapshot.loaderAttempts)?snapshot.loaderAttempts:null,
      blockedDuplicates:Number.isSafeInteger(snapshot.blockedDuplicates)?snapshot.blockedDuplicates:null,
      collection:snapshot.collection?{status:clean(snapshot.collection.status),attempts:Number.isSafeInteger(snapshot.collection.attempts)?snapshot.collection.attempts:null,acknowledgedTypes:(snapshot.collection.acknowledgedTypes||[]).slice(0,4).map(clean),pendingTypes:(snapshot.collection.pendingTypes||[]).slice(0,4).map(clean)}:null,
      events:(snapshot.events||[]).slice(0,100).map(e=>({type:clean(e.type),elapsedMs:Number.isFinite(e.elapsedMs)?e.elapsedMs:null})),
      matchingPackageTags:scripts.filter(s=>s.url?.includes('/releases/'+c.packageSha256+'/')).length};
  });
  const runtimeDiagnostics=Object.values(window.__tesseraRuntimeDiagnostics||{}).slice(0,20).map(d=>{
    const s=typeof d.snapshot==='function'?d.snapshot():{};
    const safeNumber=v=>Number.isFinite(v)&&v>=0?v:null;
    const totals={};for(const k of ['requests','renders','empty','filled','iframeLoads','viewableEvents','ambiguousRenders'])totals[k]=safeNumber(s.totals?.[k]);
    return {siteId:clean(s.siteId),runtimeVersion:clean(s.runtimeVersion),runtimeEntries:safeNumber(s.initializations),attempts:safeNumber(s.attempts),blockedDuplicates:safeNumber(s.blockedDuplicates),stopped:s.stopped===true,firstFilledRenderMs:safeNumber(s.firstFilledRenderMs),totals,droppedEvents:safeNumber(s.droppedEvents),events:(s.events||[]).slice(0,100).map(e=>({type:clean(e.type),slot:clean(e.slot),elapsedMs:safeNumber(e.elapsedMs),requestToRenderMs:safeNumber(e.requestToRenderMs)}))};
  });
  const gamMeasurement=Object.entries(window.__tesseraGamMeasurement||{}).slice(0,20).map(([siteId,d])=>{
    const s=typeof d.snapshot==='function'?d.snapshot():{};
    return {siteId:clean(siteId),runtimeVersion:clean(s.runtimeVersion),key:clean(s.key),value:clean(s.value),
      deliverySha256:clean(s.identity?.deliverySha256),variant:clean(s.identity?.variant),
      appliedSlots:Number.isSafeInteger(s.appliedSlots)?s.appliedSlots:null,
      failedSlots:Number.isSafeInteger(s.failedSlots)?s.failedSlots:null};
  });
  const readSnapshot=d=>{try{return typeof d?.snapshot==='function'?d.snapshot():null;}catch{return null;}};
  function cacheSummary(s) {
    const p=s.policy||{};
    const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
    const pick=(value,keys)=>Object.fromEntries(keys.map(k=>[k,count(value?.[k])]));
    const mode=['fresh-only','auction-with-cache'].includes(s.mode)?s.mode:null;
    const last=p.lastSelection;
    return {siteId:clean(s.siteId),runtimeVersion:clean(s.runtimeVersion),mode,maxAgeSeconds:count(s.maxAgeSeconds),stopped:s.stopped===true,
      trackedSlots:count(s.trackedSlots),totals:pick(s.totals,['auctions','submissionAttempts','fallbacks','blocked','lateCallbacks','errors']),
      contextEpoch:count(s.consent?.epoch),cacheContextReady:s.consent?.cacheAllowed===true,
      capacityBlocked:p.capacityBlocked===true,trackedAuctions:count(p.trackedAuctions),trackedSubmittedBids:count(p.trackedSubmittedBids),
      selections:pick(p.selections,['fresh','cache','none','errors','blockedDuplicates']),
      filterChecks:{accepted:count(p.checks?.accepted),rejected:pick(p.checks?.rejected,['disabled','consent','capacity','format','used','untracked','context','size','expired'])},
      lastSelection:last?{code:clean(last.code),origin:['fresh','cache','none','error'].includes(last.origin)?last.origin:null,ageMs:count(last.ageMs),
        reason:['clear-targeting','context-changed','configuration-changed','native-targeting','targeting-status'].includes(last.reason)?last.reason:null}:null};
  }
  const cacheDiagnostics=Object.values(window.__tesseraBidCache||{}).slice(0,20).map(readSnapshot).filter(Boolean).map(cacheSummary);
  let staticDelivery=null,staticCache=null,bidReadiness=null,deliverySnapshot=null;
  const number=v=>Number.isFinite(v)&&v>=0?v:null;
  try {
    const s=deliverySnapshot=readSnapshot(window.AdVariant);
    if(s)staticDelivery={release:clean(s.release),variant:['A','B'].includes(s.variant)?s.variant:null,status:clean(s.status),
      deliveryMode:['single','ab'].includes(s.deliveryMode)?s.deliveryMode:null,
      scriptRelease:clean(s.scriptRelease),scriptName:clean(s.scriptName),testName:clean(s.testName),
      script:url(s.script),scriptSha256:/^[a-f0-9]{64}$/.test(s.scriptSha256)?s.scriptSha256:null,
      mode:['fresh-only','auction-with-cache'].includes(s.mode)?s.mode:null,
      trafficBPercent:Number.isInteger(s.trafficBPercent)&&s.trafficBPercent>=0&&s.trafficBPercent<=100?s.trafficBPercent:null,
      configuredRefreshSeconds:Number.isInteger(s.refreshSeconds)&&s.refreshSeconds>=1&&s.refreshSeconds<=7200?s.refreshSeconds:null,
      refreshSetting:s.refreshSeconds===null?'baseline-position-rules':Number.isInteger(s.refreshSeconds)&&s.refreshSeconds>=1&&s.refreshSeconds<=7200?'fixed-standard-interval':'unavailable',
      configuredMaxBidAgeSeconds:Number.isInteger(s.maxBidAgeSeconds)&&s.maxBidAgeSeconds>=1&&s.maxBidAgeSeconds<=300?s.maxBidAgeSeconds:null,
      prebidVersion:clean(s.prebidVersion),runtimeEntries:number(s.runtimeEntries),
      blockedDuplicateLoaders:number(s.blockedDuplicateLoaders),blockedRuntimeEntries:number(s.blockedRuntimeEntries),
      appliedSlots:number(s.appliedSlots),targetingFailures:number(s.targetingFailures),
      slots:(Array.isArray(s.slots)?s.slots:[]).slice(0,100).map(r=>({position:clean(r.position),Variant:['A','B'].includes(r.Variant)?r.Variant:null}))};
  }catch{}
  try {
    const s=readSnapshot(window.AdBidCache)||deliverySnapshot?.bidCache;
    if(s)staticCache={...cacheSummary(s),status:s.stopped===true?'stopped':s.policy?'active':'waiting'};
    else staticCache={status:staticDelivery?.mode==='fresh-only'?'not-enabled':'unavailable'};
  }catch{staticCache={status:'unavailable'};}
  try {
    const s=window.AdBidReadiness?.snapshot?.();
    if(s?.profile==='bid-readiness-observer-1.0.0'){
      const reasons=['capacity','context-changed','consent-unavailable','bid-unavailable','already-used','history-unavailable',
        'auction-pending','size-or-format','currency','floor','creative-unavailable','invalid-lifetime','expired-or-too-close',
        'custom-selection-unverified','inspection-error','stopped'];
      bidReadiness={profile:s.profile,mode:'observe-only',cacheEnabled:s.cacheEnabled===true,stopped:s.stopped===true,
        capacityReached:s.capacityReached===true,errors:number(s.errors),maxAgeSeconds:number(s.maxAgeSeconds),
        renderBudgetSeconds:number(s.renderBudgetSeconds),nativeSelectionVerified:false,guaranteedAds:null,
        error:s.error==='observer-unavailable'?s.error:null,
        rows:(Array.isArray(s.rows)?s.rows:[]).slice(0,100).map(r=>({position:clean(r.position),candidates:number(r.candidates),
          earliestExpiryMs:number(r.earliestExpiryMs),rejected:Object.fromEntries(reasons.filter(k=>r.rejected?.[k]>0).map(k=>[k,number(r.rejected[k])])),
          counters:Object.fromEntries(['received','submitted','bidWon','renderSucceeded','renderFailed','gamRequests','gamFilled','gamEmpty'].map(k=>[k,number(r.counters?.[k])]))}))};
    }
  }catch{}
  const report={schemaVersion:1,experiments,scripts,runtimeDiagnostics,gamMeasurement,cacheDiagnostics,staticDelivery,staticCache,bidReadiness,observedPrebidVersion:clean(window.pbjs?.version),
    runtimeMarkerPresent:!!window.__TESSERA_RUNTIME_STARTED,
    confirmedRuntimeExecutions:null,
    notes:['Script tags and load events do not prove runtime initialization or impressions.',
      'Collection acknowledgement confirms receipt of reported events, not complete page coverage.',
      'GAM measurement shows local targeting configuration, not confirmation of GAM reporting or revenue.',
      'Cache selections are targeting decisions, not rendered ads or revenue; filter evaluations are not unique cache hits.',
      'Fresh-only mode does not install a cache inspector. Unavailable means there is no readable cache snapshot, not zero cache usage.',
      'A none selection means no Prebid offer was targeted; GAM may still fill the request from other demand.',
      'Readiness candidates passed local screening only; they are not a native selection, guaranteed ads, or permission to refresh.',
      'Total execution count is unknown for uninstrumented runtimes; runtimeEntries counts entry into the new runtime, not successful auctions.',
      'Load errors alone cannot distinguish SRI, CSP and network failures. Check browser Console/Network.',
      'No experiment records may mean a legacy loader or no experiment; it does not prove no script ran.']};
  console.group('[Tessera] A/B inspect');console.table(experiments.map(({events,...row})=>row));
  if(staticDelivery){const {slots,...summary}=staticDelivery;console.table([summary]);if(slots.length)console.table(slots);}
  for(const s of [...cacheDiagnostics,staticCache].filter(Boolean)){
    console.group('Bid cache');
    console.table([{status:s.status||'available',mode:s.mode||null,maxAgeSeconds:s.maxAgeSeconds??null,cacheContextReady:s.cacheContextReady??null,...s.selections}]);
    if(s.totals)console.table([s.totals]);
    if(s.filterChecks)console.table(Object.entries(s.filterChecks.rejected).filter(([,count])=>count>0).map(([reason,count])=>({reason,count})));
    if(s.lastSelection)console.table([s.lastSelection]);
    console.groupEnd();
  }
  if(bidReadiness)console.table(bidReadiness.rows);
  console.table(scripts);console.log(report);console.groupEnd();
  window.__TESSERA_AB_DEBUG=report;
  try { if(typeof copy==='function')copy(JSON.stringify(report,null,2)); } catch { /* manual copy remains available */ }
  return report;
}
export const experimentInspectCommand='('+inspectExperiments.toString()+')();';
