import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import type { HealthResponse, Publisher, PublisherStatus } from './shared/types';

const navItems = ['Publishers', 'Releases', 'Prebid builds', 'Audit log', 'Settings'];

type PublisherFormMode = 'create' | 'duplicate';

type PublisherFormState = {
  id: string;
  name: string;
  domain: string;
  gamPath: string;
  status: PublisherStatus;
  adsTxtUrl: string;
  copyPrebidBuild: boolean;
  copyAdsTxtRequirements: boolean;
};

const emptyPublisherForm: PublisherFormState = {
  id: '',
  name: '',
  domain: '',
  gamPath: '',
  status: 'draft',
  adsTxtUrl: '',
  copyPrebidBuild: false,
  copyAdsTxtRequirements: true,
};

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

function slugifyPublisherId(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [publishers, setPublishers] = useState<Publisher[]>([]);
  const [publisherError, setPublisherError] = useState<string | null>(null);
  const [publishersLoading, setPublishersLoading] = useState(true);
  const [activePublisher, setActivePublisher] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<PublisherFormMode | null>(null);
  const [form, setForm] = useState<PublisherFormState>(emptyPublisherForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSubmitting, setFormSubmitting] = useState(false);

  const loadPublishers = useCallback(async (preferredPublisherId?: string) => {
    setPublishersLoading(true);

    try {
      const items = await api.listPublishers();
      setPublishers(items);
      setPublisherError(null);
      setActivePublisher((current) => {
        if (preferredPublisherId && items.some((item) => item.id === preferredPublisherId)) {
          return preferredPublisherId;
        }

        if (current && items.some((item) => item.id === current)) {
          return current;
        }

        return items[0]?.id ?? null;
      });
    } catch (error) {
      setPublisherError(error instanceof Error ? error.message : 'Publisher API is not ready.');
    } finally {
      setPublishersLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    api
      .health()
      .then((payload) => {
        if (!cancelled) setHealth(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHealthError(error instanceof Error ? error.message : 'Health check failed');
        }
      });

    void loadPublishers();

    return () => {
      cancelled = true;
    };
  }, [loadPublishers]);

  const publisher = useMemo(
    () => publishers.find((item) => item.id === activePublisher) ?? publishers[0] ?? null,
    [activePublisher, publishers],
  );

  const databaseReady = health?.database === 'connected';

  function openCreatePublisher() {
    setFormMode('create');
    setForm(emptyPublisherForm);
    setFormError(null);
  }

  function openDuplicatePublisher() {
    if (!publisher) return;

    const suggestedDomain = `copy.${publisher.domain}`;

    setFormMode('duplicate');
    setForm({
      id: `${publisher.id}-copy`,
      name: `${publisher.name} Copy`,
      domain: suggestedDomain,
      gamPath: publisher.gamPath,
      status: 'draft',
      adsTxtUrl: `https://${suggestedDomain}/ads.txt`,
      copyPrebidBuild: true,
      copyAdsTxtRequirements: true,
    });
    setFormError(null);
  }

  function closePublisherForm() {
    if (formSubmitting) return;
    setFormMode(null);
    setFormError(null);
  }

  function updateFormField<K extends keyof PublisherFormState>(
    key: K,
    value: PublisherFormState[K],
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function updateName(value: string) {
    setForm((current) => ({
      ...current,
      name: value,
      id: current.id ? current.id : slugifyPublisherId(value),
    }));
  }

  async function submitPublisherForm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!form.id || !form.name || !form.domain || !form.gamPath) {
      setFormError('Site ID, name, domain and GAM path are required.');
      return;
    }

    setFormSubmitting(true);

    try {
      const input = {
        id: form.id.trim(),
        name: form.name.trim(),
        domain: form.domain.trim(),
        gamPath: form.gamPath.trim(),
        status: form.status,
        adsTxtUrl: form.adsTxtUrl.trim() || null,
      };

      const created =
        formMode === 'duplicate' && publisher
          ? await api.duplicatePublisher(publisher.id, {
              ...input,
              copyPrebidBuild: form.copyPrebidBuild,
              copyAdsTxtRequirements: form.copyAdsTxtRequirements,
            })
          : await api.createPublisher(input);

      await loadPublishers(created.id);
      setFormMode(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Publisher operation failed.');
    } finally {
      setFormSubmitting(false);
    }
  }

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

          {publishersLoading ? <div className="publisher-nav-message">Loading D1 publishers…</div> : null}
          {publisherError ? <div className="publisher-nav-message error">{publisherError}</div> : null}

          {publishers.map((item) => (
            <button
              className={item.id === publisher?.id ? 'publisher-link active' : 'publisher-link'}
              key={item.id}
              onClick={() => setActivePublisher(item.id)}
              type="button"
            >
              <span>{item.name}</span>
              <small className={item.status}>{item.status}</small>
            </button>
          ))}

          <button className="publisher-link muted" onClick={openCreatePublisher} type="button">
            <span>＋ New publisher</span>
          </button>
        </div>

        <div className="account-card">
          <div className="avatar">S</div>
          <div>
            <strong>srdjan</strong>
            <span>admin · Cloudflare Access next</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">Publishers / {publisher?.name ?? 'No publisher'}</span>
            <h1>{publisher?.name ?? 'Prebid Professor'}</h1>
            {publisher ? (
              <div className="publisher-meta">
                <span className={`status-badge ${publisher.status}`}>● {publisher.status}</span>
                <code>v {publisher.currentVersion}</code>
                <span>{publisher.domain}</span>
                <span>{publisher.gamPath}</span>
                <span>Published {formatTimestamp(publisher.lastPublishedAt)}</span>
              </div>
            ) : null}
          </div>

          <div className="top-actions">
            <button
              className="button secondary"
              disabled={!publisher}
              onClick={openDuplicatePublisher}
              type="button"
            >
              Duplicate
            </button>
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
                {health?.ok
                  ? health.database === 'connected'
                    ? 'API + D1 healthy'
                    : `API healthy · DB ${health.database}`
                  : healthError
                    ? 'API error'
                    : 'Checking API…'}
              </span>
            </div>

            <p>
              {databaseReady
                ? 'Publisher records now come from Cloudflare D1. You can create a blank publisher or duplicate an existing site without copying its release history or production pointer.'
                : 'The dashboard and Worker are deployed. Bind the D1 database to enable publisher workflows.'}
            </p>

            {publisherError ? <p className="inline-warning">Publisher API: {publisherError}</p> : null}

            {publisher ? (
              <div className="publisher-facts">
                <div><span>Publisher ID</span><code>{publisher.id}</code></div>
                <div><span>GAM path</span><code>{publisher.gamPath}</code></div>
                <div><span>Ads.txt</span><code>{publisher.adsTxtUrl ?? 'Not configured'}</code></div>
                <div><span>Updated</span><code>{formatTimestamp(publisher.updatedAt)}</code></div>
              </div>
            ) : null}

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
                <div><strong>Publisher management</strong><small>Create and duplicate are now connected to D1</small></div>
              </div>
              <div className="milestone">
                <span>4</span>
                <div><strong>Ad units and config</strong><small>Edit, duplicate and validate publisher configuration</small></div>
              </div>
            </div>
          </article>

          <article className="panel api-panel">
            <div className="panel-heading">
              <div>
                <span className="panel-kicker">Worker API</span>
                <h2>/api/health + /api/publishers</h2>
              </div>
            </div>
            <pre>{JSON.stringify({ health, publishers: publishers.length, activePublisher }, null, 2)}</pre>
          </article>

          <article className="panel stats-panel">
            <div className="stat"><strong>{publishers.length}</strong><span>Publishers</span></div>
            <div className="stat"><strong>{publisher?.adUnitsCount ?? 0}</strong><span>Ad units</span></div>
            <div className="stat"><strong>{publisher?.biddersCount ?? 0}</strong><span>Bidders</span></div>
            <div className="stat"><strong>{publisher?.releasesCount ?? 0}</strong><span>Releases</span></div>
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

      {formMode ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={closePublisherForm}>
          <section
            aria-labelledby="publisher-form-title"
            aria-modal="true"
            className="modal-card"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Publisher workflow</span>
                <h2 id="publisher-form-title">
                  {formMode === 'duplicate' ? `Duplicate ${publisher?.name ?? 'publisher'}` : 'Create publisher'}
                </h2>
              </div>
              <button className="icon-button" onClick={closePublisherForm} type="button">×</button>
            </div>

            <form className="publisher-form" onSubmit={submitPublisherForm}>
              <label>
                <span>Publisher name</span>
                <input
                  autoFocus
                  onChange={(event) => updateName(event.target.value)}
                  placeholder="Politika Sport"
                  value={form.name}
                />
              </label>

              <label>
                <span>Site ID</span>
                <input
                  onChange={(event) => updateFormField('id', slugifyPublisherId(event.target.value))}
                  placeholder="politika-sport"
                  value={form.id}
                />
                <small>Lowercase letters, numbers and dashes only.</small>
              </label>

              <label>
                <span>Domain</span>
                <input
                  onChange={(event) => updateFormField('domain', event.target.value)}
                  placeholder="sport.politika.rs"
                  value={form.domain}
                />
              </label>

              <label>
                <span>GAM path</span>
                <input
                  onChange={(event) => updateFormField('gamPath', event.target.value)}
                  placeholder="/23339552141/Politika.sport.rs/"
                  value={form.gamPath}
                />
              </label>

              <label>
                <span>Status</span>
                <select
                  onChange={(event) => updateFormField('status', event.target.value as PublisherStatus)}
                  value={form.status}
                >
                  <option value="draft">draft</option>
                  <option value="staging">staging</option>
                  <option value="live">live</option>
                  <option value="archived">archived</option>
                </select>
              </label>

              <label>
                <span>Ads.txt URL</span>
                <input
                  onChange={(event) => updateFormField('adsTxtUrl', event.target.value)}
                  placeholder="https://sport.politika.rs/ads.txt"
                  value={form.adsTxtUrl}
                />
              </label>

              {formMode === 'duplicate' ? (
                <div className="form-options">
                  <label className="check-row">
                    <input
                      checked={form.copyPrebidBuild}
                      onChange={(event) => updateFormField('copyPrebidBuild', event.target.checked)}
                      type="checkbox"
                    />
                    <span>Copy current Prebid build</span>
                  </label>
                  <label className="check-row">
                    <input
                      checked={form.copyAdsTxtRequirements}
                      onChange={(event) =>
                        updateFormField('copyAdsTxtRequirements', event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>Copy ads.txt requirements</span>
                  </label>
                  <p>
                    Ad units, bidders, overrides, size maps and unit rules are copied. Release
                    history and the production pointer are never copied.
                  </p>
                </div>
              ) : null}

              {formError ? <div className="form-error">{formError}</div> : null}

              <div className="modal-actions">
                <button className="button secondary" disabled={formSubmitting} onClick={closePublisherForm} type="button">
                  Cancel
                </button>
                <button className="button primary" disabled={formSubmitting} type="submit">
                  {formSubmitting
                    ? 'Saving…'
                    : formMode === 'duplicate'
                      ? 'Duplicate publisher'
                      : 'Create publisher'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default App;
