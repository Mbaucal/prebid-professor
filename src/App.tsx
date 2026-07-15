import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from './api';
import ConfigPanel from './components/ConfigPanel';
import type {
  HealthResponse,
  PublisherAccount,
  PublisherAccountStatus,
  PublisherStatus,
  Site,
} from './shared/types';

const navItems = ['Publishers', 'Releases', 'Prebid builds', 'Audit log', 'Settings'];
const publisherTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Debug', 'Ads.txt'] as const;

type PublisherTab = (typeof publisherTabs)[number];
type ModalMode = 'create-publisher' | 'create-site' | 'duplicate-site' | null;

type PublisherForm = {
  id: string;
  name: string;
  status: PublisherAccountStatus;
  notes: string;
};

type SiteForm = {
  id: string;
  publisherAccountId: string;
  name: string;
  domain: string;
  gamPath: string;
  status: PublisherStatus;
  adsTxtUrl: string;
  copyPrebidBuild: boolean;
  copyAdsTxtRequirements: boolean;
};

const emptyPublisherForm: PublisherForm = {
  id: '',
  name: '',
  status: 'active',
  notes: '',
};

const emptySiteForm: SiteForm = {
  id: '',
  publisherAccountId: '',
  name: '',
  domain: '',
  gamPath: '',
  status: 'draft',
  adsTxtUrl: '',
  copyPrebidBuild: true,
  copyAdsTxtRequirements: true,
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

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

function nextCopyId(value: string): string {
  const match = value.match(/^(.*?)(?:-(\d+))?$/);
  const base = match?.[1] || value;
  const next = match?.[2] ? Number(match[2]) + 1 : 2;
  return `${base}-${next}`;
}

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [publishers, setPublishers] = useState<PublisherAccount[]>([]);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activePublisherId, setActivePublisherId] = useState<string | null>(null);
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<PublisherTab>('Overview');
  const [modal, setModal] = useState<ModalMode>(null);
  const [publisherForm, setPublisherForm] = useState<PublisherForm>(emptyPublisherForm);
  const [siteForm, setSiteForm] = useState<SiteForm>(emptySiteForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const loadHierarchy = useCallback(
    async (preferredPublisherId?: string, preferredSiteId?: string) => {
      setLoading(true);
      try {
        const items = await api.listPublisherAccounts();
        setPublishers(items);
        setHierarchyError(null);

        const candidatePublisher =
          items.find((item) => item.id === preferredPublisherId) ??
          items.find((item) => item.id === activePublisherId) ??
          items[0] ??
          null;
        setActivePublisherId(candidatePublisher?.id ?? null);

        const allSites = items.flatMap((item) => item.sites);
        const candidateSite =
          allSites.find((site) => site.id === preferredSiteId) ??
          allSites.find((site) => site.id === activeSiteId) ??
          candidatePublisher?.sites[0] ??
          allSites[0] ??
          null;
        setActiveSiteId(candidateSite?.id ?? null);

        if (candidateSite?.publisherAccountId) {
          setActivePublisherId(candidateSite.publisherAccountId);
        }
      } catch (error) {
        setHierarchyError(error instanceof Error ? error.message : 'Publisher hierarchy could not be loaded.');
      } finally {
        setLoading(false);
      }
    },
    [activePublisherId, activeSiteId],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .health()
      .then((payload) => {
        if (!cancelled) setHealth(payload);
      })
      .catch((error: unknown) => {
        if (!cancelled) setHealthError(error instanceof Error ? error.message : 'Health check failed');
      });
    void loadHierarchy();
    return () => {
      cancelled = true;
    };
  }, []); // load once; subsequent refreshes are explicit

  const publisher = useMemo(
    () => publishers.find((item) => item.id === activePublisherId) ?? publishers[0] ?? null,
    [activePublisherId, publishers],
  );

  const site = useMemo(() => {
    const allSites = publishers.flatMap((item) => item.sites);
    return allSites.find((item) => item.id === activeSiteId) ?? publisher?.sites[0] ?? allSites[0] ?? null;
  }, [activeSiteId, publisher, publishers]);

  const totalSites = useMemo(
    () => publishers.reduce((sum, item) => sum + item.sitesCount, 0),
    [publishers],
  );

  function selectPublisher(account: PublisherAccount) {
    setActivePublisherId(account.id);
    setActiveSiteId(account.sites[0]?.id ?? null);
    setActiveTab('Overview');
  }

  function selectSite(accountId: string, selectedSite: Site) {
    setActivePublisherId(accountId);
    setActiveSiteId(selectedSite.id);
  }

  function openCreatePublisher() {
    setPublisherForm(emptyPublisherForm);
    setFormError(null);
    setModal('create-publisher');
  }

  function openCreateSite() {
    setSiteForm({ ...emptySiteForm, publisherAccountId: publisher?.id ?? '' });
    setFormError(null);
    setModal('create-site');
  }

  function openDuplicateSite() {
    if (!site) return;
    const id = nextCopyId(site.id);
    const domain = `copy.${site.domain}`;
    setSiteForm({
      id,
      publisherAccountId: site.publisherAccountId ?? publisher?.id ?? '',
      name: `${site.name} Copy`,
      domain,
      gamPath: site.gamPath,
      status: 'draft',
      adsTxtUrl: `https://${domain}/ads.txt`,
      copyPrebidBuild: true,
      copyAdsTxtRequirements: true,
    });
    setFormError(null);
    setModal('duplicate-site');
  }

  function closeModal() {
    if (submitting) return;
    setModal(null);
    setFormError(null);
  }

  async function submitPublisher(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (!publisherForm.id || !publisherForm.name) {
      setFormError('Publisher ID and name are required.');
      return;
    }

    setSubmitting(true);
    try {
      const created = await api.createPublisherAccount({
        id: publisherForm.id.trim(),
        name: publisherForm.name.trim(),
        status: publisherForm.status,
        notes: publisherForm.notes.trim() || null,
      });
      await loadHierarchy(created.id);
      setModal(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Publisher could not be created.');
    } finally {
      setSubmitting(false);
    }
  }

  async function submitSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    if (
      !siteForm.id ||
      !siteForm.publisherAccountId ||
      !siteForm.name ||
      !siteForm.domain ||
      !siteForm.gamPath
    ) {
      setFormError('Publisher, Site ID, name, domain and GAM path are required.');
      return;
    }

    setSubmitting(true);
    try {
      const input = {
        id: siteForm.id.trim(),
        publisherAccountId: siteForm.publisherAccountId,
        name: siteForm.name.trim(),
        domain: siteForm.domain.trim(),
        gamPath: siteForm.gamPath.trim(),
        status: siteForm.status,
        adsTxtUrl: siteForm.adsTxtUrl.trim() || null,
      };

      const saved =
        modal === 'duplicate-site' && site
          ? await api.duplicateSite(site.id, {
              ...input,
              copyPrebidBuild: siteForm.copyPrebidBuild,
              copyAdsTxtRequirements: siteForm.copyAdsTxtRequirements,
            })
          : await api.createSite(input);

      await loadHierarchy(saved.publisherAccountId ?? siteForm.publisherAccountId, saved.id);
      setModal(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Site could not be saved.');
    } finally {
      setSubmitting(false);
    }
  }

  async function removeSite() {
    if (!site) return;
    const confirmed = window.confirm(
      `Delete ${site.name} (${site.domain})? Its config, ad units, bidders, imports and releases will be deleted.`,
    );
    if (!confirmed) return;

    try {
      const previousPublisher = site.publisherAccountId ?? publisher?.id;
      await api.deleteSite(site.id);
      await loadHierarchy(previousPublisher);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'Site could not be deleted.');
    }
  }

  function renderOverview() {
    return (
      <section className="content-grid">
        <article className="panel overview-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Publisher hierarchy</span>
              <h2>{publisher ? `${publisher.name} · ${publisher.sitesCount} site(s)` : 'No publisher selected'}</h2>
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
            A publisher is now the business/account. Every publisher can contain multiple sites or domains,
            and each site keeps its own GAM path, bidders, ad units, releases and ads.txt configuration.
          </p>

          {hierarchyError ? <p className="inline-warning">Hierarchy API: {hierarchyError}</p> : null}

          {publisher ? (
            <div className="publisher-facts">
              <div><span>Publisher ID</span><code>{publisher.id}</code></div>
              <div><span>Publisher status</span><code>{publisher.status}</code></div>
              <div><span>Sites</span><code>{publisher.sitesCount}</code></div>
              <div><span>Notes</span><code>{publisher.notes ?? '—'}</code></div>
            </div>
          ) : null}

          {site ? (
            <div className="site-overview-card">
              <div>
                <span className="panel-kicker">Active site</span>
                <h2>{site.name}</h2>
                <p>{site.domain}</p>
              </div>
              <div className="publisher-facts">
                <div><span>Site ID</span><code>{site.id}</code></div>
                <div><span>GAM path</span><code>{site.gamPath}</code></div>
                <div><span>Ads.txt</span><code>{site.adsTxtUrl ?? 'Not configured'}</code></div>
                <div><span>Version</span><code>{site.currentVersion}</code></div>
              </div>
            </div>
          ) : (
            <button className="empty-site-cta" onClick={openCreateSite} type="button">
              ＋ Add the first site to {publisher?.name ?? 'this publisher'}
            </button>
          )}
        </article>

        <article className="panel api-panel">
          <div className="panel-heading">
            <div>
              <span className="panel-kicker">Current selection</span>
              <h2>Publisher → Site</h2>
            </div>
          </div>
          <pre>{JSON.stringify({ publisher: publisher?.id, site: site?.id, health }, null, 2)}</pre>
        </article>

        <article className="panel stats-panel">
          <div className="stat"><strong>{publishers.length}</strong><span>Publishers</span></div>
          <div className="stat"><strong>{totalSites}</strong><span>Sites / domains</span></div>
          <div className="stat"><strong>{site?.adUnitsCount ?? 0}</strong><span>Ad units on site</span></div>
          <div className="stat"><strong>{site?.biddersCount ?? 0}</strong><span>Bidders on site</span></div>
        </article>
      </section>
    );
  }

  function renderPlaceholder(tab: PublisherTab) {
    return (
      <section className="content-page">
        <article className="panel placeholder-panel">
          <span className="panel-kicker">{tab}</span>
          <h2>{tab} is next in the build plan</h2>
          <p>This section will use the active site: {site?.name ?? 'no site selected'}.</p>
        </article>
      </section>
    );
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

        <div className="publisher-nav publisher-tree">
          <div className="section-label">Publishers</div>
          {loading ? <div className="publisher-nav-message">Loading publisher hierarchy…</div> : null}
          {hierarchyError ? <div className="publisher-nav-message error">{hierarchyError}</div> : null}

          {publishers.map((account) => (
            <div className="publisher-tree-group" key={account.id}>
              <button
                className={account.id === publisher?.id ? 'publisher-account-link active' : 'publisher-account-link'}
                onClick={() => selectPublisher(account)}
                type="button"
              >
                <span>{account.name}</span>
                <small>{account.sitesCount}</small>
              </button>
              <div className="publisher-site-list">
                {account.sites.map((item) => (
                  <button
                    className={item.id === site?.id ? 'site-link active' : 'site-link'}
                    key={item.id}
                    onClick={() => selectSite(account.id, item)}
                    type="button"
                  >
                    <span>{item.name}</span>
                    <small className={item.status}>{item.status}</small>
                  </button>
                ))}
                <button
                  className="site-link add-site-link"
                  onClick={() => {
                    setActivePublisherId(account.id);
                    setActiveSiteId(account.sites[0]?.id ?? null);
                    setSiteForm({ ...emptySiteForm, publisherAccountId: account.id });
                    setModal('create-site');
                  }}
                  type="button"
                >
                  ＋ Add site
                </button>
              </div>
            </div>
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
            <span className="eyebrow">
              Publishers / {publisher?.name ?? 'No publisher'} / {site?.name ?? 'No site'}
            </span>
            <h1>{site?.name ?? publisher?.name ?? 'Prebid Professor'}</h1>
            {site ? (
              <div className="publisher-meta">
                <span className={`status-badge ${site.status}`}>● {site.status}</span>
                <code>v {site.currentVersion}</code>
                <span>{site.domain}</span>
                <span>{site.gamPath}</span>
                <span>Published {formatTimestamp(site.lastPublishedAt)}</span>
              </div>
            ) : publisher ? (
              <div className="publisher-meta">
                <span className="status-badge draft">● {publisher.status}</span>
                <span>{publisher.sitesCount} site(s)</span>
              </div>
            ) : null}
          </div>

          <div className="top-actions">
            <button className="button secondary" disabled={!publisher} onClick={openCreateSite} type="button">
              ＋ Site
            </button>
            <button className="button secondary" disabled={!site} onClick={openDuplicateSite} type="button">
              Duplicate site
            </button>
            <button className="button danger" disabled={!site} onClick={() => void removeSite()} type="button">
              Delete site
            </button>
            <button className="button secondary" disabled={!site} type="button">Validate</button>
            <button className="button secondary" disabled={!site} type="button">Generate</button>
            <button className="button primary" disabled={!site} type="button">Publish ↗</button>
          </div>
        </header>

        <section className="tabbar" aria-label="Site sections">
          {publisherTabs.map((item) => (
            <button
              className={item === activeTab ? 'tab active' : 'tab'}
              disabled={!site && item !== 'Overview'}
              key={item}
              onClick={() => setActiveTab(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </section>

        {activeTab === 'Overview' ? renderOverview() : null}
        {activeTab === 'Config' && site ? (
          <ConfigPanel
            onChanged={() => loadHierarchy(publisher?.id, site.id)}
            publisherId={site.id}
          />
        ) : null}
        {activeTab !== 'Overview' && activeTab !== 'Config' ? renderPlaceholder(activeTab) : null}
      </main>

      {modal === 'create-publisher' ? (
        <div className="modal-backdrop" onMouseDown={closeModal} role="presentation">
          <section className="modal-card" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Publisher account</span>
                <h2>Create publisher</h2>
              </div>
              <button className="icon-button" onClick={closeModal} type="button">×</button>
            </div>
            <form className="publisher-form" onSubmit={submitPublisher}>
              <label>
                <span>Publisher name</span>
                <input
                  autoFocus
                  onChange={(event) =>
                    setPublisherForm((current) => ({
                      ...current,
                      name: event.target.value,
                      id: current.id || slugify(event.target.value),
                    }))
                  }
                  placeholder="Minacord"
                  value={publisherForm.name}
                />
              </label>
              <label>
                <span>Publisher ID</span>
                <input
                  onChange={(event) => setPublisherForm((current) => ({ ...current, id: slugify(event.target.value) }))}
                  placeholder="minacord"
                  value={publisherForm.id}
                />
              </label>
              <label>
                <span>Status</span>
                <select
                  onChange={(event) =>
                    setPublisherForm((current) => ({
                      ...current,
                      status: event.target.value as PublisherAccountStatus,
                    }))
                  }
                  value={publisherForm.status}
                >
                  <option value="active">active</option>
                  <option value="draft">draft</option>
                  <option value="archived">archived</option>
                </select>
              </label>
              <label>
                <span>Notes</span>
                <input
                  onChange={(event) => setPublisherForm((current) => ({ ...current, notes: event.target.value }))}
                  placeholder="K1info.rs, Tanjug.rs..."
                  value={publisherForm.notes}
                />
              </label>
              {formError ? <div className="form-error">{formError}</div> : null}
              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeModal} type="button">Cancel</button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting ? 'Saving…' : 'Create publisher'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {modal === 'create-site' || modal === 'duplicate-site' ? (
        <div className="modal-backdrop" onMouseDown={closeModal} role="presentation">
          <section className="modal-card" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Site / domain workflow</span>
                <h2>{modal === 'duplicate-site' ? `Duplicate ${site?.name ?? 'site'}` : 'Create site'}</h2>
              </div>
              <button className="icon-button" onClick={closeModal} type="button">×</button>
            </div>
            <form className="publisher-form" onSubmit={submitSite}>
              <label>
                <span>Publisher</span>
                <select
                  onChange={(event) => setSiteForm((current) => ({ ...current, publisherAccountId: event.target.value }))}
                  value={siteForm.publisherAccountId}
                >
                  <option value="">Select publisher</option>
                  {publishers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>
                <span>Site name</span>
                <input
                  autoFocus
                  onChange={(event) =>
                    setSiteForm((current) => ({
                      ...current,
                      name: event.target.value,
                      id: current.id || slugify(event.target.value),
                    }))
                  }
                  placeholder="K1info.rs"
                  value={siteForm.name}
                />
              </label>
              <label>
                <span>Site ID</span>
                <input
                  onChange={(event) => setSiteForm((current) => ({ ...current, id: slugify(event.target.value) }))}
                  placeholder="k1info"
                  value={siteForm.id}
                />
              </label>
              <label>
                <span>Domain</span>
                <input
                  onChange={(event) => setSiteForm((current) => ({ ...current, domain: event.target.value }))}
                  placeholder="k1info.rs"
                  value={siteForm.domain}
                />
              </label>
              <label>
                <span>GAM path</span>
                <input
                  onChange={(event) => setSiteForm((current) => ({ ...current, gamPath: event.target.value }))}
                  placeholder="/23339552141/K1info.rs/"
                  value={siteForm.gamPath}
                />
              </label>
              <label>
                <span>Status</span>
                <select
                  onChange={(event) => setSiteForm((current) => ({ ...current, status: event.target.value as PublisherStatus }))}
                  value={siteForm.status}
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
                  onChange={(event) => setSiteForm((current) => ({ ...current, adsTxtUrl: event.target.value }))}
                  placeholder="https://k1info.rs/ads.txt"
                  value={siteForm.adsTxtUrl}
                />
              </label>

              {modal === 'duplicate-site' ? (
                <div className="form-options">
                  <label className="check-row">
                    <input
                      checked={siteForm.copyPrebidBuild}
                      onChange={(event) => setSiteForm((current) => ({ ...current, copyPrebidBuild: event.target.checked }))}
                      type="checkbox"
                    />
                    <span>Copy current Prebid build</span>
                  </label>
                  <label className="check-row">
                    <input
                      checked={siteForm.copyAdsTxtRequirements}
                      onChange={(event) => setSiteForm((current) => ({ ...current, copyAdsTxtRequirements: event.target.checked }))}
                      type="checkbox"
                    />
                    <span>Copy ads.txt requirements</span>
                  </label>
                  <p>
                    Ad units, bidders, overrides, size maps and unit rules are copied. Release history and
                    the production pointer are never copied.
                  </p>
                </div>
              ) : null}

              {formError ? <div className="form-error">{formError}</div> : null}
              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeModal} type="button">Cancel</button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting ? 'Saving…' : modal === 'duplicate-site' ? 'Duplicate site' : 'Create site'}
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
