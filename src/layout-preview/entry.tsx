import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import AppFrame, { WorkspaceContent } from '../components/AppFrame';
import '../dashboard-styles';

// A review surface with synthetic examples only: no API client, saves or publishing.
const sections = ['Publishers', 'Releases', 'Prebid builds', 'API integracije', 'Creative templates', 'Audit log', 'Settings'];
const tabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Mockup', 'Monitoring', 'Debug', 'Ads.txt'];
const publishers = Array.from({ length: 12 }, (_, i) => ({ name: `Example Publisher ${i + 1}`, domain: `site${i + 1}.example.com` }));

function LayoutPreview() {
  const [section, setSection] = useState('Publishers');
  const [tab, setTab] = useState('Overview');
  const [selected, setSelected] = useState(0);
  const [dialog, setDialog] = useState(false);
  const site = publishers[selected];
  const account = <aside className="auth-account-card" aria-label="Preview account">
    <div className="auth-account-avatar">E</div><div className="auth-account-identity"><span>Example admin</span><small>TEST · layout preview</small></div>
    <button title="About this preview" onClick={() => setDialog(true)}>?</button><a href="/" title="Return to TEST" style={{ color: '#d9dee8' }}>↪</a>
  </aside>;

  return <AppFrame account={account} logoSrc="/layout-preview-logo.png"
    navigation={<nav className="main-nav" aria-label="Main navigation">{sections.map(item => <button key={item} className={`nav-item${section === item ? ' active' : ''}`} onClick={() => setSection(item)}>{item}</button>)}</nav>}
    sidebarContent={<div className="publisher-nav publisher-tree"><div className="section-label">Publishers</div>{publishers.map((publisher, i) => <div key={publisher.domain} className="publisher-tree-group">
      <div className="publisher-account-row"><button className={`publisher-account-link${selected === i ? ' active' : ''}`} onClick={() => { setSelected(i); setSection('Publishers'); }}><span>{publisher.name}</span><small>1</small></button><button className="publisher-account-edit" aria-label={`Preview ${publisher.name}`} onClick={() => setDialog(true)}>✎</button></div>
      <div className="publisher-site-list"><button className={`site-link${selected === i ? ' active' : ''}`} onClick={() => { setSelected(i); setSection('Publishers'); }}><span>{publisher.domain}</span><small>DRAFT</small></button></div>
    </div>)}</div>}>
    <main className="workspace">
      <header className={`topbar${section === 'Publishers' ? '' : ' global-topbar'}`}><div>
        <span className="eyebrow">TEST / Pregled rasporeda / {section === 'Publishers' ? site.name : section}</span>
        <h1>{section === 'Publishers' ? site.domain : section}</h1>
        <div className="publisher-meta"><span className="status-badge draft">Primeri</span><span>Skroluj sadržaj i listu publishera nezavisno.</span></div>
      </div><div className="top-actions"><button className="button secondary" onClick={() => setDialog(true)}>O pregledu</button><a className="button secondary" href="/">Nazad na TEST</a></div></header>
      {section === 'Publishers' && <section className="tabbar" aria-label="Site sections">{tabs.map(item => <button key={item} className={`tab${tab === item ? ' active' : ''}`} onClick={() => setTab(item)}>{item}</button>)}</section>}
      <WorkspaceContent pageKey={`${section}:${selected}:${tab}`}>
        <section className="content-grid">
          <article className="panel overview-panel"><div className="panel-heading"><div><span className="panel-kicker">{section === 'Publishers' ? tab : section}</span><h2>{site.name}</h2></div><span className="health-pill healthy">TEST pregled</span></div>
            <p>Zaglavlje i tabovi ostaju na mestu dok se sadržaj ispod njih skroluje. Meni sa leve strane ima svoju listu i nalog pri dnu.</p>
            <div className="publisher-facts">{[['Publisher ID', 'example-publisher'], ['Status', 'draft'], ['Domain', site.domain], ['GAM path', '/123456/example.com/']].map(([label, value]) => <div key={label}><span>{label}</span><code>{value}</code></div>)}</div>
            <div className="site-overview-card"><span className="panel-kicker">Active site</span><h2>{site.domain}</h2><p>Svi podaci na ovom ekranu su primeri za pregled rasporeda.</p></div>
          </article>
          <article className="panel api-panel"><span className="panel-kicker">Current selection</span><h2>Publisher → Site</h2><pre>{JSON.stringify({ publisher: site.name, site: site.domain, layout: 'fixed viewport', content: 'independent scroll', sidebar: 'independent scroll', data: 'examples only' }, null, 2)}</pre></article>
          {Array.from({ length: 10 }, (_, i) => <article className="panel overview-panel" key={i}><span className="panel-kicker">Primer sadržaja {i + 1}</span><h2>{section === 'Publishers' ? tab : section}</h2><p>Duži sadržaj za proveru skrolovanja. Tamna pozadina levog menija ostaje do dna prozora, bez preklapanja sa nalogom.</p><div className="publisher-facts"><div><span>Domain</span><code>{site.domain}</code></div><div><span>Status</span><code>Example</code></div></div></article>)}
        </section>
      </WorkspaceContent>
    </main>
    {dialog && <div className="modal-backdrop"><section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="preview-title"><div className="modal-heading"><h2 id="preview-title">Pregled rasporeda</h2><button autoFocus className="icon-button" aria-label="Close preview dialog" onClick={() => setDialog(false)}>×</button></div><div style={{ padding: 24 }}>Ovo je pregled izgleda sa generičkim podacima. Podešavanja sajtova se ovde ne menjaju.</div></section></div>}
  </AppFrame>;
}

createRoot(document.getElementById('root')!).render(<LayoutPreview />);
