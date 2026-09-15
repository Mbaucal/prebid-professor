import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import SiteRuntimePanel from '../components/SiteRuntimePanel';
function Workspace(){const [view,setView]=useState<'versions'|'positions'>('versions');return <main style={{maxWidth:1000,margin:'24px auto',padding:16}}><h1>Tessera · TEST site workspace</h1><p>This workspace uses your saved TEST copy. Production sites are unchanged.</p><nav className="runtime-actions"><button onClick={()=>setView('versions')}>Script versions</button><button onClick={()=>setView('positions')}>Ad positions</button><a href="/site-settings">Units and size maps</a><a href="/prebid-settings">Prebid and bidders</a><a href="/">Saved TEST packages</a></nav><SiteRuntimePanel key={view} publisherId="test-site" endpoint="/test-api/site-runtime" view={view}/></main>;}
createRoot(document.getElementById('root')!).render(<Workspace/>);
