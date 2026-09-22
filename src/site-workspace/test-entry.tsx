import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import SiteRuntimePanel from '../components/SiteRuntimePanel';
import ScriptSetupPanel from '../components/ScriptSetupPanel';
import SitePackagesPanel from '../components/SitePackagesPanel';
import SiteTestPagePanel from '../components/SiteTestPagePanel';
import SiteLoadingSummaryPanel from '../components/SiteLoadingSummaryPanel';
type View = 'versions'|'positions'|'packages'|'test-page'|'loading';
function currentView(): View {
  const hash = window.location.hash.slice(1);
  if (hash === 'workflow') return 'packages';
  return ['positions', 'packages', 'test-page', 'loading'].includes(hash) ? hash as View : 'versions';
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
      <a href="/site-settings">Units and size maps</a><a href="/prebid-settings">Prebid and bidders</a><button onClick={()=>setView('packages')}>Generate and releases</button>
      <button aria-current={view==='loading'?'page':undefined} onClick={()=>setView('loading')}>Loading rules</button>
      <button onClick={()=>setView('test-page')}>Test page</button>
    </nav>
    {view==='loading'?<SiteLoadingSummaryPanel endpoint="/test-api/site-runtime"/>:view==='test-page'?<SiteTestPagePanel publisherId="test-site" endpoint="/test-api/site-packages" testOnly/>:view==='packages'?<SitePackagesPanel publisherId="test-site" endpoint="/test-api/site-packages" settingsEndpoint="/test-api/site-runtime" onNavigate={destination=>{if(destination==='prebid')window.location.assign('/prebid-settings');else setView('versions');}}/>:view==='versions'?<ScriptSetupPanel publisherId="test-site" endpoint="/test-api/site-runtime" onOpenPrebid={()=>window.location.assign('/prebid-settings')} onContinue={()=>setView('packages')}/>:<SiteRuntimePanel key={view} publisherId="test-site" endpoint="/test-api/site-runtime" view={view} onOpenPrebid={()=>window.location.assign('/prebid-settings')}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Workspace/>);
