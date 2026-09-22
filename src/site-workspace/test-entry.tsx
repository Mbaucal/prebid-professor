import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import SiteRuntimePanel from '../components/SiteRuntimePanel';
import SitePackagesPanel from '../components/SitePackagesPanel';
function Workspace() {
  const [view,setView]=useState<'versions'|'positions'|'packages'>(()=>['#packages','#workflow'].includes(window.location.hash)?'packages':'versions');
  return <main style={{maxWidth:1000,margin:'24px auto',padding:16}}>
    <h1>Tessera · TEST site workspace</h1><p>This workspace uses your saved TEST copy. Production sites are unchanged.</p>
    <nav className="runtime-actions">
      <a href="/api-integrations">API integracije</a><a href="/creative-templates">Creative templates</a>
      <button onClick={()=>setView('versions')}>Script versions</button><button onClick={()=>setView('positions')}>Ad positions</button>
      <a href="/site-settings">Units and size maps</a><a href="/prebid-settings">Prebid and bidders</a><button onClick={()=>setView('packages')}>Generate and releases</button>
    </nav>
    {view==='packages'?<SitePackagesPanel publisherId="test-site" endpoint="/test-api/site-packages" onNavigate={destination=>{if(destination==='prebid')window.location.assign('/prebid-settings');else setView('versions');}}/>:<SiteRuntimePanel key={view} publisherId="test-site" endpoint="/test-api/site-runtime" view={view} onOpenPrebid={()=>window.location.assign('/prebid-settings')}/>}
  </main>;
}
createRoot(document.getElementById('root')!).render(<Workspace/>);
