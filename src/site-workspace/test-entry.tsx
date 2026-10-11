import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import DealsPanel from '../components/DealsPanel';
import OutstreamSettingsPanel from '../components/OutstreamSettingsPanel';
import '../ad-units.css';
import '../publisher-workflows.css';
import SiteRuntimePanel from '../components/SiteRuntimePanel';
import ScriptSetupPanel from '../components/ScriptSetupPanel';
import SitePackagesPanel from '../components/SitePackagesPanel';
import SiteTestPagePanel from '../components/SiteTestPagePanel';
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
function Workspace() {
  const [view,setView]=useState<'versions'|'positions'|'packages'|'test-page'|'deals'|'formats'>(()=>window.location.hash==='#test-page'?'test-page':['#packages','#workflow'].includes(window.location.hash)?'packages':'versions');
  return <main style={{maxWidth:1000,margin:'24px auto',padding:16}}>
    <h1>Tessera · TEST site workspace</h1><p>This workspace uses your saved TEST copy. Production sites are unchanged.</p>
    <nav className="runtime-actions">
      <a href="/api-integrations">API integracije</a>
      <button onClick={()=>setView('versions')}>Script setup</button><button onClick={()=>setView('positions')}>Ad positions</button>
      <a href="/site-settings">Units and size maps</a><a href="/prebid-settings">Prebid and bidders</a><button onClick={()=>setView('packages')}>Generate and releases</button>
      <button onClick={()=>setView('deals')}>Deals</button><button onClick={()=>setView('formats')}>Formats</button>
      <button onClick={()=>setView('test-page')}>Test page</button>
    </nav>
    {view==='deals'?<div className="site-runtime-panel"><DealsPanel publisherId="test-site" endpoint="/test-api/deals"/></div>:view==='formats'?<Formats/>:view==='test-page'?<SiteTestPagePanel publisherId="test-site" endpoint="/test-api/site-packages" testOnly/>:view==='packages'?<SitePackagesPanel publisherId="test-site" endpoint="/test-api/site-packages" settingsEndpoint="/test-api/site-runtime" onNavigate={destination=>{if(destination==='prebid')window.location.assign('/prebid-settings');else setView('versions');}}/>:view==='versions'?<ScriptSetupPanel publisherId="test-site" endpoint="/test-api/site-runtime" onOpenPrebid={()=>window.location.assign('/prebid-settings')} onContinue={()=>setView('packages')}/>:<SiteRuntimePanel key={view} publisherId="test-site" endpoint="/test-api/site-runtime" view={view} onOpenPrebid={()=>window.location.assign('/prebid-settings')}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Workspace/>);
