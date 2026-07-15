import { useEffect, useMemo, useState } from 'react';

type HealthResponse = {
  ok: boolean;
  service: string;
  environment: string;
  timestamp: string;
};

type Publisher = {
  id: string;
  name: string;
  domain: string;
  status: 'live' | 'staging';
  version: string;
  updatedAt: string;
};

const publishers: Publisher[] = [
  {
    id: 'politika',
    name: 'Politika.rs',
    domain: 'politika.rs',
    status: 'live',
    version: '20260714_122757',
    updatedAt: 'Jul 14, 12:27',
  },
  {
    id: 'magazin-politika',
    name: 'Magazin Politika',
    domain: 'magazin.politika.rs',
    status: 'live',
    version: '20260713_184200',
    updatedAt: 'Jul 13, 18:42',
  },
  {
    id: 'zurnal',
    name: 'Žurnal',
    domain: 'zurnal.rs',
    status: 'staging',
    version: 'draft',
    updatedAt: 'Jul 12, 09:10',
  },
];

const navItems = ['Publishers', 'Releases', 'Prebid builds', 'Audit log', 'Settings'];

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [activePublisher, setActivePublisher] = useState('politika');

  useEffect(() => {
    let cancelled = false;

    fetch('/api/health')
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Health endpoint returned ${response.status}`);
        }

        return (await response.json()) as HealthResponse;
      })
      .then((payload) => {
        if (!cancelled) {
          setHealth(payload);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHealthError(error instanceof Error ? error.message : 'Health check failed');
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const publisher = useMemo(
    () => publishers.find((item) => item.id === activePublisher) ?? publishers[0],
    [activePublisher],
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">PP</div>
          <div>
            <strong>Prebid Professor</strong>
            <span>Ad-tech control plane</span>
          </div>
        </div>

        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map((item, index) => (
            <button className={index === 0 ? 'nav-item active' : 'nav-item'} key={item} type="button">
              {item}
            </button>
          ))}
        </nav>

        <div className="publisher-nav">
          <div className="section-label">Publishers</div>
          {publishers.map((item) => (
            <button
              className={item.id === activePublisher ? 'publisher-link active' : 'publisher-link'}
              key={item.id}
              onClick={() => setActivePublisher(item.id)}
              type="button"
            >
              <span>{item.name}</span>
              <small className={item.status}>{item.status}</small>
            </button>
          ))}
          <button className="publisher-link muted" type="button">
            <span>＋ New publisher</span>
          </button>
        </div>

        <div className="account-card">
          <div className="avatar">S</div>
          <div>
            <strong>srdjan</strong>
            <span>admin · Cloudflare Access</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Publishers / {publisher.name}</span>
            <h1>{publisher.name}</h1>
            <div className="publisher-meta">
              <span className={`status-badge ${publisher.status}`}>● {publisher.status}</span>
              <code>v {publisher.version}</code>
              <span>{publisher.domain}</span>
              <span>Updated {publisher.updatedAt}</span>
            </div>
          </div>

          <div className="top-actions">
            <button className="button secondary" type="button">Validate</button>
            <button className="button secondary" type="button">Generate</button>
            <button className="button primary" type="button">Publish ↗</button>
          </div>
        </header>

        <section className="tabbar" aria-label="Publisher sections">
          {['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Debug', 'Ads.txt'].map((item, index) => (
            <button className={index === 0 ? 'tab active' : 'tab'} key={item} type="button">
              {item}
            </button>
          ))}
        </section>

        <section className="content-grid">
          <article className="panel overview-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Platform status</span>
                <h2>Foundation is ready</h2>
              </div>
              <span className={health?.ok ? 'health-pill healthy' : 'health-pill'}>
                {health?.ok ? 'API healthy' : healthError ? 'API error' : 'Checking API…'}
              </span>
            </div>

            <p>
              The React dashboard and Cloudflare Worker now deploy as one application. The next step is
              connecting D1 and R2, then replacing mock publisher data with real records.
            </p>

            <div className="milestone-list">
              <div className="milestone complete">
                <span>1</span>
                <div><strong>Repository scaffold</strong><small>React, Vite and Worker API</small></div>
              </div>
              <div className="milestone next">
                <span>2</span>
                <div><strong>Cloudflare resources</strong><small>Create D1 and R2 bindings</small></div>
              </div>
              <div className="milestone">
                <span>3</span>
                <div><strong>Publisher data</strong><small>CRUD, duplication and audit log</small></div>
              </div>
              <div className="milestone">
                <span>4</span>
                <div><strong>Generate and publish</strong><small>Versioned release artifacts</small></div>
              </div>
            </div>
          </article>

          <article className="panel api-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Worker API</span>
                <h2>/api/health</h2>
              </div>
            </div>
            <pre>{JSON.stringify(health ?? { ok: false, error: healthError ?? 'Loading…' }, null, 2)}</pre>
          </article>

          <article className="panel stats-panel">
            <div className="stat"><strong>3</strong><span>Publishers</span></div>
            <div className="stat"><strong>0</strong><span>Production releases</span></div>
            <div className="stat"><strong>0</strong><span>Prebid builds</span></div>
            <div className="stat"><strong>0</strong><span>Blocking issues</span></div>
          </article>

          <article className="panel ads-txt-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Ads.txt checker</span>
                <h2>Simple status model</h2>
              </div>
              <span className="ok-badge">✅ OK</span>
            </div>
            <p>When required lines are missing, the dashboard will show only the missing full entries.</p>
            <pre>{`❌ Missing\n\n# Criteo\ncriteo.com, 213, RESELLER, 9fac4a4a87c2a44f`}</pre>
          </article>
        </section>
      </main>
    </div>
  );
}

export default App;
