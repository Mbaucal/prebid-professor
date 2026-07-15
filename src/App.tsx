import { useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { HealthResponse, Publisher } from './shared/types';

const fallbackPublishers: Publisher[] = [
  {
    id: 'politika',
    name: 'Politika.rs',
    domain: 'politika.rs',
    gamPath: '/23339552141/Politika.rs/',
    status: 'live',
    currentReleaseId: null,
    currentVersion: '20260714_122757',
    lastPublishedAt: '2026-07-14T12:27:57Z',
    adsTxtUrl: 'https://www.politika.rs/ads.txt',
    createdAt: '2026-07-14T12:27:57Z',
    updatedAt: '2026-07-14T12:27:57Z',
    adUnitsCount: 0,
    biddersCount: 0,
    releasesCount: 0,
  },
  {
    id: 'magazin-politika',
    name: 'Magazin Politika',
    domain: 'magazin.politika.rs',
    gamPath: '/23339552141/Magazin.politika.rs/',
    status: 'live',
    currentReleaseId: null,
    currentVersion: '20260713_184200',
    lastPublishedAt: '2026-07-13T18:42:00Z',
    adsTxtUrl: 'https://magazin.politika.rs/ads.txt',
    createdAt: '2026-07-13T18:42:00Z',
    updatedAt: '2026-07-13T18:42:00Z',
    adUnitsCount: 0,
    biddersCount: 0,
    releasesCount: 0,
  },
  {
    id: 'zurnal',
    name: 'Žurnal',
    domain: 'zurnal.rs',
    gamPath: '/23339552141/Zurnal/',
    status: 'staging',
    currentReleaseId: null,
    currentVersion: 'draft',
    lastPublishedAt: null,
    adsTxtUrl: 'https://www.zurnal.rs/ads.txt',
    createdAt: '2026-07-12T09:10:00Z',
    updatedAt: '2026-07-12T09:10:00Z',
    adUnitsCount: 0,
    biddersCount: 0,
    releasesCount: 0,
  },
];

const navItems = ['Publishers', 'Releases', 'Prebid builds', 'Audit log', 'Settings'];

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not published yet';

  try {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [publishers, setPublishers] = useState<Publisher[]>(fallbackPublishers);
  const [publisherError, setPublisherError] = useState<string | null>(null);
  const [activePublisher, setActivePublisher] = useState('politika');

  useEffect(() => {
    let cancelled = false;

    Promise.allSettled([api.health(), api.listPublishers()]).then(([healthResult, publishersResult]) => {
      if (cancelled) return;

      if (healthResult.status === 'fulfilled') {
        setHealth(healthResult.value);
      } else {
        setHealthError(healthResult.reason instanceof Error ? healthResult.reason.message : 'Health check failed');
      }

      if (publishersResult.status === 'fulfilled') {
        setPublishers(publishersResult.value);
        setPublisherError(null);

        if (!publishersResult.value.some((item) => item.id === activePublisher)) {
          setActivePublisher(publishersResult.value[0]?.id ?? 'politika');
        }
      } else {
        setPublisherError(
          publishersResult.reason instanceof Error
            ? publishersResult.reason.message
            : 'Publisher API is not ready.',
        );
      }
    });

    return () => {
      cancelled = true;
    };
  }, [activePublisher]);

  const publisher = useMemo(
    () => publishers.find((item) => item.id === activePublisher) ?? publishers[0] ?? fallbackPublishers[0],
    [activePublisher, publishers],
  );

  const databaseReady = health?.database === 'connected';

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
              <code>v {publisher.currentVersion}</code>
              <span>{publisher.domain}</span>
              <span>{publisher.gamPath}</span>
              <span>Published {formatTimestamp(publisher.lastPublishedAt)}</span>
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
                <h2>{databaseReady ? 'D1 publisher storage is connected' : 'Foundation is ready'}</h2>
              </div>
              <span className={health?.ok ? 'health-pill healthy' : 'health-pill'}>
                {health?.ok ? 'API healthy' : healthError ? 'API error' : 'Checking API…'}
              </span>
            </div>

            <p>
              {databaseReady
                ? 'Publisher records now come from Cloudflare D1. Next we connect the visual create and duplicate publisher flows.'
                : 'The dashboard and Worker are deployed. Create and bind the D1 database to replace fallback publisher data with real records.'}
            </p>

            {publisherError ? <p className="inline-warning">Publisher API: {publisherError}</p> : null}

            <div className="milestone-list">
              <div className="milestone complete">
                <span>1</span>
                <div><strong>Repository and deployment</strong><small>React, Worker API and workers.dev</small></div>
              </div>
              <div className={databaseReady ? 'milestone complete' : 'milestone next'}>
                <span>2</span>
                <div><strong>Cloudflare D1</strong><small>Schema, binding and initial publisher records</small></div>
              </div>
              <div className={databaseReady ? 'milestone next' : 'milestone'}>
                <span>3</span>
                <div><strong>Publisher management</strong><small>Create, edit, duplicate and audit</small></div>
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
            <div className="stat"><strong>{publishers.length}</strong><span>Publishers</span></div>
            <div className="stat"><strong>{publisher.adUnitsCount}</strong><span>Ad units</span></div>
            <div className="stat"><strong>{publisher.biddersCount}</strong><span>Bidders</span></div>
            <div className="stat"><strong>{publisher.releasesCount}</strong><span>Releases</span></div>
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
