// Self-contained console command. Reads only; no network, auctions or CMP calls.
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
  const report={schemaVersion:1,experiments,scripts,runtimeDiagnostics,gamMeasurement,observedPrebidVersion:clean(window.pbjs?.version),
    runtimeMarkerPresent:!!window.__TESSERA_RUNTIME_STARTED,
    confirmedRuntimeExecutions:null,
    notes:['Script tags and load events do not prove runtime initialization or impressions.',
      'GAM measurement shows local targeting configuration, not confirmation of GAM reporting or revenue.',
      'Total execution count is unknown for uninstrumented runtimes; runtimeEntries counts entry into the new runtime, not successful auctions.',
      'Load errors alone cannot distinguish SRI, CSP and network failures. Check browser Console/Network.',
      'No experiment records may mean a legacy loader or no experiment; it does not prove no script ran.']};
  console.group('[Tessera] A/B inspect');console.table(experiments.map(({events,...row})=>row));console.table(scripts);console.log(report);console.groupEnd();
  window.__TESSERA_AB_DEBUG=report;
  try { if(typeof copy==='function')copy(JSON.stringify(report,null,2)); } catch { /* manual copy remains available */ }
  return report;
}
export const experimentInspectCommand='('+inspectExperiments.toString()+')();';
