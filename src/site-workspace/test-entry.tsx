import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import SiteRuntimePanel from '../components/SiteRuntimePanel';
import SitePackagesPanel from '../components/SitePackagesPanel';
import SiteWorkflowPanel from '../components/SiteWorkflowPanel';
function Workspace() {
  const [view,setView]=useState<'versions'|'positions'|'packages'|'workflow'>(()=>window.location.hash==='#workflow'?'workflow':'versions');
  return <main style={{maxWidth:1000,margin:'24px auto',padding:16}}>
    <h1>Tessera · TEST site workspace</h1><p>This workspace uses your saved TEST copy. Production sites are unchanged.</p>
    <nav className="runtime-actions">
      <button onClick={()=>setView('workflow')}>Build workflow</button>
      <button onClick={()=>setView('versions')}>Script versions</button><button onClick={()=>setView('positions')}>Ad positions</button>
      <a href="/site-settings">Units and size maps</a><a href="/prebid-settings">Prebid and bidders</a><button onClick={()=>setView('packages')}>Generate and releases</button>
    </nav>
    {view==='workflow'?<SiteWorkflowPanel publisherId="test-site" runtimeEndpoint="/test-api/site-runtime" packagesEndpoint="/test-api/site-packages" onNavigate={destination=>{
      if(destination==='settings'||destination==='prebid') window.location.assign(destination==='settings'?'/site-settings':'/prebid-settings');
      else setView(destination==='versions'?'versions':'packages');
    }}/>:view==='packages'?<SitePackagesPanel publisherId="test-site" endpoint="/test-api/site-packages"/>:<SiteRuntimePanel key={view} publisherId="test-site" endpoint="/test-api/site-runtime" view={view}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Workspace/>);
