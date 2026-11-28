import ContextualSignalsPanel from '../components/ContextualSignalsPanel';
import BidderRulesPanel from '../components/BidderRulesPanel';
import {contextualSignalsInspectCommand} from '../debug/contextual-signals-inspect.mjs';
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import DealsPanel from '../components/DealsPanel';
import OutstreamSettingsPanel from '../components/OutstreamSettingsPanel';
import UnitRulesPanel from '../components/UnitRulesPanel';
import '../ad-units.css';
import '../publisher-workflows.css';
import '../unit-rules.css';
import './test-unit-rules.css';
import SiteRuntimePanel from '../components/SiteRuntimePanel';
import ScriptSetupPanel from '../components/ScriptSetupPanel';
import SitePackagesPanel from '../components/SitePackagesPanel';
import SiteTestPagePanel from '../components/SiteTestPagePanel';
import SiteLoadingSummaryPanel from '../components/SiteLoadingSummaryPanel';
import PrebidModePanel from '../components/PrebidModePanel';
import PositionBidCachePanel,{fetchBidCacheSettings,type BidCachePayload} from '../components/PositionBidCachePanel';
import '../prebid-mode.css';
/** The production Demand → Prebid bid cache settings and per-position choices, for the TEST site. */
function BidCache() {
  const [data,setData]=useState<BidCachePayload|null>(null),[error,setError]=useState(''),[code,setCode]=useState<string|null>(null),[attempt,setAttempt]=useState(0),[panelKey,setPanelKey]=useState(0),[positionSaved,setPositionSaved]=useState(false);
  useEffect(()=>{let active=true;setError('');fetchBidCacheSettings('test-site').then(next=>{if(active)setData(next);}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not load bid cache settings.');});return()=>{active=false;};},[attempt]);
  return <><PrebidModePanel key={panelKey} testOnly positionsLabel="Bid cache by position below" modeLocked="Turn Prebid on or off in Prebid and bidders. Here you can change bid caching only." publisherId="test-site" onChanged={()=>setAttempt(value=>value+1)}/>
    <section className="site-runtime-panel" aria-labelledby="test-bid-cache-heading"><h2 id="test-bid-cache-heading">Bid cache by position</h2>
    <p>Enabled ATF and BTF Banner positions can reuse bids. TakeOver and Outstream positions always use the current auction. Change positions in Units and size maps or Formats.</p>
    {error?<p role="alert" className="runtime-error">{error} <button onClick={()=>setAttempt(value=>value+1)}>Reload bid cache settings</button></p>:!data?<p role="status">Loading bid cache settings…</p>:!data.bidCachePositions.length?<p>No position can reuse bids now.</p>:<div className="runtime-actions">{data.bidCachePositions.map(position=>{
      const enabled=data.prebidMode.bidCache.positionOverrides?.[position]??data.prebidMode.bidCache.enabled;
      return <button key={position} onClick={()=>setCode(position)}>{position} · Bid cache: {!data.prebidMode.enabled?'Inactive':enabled?'On':'Off'}</button>;
    })}</div>}
    {code?<PositionBidCachePanel testOnly key={code} publisherId="test-site" code={code} onClose={()=>{setCode(null);setAttempt(value=>value+1);
      // A saved position changes the site's saved settings: reload the form above so it shows them and saves against them.
      if(positionSaved){setPositionSaved(false);setPanelKey(value=>value+1);}}} onSaved={next=>{setData(next);setPositionSaved(true);}}/>:null}
  </section></>;
}
function Formats() {
  const [units,setUnits]=useState<Array<{code:string;enabled:boolean;sizeMap:string}>|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(true),[attempt,setAttempt]=useState(0),[selected,setSelected]=useState<string|null>(null);
  useEffect(()=>{let active=true;setBusy(true);setError('');fetch('/test-api/site-settings',{credentials:'same-origin',cache:'no-store'}).then(async response=>{const data=await response.json() as {draft?:{units:Array<{code:string;enabled:boolean;sizeMap:string}>};error?:string};if(!response.ok||!data.draft)throw Error(data.error||'Could not load TEST positions.');if(active)setUnits(data.draft.units);}).catch(error=>{if(active)setError(error instanceof Error?error.message:'Could not load TEST positions.');}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[attempt]);
  return <section className="site-runtime-panel" aria-labelledby="test-formats-heading"><h2 id="test-formats-heading">Formats</h2>
    <p>Choose Banner, Outstream or Banner + Outstream for a saved TEST position. Existing scripts and the publisher website stay unchanged.</p>
    {busy?<p role="status">Loading TEST positions…</p>:null}{error?<><p className="runtime-error" role="alert">{error}</p><button disabled={busy} onClick={()=>setAttempt(value=>value+1)}>Retry TEST positions</button></>:null}
    {!busy&&!error&&units?.map(unit=><div className="runtime-position" key={unit.code}><strong>{unit.code}</strong><p>Size map: {unit.sizeMap} · {unit.enabled?'Enabled':'Disabled'}</p><button onClick={()=>setSelected(unit.code)}>Configure formats for {unit.code}</button></div>)}
    {!busy&&!error&&!units?.length?<p>Add a position in Units and size maps first.</p>:null}
    {selected?<OutstreamSettingsPanel key={selected} publisherId="test-site" code={selected} endpoint="/test-api/outstream-settings" onClose={()=>setSelected(null)} onSaved={()=>{}}/>:null}
  </section>;
}
const bidderRulesInspectCommand=`(() => {
  const helper = window.__AD_BIDDER_RULES;
  if (!helper || typeof helper.snapshot !== 'function') {
    console.warn('Bidder rule diagnostics are unavailable. Select the top page frame and use a generated script with bidder rule support.');
    return null;
  }
  const report = helper.snapshot();
  console.log('Bidder rule decisions', report);
  return report;
})();`;
type View = 'versions'|'positions'|'packages'|'test-page'|'loading'|'deals'|'formats'|'rules'|'contextual-signals'|'bidder-rules'|'bid-cache';
function currentView(): View {
  const hash = window.location.hash.slice(1);
  if (hash === 'workflow') return 'packages';
  return ['positions', 'packages', 'test-page', 'loading', 'deals', 'formats', 'rules', 'contextual-signals', 'bidder-rules', 'bid-cache'].includes(hash) ? hash as View : 'versions';
}
function Workspace() {
  const [view,updateView]=useState<View>(currentView);
  useEffect(() => {
    const change = () => updateView(currentView());
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  function setView(next: View) { window.location.hash = next; updateView(next); }
  return <main style={{maxWidth:1000,margin:'24px auto',padding:16}}>
    <h1>Tessera · TEST site workspace</h1><p>This workspace uses your saved TEST copy. Production sites are unchanged.</p>
    <nav className="runtime-actions">
      <a href="/api-integrations">API integracije</a><a href="/creative-templates">Creative templates</a>
      <button onClick={()=>setView('versions')}>Script setup</button><button onClick={()=>setView('positions')}>Ad positions</button>
      <button onClick={()=>setView('rules')}>Unit rules</button>
      <a href="/site-settings">Units and size maps</a><a href="/prebid-settings">Prebid and bidders</a><button onClick={()=>setView('packages')}>Generate and releases</button>
      <button aria-current={view==='bid-cache'?'page':undefined} onClick={()=>setView('bid-cache')}>Bid caching</button>
      <button onClick={()=>setView('deals')}>Deals</button><button onClick={()=>setView('formats')}>Formats</button>
      <button aria-current={view==='loading'?'page':undefined} onClick={()=>setView('loading')}>Loading rules</button>
      <button aria-current={view==='contextual-signals'?'page':undefined} onClick={()=>setView('contextual-signals')}>Contextual signals</button>
      <button aria-current={view==='bidder-rules'?'page':undefined} onClick={()=>setView('bidder-rules')}>Bidder rules</button>
      <button onClick={()=>setView('test-page')}>Test page</button>
    </nav>
    {view==='bid-cache'?<BidCache/>:view==='bidder-rules'?<><BidderRulesPanel publisherId="test-site" endpoint="/test-api/bidder-rules"/><section className="site-runtime-panel"><h2>Bidder rule debug</h2><p>Copy this read-only command into the console on the page using your generated script. It shows recorded decisions without starting an auction or sending requests.</p><textarea aria-label="Bidder rules console command" readOnly value={bidderRulesInspectCommand} style={{width:'100%',minHeight:180,boxSizing:'border-box'}}/></section></>:view==='contextual-signals'?<><ContextualSignalsPanel publisherId="test-site" endpoint="/test-api/contextual-signals"/><section className="site-runtime-panel"><h2>Contextual signals / PPS debug</h2><p>Copy this read-only command into the console on the page using your generated script. It does not start an auction or confirm SSP acceptance.</p><textarea aria-label="Contextual signals console command" readOnly value={contextualSignalsInspectCommand()} style={{width:'100%',minHeight:180,boxSizing:'border-box'}}/></section></>:view==='rules'?<div className="test-unit-rules"><UnitRulesPanel publisherId="test-site"/></div>:view==='deals'?<div className="site-runtime-panel"><DealsPanel publisherId="test-site" endpoint="/test-api/deals"/></div>:view==='formats'?<Formats/>:view==='loading'?<SiteLoadingSummaryPanel endpoint="/test-api/site-runtime"/>:view==='test-page'?<SiteTestPagePanel publisherId="test-site" endpoint="/test-api/site-packages" testOnly/>:view==='packages'?<SitePackagesPanel publisherId="test-site" endpoint="/test-api/site-packages" settingsEndpoint="/test-api/site-runtime" onNavigate={destination=>{if(destination==='prebid')window.location.assign('/prebid-settings');else setView('versions');}}/>:view==='versions'?<ScriptSetupPanel publisherId="test-site" endpoint="/test-api/site-runtime" onOpenPrebid={()=>window.location.assign('/prebid-settings')} onContinue={()=>setView('packages')}/>:<SiteRuntimePanel key={view} publisherId="test-site" endpoint="/test-api/site-runtime" view={view} onOpenPrebid={()=>window.location.assign('/prebid-settings')}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Workspace/>);
