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
  const report={schemaVersion:1,experiments,scripts,observedPrebidVersion:clean(window.pbjs?.version),
    runtimeMarkerPresent:!!window.__TESSERA_RUNTIME_STARTED,
    confirmedRuntimeExecutions:null,
    notes:['Script tags and load events do not prove runtime initialization or impressions.',
      'Execution count is unknown: existing runtimes do not expose a trustworthy counter.',
      'Load errors alone cannot distinguish SRI, CSP and network failures. Check browser Console/Network.',
      'No experiment records may mean a legacy loader or no experiment; it does not prove no script ran.']};
  console.group('[Tessera] A/B inspect');console.table(experiments.map(({events,...row})=>row));console.table(scripts);console.log(report);console.groupEnd();
  window.__TESSERA_AB_DEBUG=report;
  try { if(typeof copy==='function')copy(JSON.stringify(report,null,2)); } catch { /* manual copy remains available */ }
  return report;
}
export const experimentInspectCommand='('+inspectExperiments.toString()+')();';
