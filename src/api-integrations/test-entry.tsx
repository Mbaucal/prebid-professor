import {createRoot} from 'react-dom/client';
import ApiIntegrationsPanel from '../components/ApiIntegrationsPanel';
import './test-shell.css';
function TestIntegrations(){return <div className="gam-test-shell"><aside className="gam-test-sidebar"><a className="gam-test-brand" href="/">Tessera<span>TEST</span></a><nav aria-label="Glavna navigacija"><a href="/site-workspace">Publisher / sajt</a><a href="/api-integrations" aria-current="page">API integracije</a><a href="/creative-templates">Creative templates</a></nav><p>Radno okruženje za proveru novih funkcija.</p></aside><main><header className="gam-test-heading"><span>Tessera / API integracije</span><h1>API integracije</h1><p>Jedno mesto za povezivanje platformi i upravljanje API operacijama.</p></header><ApiIntegrationsPanel endpoint="/test-api/integrations/gam"/></main></div>}
createRoot(document.getElementById('root')!).render(<TestIntegrations/>);
