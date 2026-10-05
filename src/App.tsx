import AgenciesPanel from './components/AgenciesPanel';
import AgencyOverview from './components/AgencyOverview';
import { useOrganization, agencyFor, inAgency } from './organization';
import AppFrame, { WorkspaceContent } from './components/AppFrame';
import AuthAccount from './components/AuthAccount';
import ApiIntegrationsPanel from './components/ApiIntegrationsPanel';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { canonicalDashboardURL, dashboardURL, globalSections as navItems, readDashboardNavigation, resolveDashboardNavigation, siteTabs as publisherTabs, type DashboardNavigation, type NavigationRequest, type GlobalSection, type PublisherTab } from './dashboard-navigation';
import { api } from './api';
import AdsTxtPanel from './components/AdsTxtPanel';
import AuditLogPanel from './components/AuditLogPanel';
import GlobalPrebidBuildsPanel from './components/GlobalPrebidBuildsPanel';
import GlobalReleasesPanel from './components/GlobalReleasesPanel';
import SettingsPanel from './components/SettingsPanel';
import DebugConsolePanel from './components/DebugConsolePanel';
import ConfigPanel from './components/ConfigPanel';
import ExportPanel from './components/ExportPanel';
import HierarchySidebar from './components/HierarchySidebar';
import PrebidBuildsPanel from './components/PrebidBuildsPanel';
import ReleasesPanel from './components/ReleasesPanel';
import type {ReleaseActionRequest} from './components/ReleaseActionFocus';
import SiteTestPagePanel from './components/SiteTestPagePanel';
import MockupBuilderPanel from './components/MockupBuilderPanel';
import MonitoringReadonlyPanel from './components/MonitoringReadonlyPanel';
import type {
  HealthResponse,
  PublisherAccount,
  PublisherAccountStatus,
  PublisherStatus,
  Site,
} from './shared/types';

const globalDescriptions: Record<GlobalSection, string> = {
  Agencies: 'Organize agencies, publishers and sites, with an optional agency logo.',
  'API integracije': 'Povežite GAM mreže i kreirajte ad unite iz šablona.',
  Publishers: 'Manage publisher accounts, sites and every site-level configuration workflow.',
  Releases: 'Review immutable releases across all publishers and sites.',
  'Prebid builds': 'Inspect every uploaded Prebid.js build and module manifest.',
  'Audit log': 'Review configuration, release and operational activity recorded in D1.',
  Settings: 'Check runtime health, bindings, security and retention safeguards.',
};
type ModalMode = 'create-publisher' | 'create-site' | 'edit-site' | 'duplicate-site' | null;

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

export default function App() {
  const organization = useOrganization();
  const [navigationRequest, setNavigationRequest] = useState(() => readDashboardNavigation(window.location.search));
  const navigationRef = useRef(navigationRequest);
  const hierarchyRequest = useRef(0);
  const [hierarchyLoaded, setHierarchyLoaded] = useState(false);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [publishers, setPublishers] = useState<PublisherAccount[]>([]);
  const [hierarchyError, setHierarchyError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [releaseAction,setReleaseAction]=useState<ReleaseActionRequest|null>(null);
  const releaseSequence=useRef(0);
  const [configEntry, setConfigEntry] = useState<'ad-units' | 'generator-profiles' | 'demand-mode'>('generator-profiles');
  const [modal, setModal] = useState<ModalMode>(null);
  const [publisherForm, setPublisherForm] = useState<PublisherForm>(emptyPublisherForm);
  const [siteForm, setSiteForm] = useState<SiteForm>(emptySiteForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const commitNavigation = useCallback((navigation: DashboardNavigation, replace = false) => {
    setReleaseAction(null);
    const url = dashboardURL(window.location.href, navigation);
    const currentURL = window.location.pathname + window.location.search + window.location.hash;
    if (url !== currentURL) window.history[replace ? 'replaceState' : 'pushState'](null, '', url);
    const next = readDashboardNavigation(window.location.search);
    navigationRef.current = next;
    setNavigationRequest(next);
  }, []);

  const loadHierarchy = useCallback(async (preferredPublisherId?: string, preferredSiteId?: string, requestedNavigation: NavigationRequest = navigationRef.current) => {
    const requestId = ++hierarchyRequest.current;
    setLoading(true);
    try {
      const items = await api.listPublisherAccounts();
      if (requestId !== hierarchyRequest.current) return;
      setPublishers(items);
      setHierarchyLoaded(true);
      setHierarchyError(null);
      // A response must not take the user back after they navigated elsewhere.
      if (preferredPublisherId && navigationRef.current === requestedNavigation) {
        commitNavigation({...requestedNavigation, publisherId:preferredPublisherId, siteId:preferredSiteId ?? null,
          tab:preferredSiteId ? requestedNavigation.tab : 'Overview', agencyFilter:preferredPublisherId === requestedNavigation.publisherId ? requestedNavigation.agencyFilter : 'all'});
      }
    } catch (error) {
      if (requestId === hierarchyRequest.current) setHierarchyError(error instanceof Error ? error.message : 'Publisher hierarchy could not be loaded.');
    } finally {
      if (requestId === hierarchyRequest.current) setLoading(false);
    }
  }, [commitNavigation]);

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
  }, []);

  const selection = useMemo(() => resolveDashboardNavigation(navigationRequest, publishers, organization.data), [navigationRequest, publishers, organization.data]);
  const navigationPending = !hierarchyLoaded || (navigationRequest.agencyFilter !== 'all' && organization.loading);
  const navigationError = hierarchyError || (navigationRequest.agencyFilter !== 'all' ? organization.error : null) || (!navigationPending ? selection.error : null);
  const publisher = navigationPending || navigationError ? null : selection.publisher;
  const site = navigationPending || navigationError ? null : selection.site;
  const {section:activeSection, tab:activeTab, agencyFilter} = selection.navigation;
  const agency = agencyFor(organization.data, publisher?.id);

  useEffect(() => {
    const restore = () => {
      const next = readDashboardNavigation(window.location.search);
      navigationRef.current = next;
      setNavigationRequest(next);
      setModal(null);
      setReleaseAction(null);
      setConfigEntry('generator-profiles');
    };
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  useEffect(() => {
    if (!navigationPending && !navigationError && navigationRef.current === navigationRequest && canonicalDashboardURL(window.location.href, navigationRequest, selection.navigation)) {
      commitNavigation(selection.navigation, true);
    }
  }, [navigationPending, navigationError, navigationRequest, selection.navigation, commitNavigation]);

  function navigate(patch: Partial<DashboardNavigation>) {
    commitNavigation({...selection.navigation, ...patch});
    setModal(null);
  }
  function openReleaseAction(action:'generate'|'publish'){
    if(!site)return;
    navigate({tab:'Releases'});
    setReleaseAction({siteId:site.id,sequence:++releaseSequence.current,action});
  }
  function setActiveTab(tab: PublisherTab) { navigate({tab}); }
  function filterAgency(value: string) {
    const keep = publisher && inAgency(organization.data, publisher.id, value);
    navigate({agencyFilter:value, ...(!keep ? {publisherId:null, siteId:null, tab:'Overview'} : {})});
  }
  function openAgency(value: string) {
    const keep = publisher && inAgency(organization.data, publisher.id, value);
    navigate({section:'Publishers', agencyFilter:value, tab:'Overview', ...(!keep ? {publisherId:null, siteId:null} : {})});
  }
  function openAgencyPublisher(id: string) {
    const account = publishers.find(item => item.id === id);
    if (account) navigate({section:'Publishers', agencyFilter:'all', publisherId:id, siteId:account.sites[0]?.id ?? null, tab:'Overview'});
  }

  const totalSites = useMemo(
    () => publishers.reduce((sum, item) => sum + item.sitesCount, 0),
    [publishers],
  );

  function selectPublisher(account: PublisherAccount) {
    navigate({section:'Publishers', publisherId:account.id, siteId:account.sites[0]?.id ?? null, tab:'Overview'});
  }

  function selectSite(accountId: string, selectedSite: Site) {
    navigate({section:'Publishers', publisherId:accountId, siteId:selectedSite.id});
  }

  function selectGlobalSection(section: GlobalSection) { navigate({section}); }

  function openSiteWorkspace(publisherAccountId: string, siteId: string, tab: 'Overview' | 'Releases' | 'Prebid.js') {
    navigate({agencyFilter:'all', publisherId:publisherAccountId, siteId, tab, section:'Publishers'});
  }

  function openCreatePublisher() {
    setPublisherForm(emptyPublisherForm);
    setFormError(null);
    setModal('create-publisher');
  }

  function openCreateSiteForPublisher(publisherAccountId: string) {
    setSiteForm({ ...emptySiteForm, publisherAccountId });
    setFormError(null);
    setModal('create-site');
  }

  function openCreateSite() {
    openCreateSiteForPublisher(publisher?.id ?? '');
  }

  function openEditSite() {
    if (!site) return;
    setSiteForm({
      id: site.id,
      publisherAccountId: site.publisherAccountId ?? publisher?.id ?? '',
      name: site.name,
      domain: site.domain,
      gamPath: site.gamPath,
      status: site.status,
      adsTxtUrl: site.adsTxtUrl ?? '',
      copyPrebidBuild: false,
      copyAdsTxtRequirements: false,
    });
    setFormError(null);
    setModal('edit-site');
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
    const requestedNavigation = navigationRef.current;
    try {
      const created = await api.createPublisherAccount({
        id: publisherForm.id.trim(),
        name: publisherForm.name.trim(),
        status: publisherForm.status,
        notes: publisherForm.notes.trim() || null,
      });
      await loadHierarchy(created.id, undefined, requestedNavigation);
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
    if (!siteForm.id || !siteForm.publisherAccountId || !siteForm.name || !siteForm.domain || !siteForm.gamPath) {
      setFormError('Publisher, Site ID, name, domain and GAM path are required.');
      return;
    }

    setSubmitting(true);
    const requestedNavigation = navigationRef.current;
    try {
      const common = {
        publisherAccountId: siteForm.publisherAccountId,
        name: siteForm.name.trim(),
        domain: siteForm.domain.trim(),
        gamPath: siteForm.gamPath.trim(),
        status: siteForm.status,
        adsTxtUrl: siteForm.adsTxtUrl.trim() || null,
      };
      const saved =
        modal === 'edit-site' && site
          ? await api.updateSite(site.id, common)
          : modal === 'duplicate-site' && site
            ? await api.duplicateSite(site.id, {
                id: siteForm.id.trim(),
                ...common,
                copyPrebidBuild: siteForm.copyPrebidBuild,
                copyAdsTxtRequirements: siteForm.copyAdsTxtRequirements,
              })
            : await api.createSite({ id: siteForm.id.trim(), ...common });

      await loadHierarchy(saved.publisherAccountId ?? siteForm.publisherAccountId, saved.id, requestedNavigation);
      setModal(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Site could not be saved.');
    } finally {
      setSubmitting(false);
    }
  }

  async function moveSiteToPublisher(siteId: string, targetPublisherId: string) {
    const requestedNavigation = navigationRef.current;
    try {
      const moved = await api.moveSite(siteId, targetPublisherId);
      await loadHierarchy(targetPublisherId, moved.id, requestedNavigation);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Site could not be moved.';
      setHierarchyError(message);
      window.alert(message);
      throw error;
    }
  }

  async function removeSite() {
    if (!site) return;
    if (!window.confirm(`Delete ${site.name} (${site.domain})? Its config, ad units, bidders, imports and releases will be deleted.`)) return;
    const requestedNavigation = navigationRef.current;
    try {
      const previousPublisher = site.publisherAccountId ?? publisher?.id;
      await api.deleteSite(site.id);
      if (navigationRef.current === requestedNavigation) commitNavigation({...requestedNavigation, publisherId:previousPublisher ?? null, siteId:null, tab:'Overview'});
      await loadHierarchy();
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
            Agencies group publisher accounts. Each site keeps its own GAM path, bidders, ad units,
            releases and ads.txt configuration. Drag any site in the sidebar onto another publisher to move it.
          </p>
          <AgencyOverview agency={agency} data={organization.data} filter={agencyFilter} onFilter={filterAgency} />
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
              <div className="site-overview-heading">
                <div>
                  <span className="panel-kicker">Active site</span>
                  <h2>{site.name}</h2>
                  <p>{site.domain}</p>
                </div>
                <button className="button secondary" onClick={openEditSite} type="button">Edit site</button>
              </div>
              <div className="publisher-facts">
                <div><span>Site ID</span><code>{site.id}</code></div>
                <div><span>Publisher</span><code>{publisher?.name ?? site.publisherAccountId ?? '—'}</code></div>
                <div><span>GAM path</span><code>{site.gamPath}</code></div>
                <div><span>Ads.txt</span><code>{site.adsTxtUrl ?? 'Not configured'}</code></div>
                <div><span>Version</span><code>{site.currentVersion}</code></div>
                <div><span>Updated</span><code>{formatTimestamp(site.updatedAt)}</code></div>
              </div>
            </div>
          ) : (
            <button className="empty-site-cta" disabled={!publisher} onClick={openCreateSite} type="button">
              ＋ Add the first site to {publisher?.name ?? 'this publisher'}
            </button>
          )}
        </article>

        <article className="panel api-panel">
          <div className="panel-heading">
            <div><span className="panel-kicker">Current selection</span><h2>Agency → Publisher → Site</h2></div>
          </div>
          <pre>{JSON.stringify({ agency: agency?.name ?? null, publisher: publisher?.id, site: site?.id, health }, null, 2)}</pre>
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

  const publisherWorkspace = activeSection === 'Publishers';
  const siteModalOpen = modal === 'create-site' || modal === 'edit-site' || modal === 'duplicate-site';
  const siteModalTitle =
    modal === 'edit-site'
      ? `Edit ${site?.name ?? 'site'}`
      : modal === 'duplicate-site'
        ? `Duplicate ${site?.name ?? 'site'}`
        : 'Create site';

  return (
    <AppFrame
      account={<AuthAccount />}
      navigation={
        <nav className="main-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              className={item === activeSection ? 'nav-item active' : 'nav-item'}
              key={item}
              onClick={() => selectGlobalSection(item)}
              type="button"
            >
              {item}
            </button>
          ))}
        </nav>
      }
      sidebarContent={publisherWorkspace || activeSection === 'Agencies' ? (
          <HierarchySidebar
            organization={organization.data}
            organizationError={organization.error}
            agencyFilter={agencyFilter}
            onAgencyFilter={filterAgency}
            onManageAgencies={() => selectGlobalSection('Agencies')}
            activePublisherId={publisher?.id ?? null}
            activeSiteId={site?.id ?? null}
            error={hierarchyError}
            loading={loading}
            onAddSite={openCreateSiteForPublisher}
            onCreatePublisher={openCreatePublisher}
            onMoveSite={moveSiteToPublisher}
            onSelectPublisher={selectPublisher}
            onSelectSite={selectSite}
            publishers={publishers}
          />
        ) : (
          <div className="global-sidebar-context">
            <span>Global workspace</span>
            <strong>{activeSection}</strong>
            <small>{publishers.length} publisher{publishers.length === 1 ? '' : 's'} · {totalSites} site{totalSites === 1 ? '' : 's'}</small>
            <button onClick={() => selectGlobalSection('Publishers')} type="button">← Return to publishers</button>
          </div>
        )}

    >
      <main className="workspace">
        {navigationError ? <section className="panel" role="alert">
          <h1>Selection unavailable</h1><p>{navigationError}</p>
          <p>Choose a site or workspace from the navigation to continue.</p>
          <button className="button secondary" disabled={loading || organization.loading} onClick={() => { void loadHierarchy(); void organization.reload(); }} type="button">Reload hierarchy</button>
        </section> : navigationPending ? <section className="panel" role="status"><h1>Loading publisher hierarchy…</h1></section> : publisherWorkspace ? (
          <>
        <header className="topbar">
          <div>
            <span className="eyebrow agency-selection-breadcrumb">{agency?.name ?? 'Without agency'} / {publisher?.name ?? 'No publisher'} / {site?.name ?? 'No site'}</span>
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
            <button className="button secondary" disabled={!publisher} onClick={openCreateSite} type="button">＋ Site</button>
            <button className="button secondary" disabled={!site} onClick={openEditSite} type="button">Edit site</button>
            <button className="button secondary" disabled={!site} onClick={openDuplicateSite} type="button">Duplicate site</button>
            <button className="button danger" disabled={!site} onClick={() => void removeSite()} type="button">Delete site</button>
            <button className="button secondary" disabled={!site} onClick={() => openReleaseAction('generate')} type="button">Generate</button>
            <button className="button primary" disabled={!site} onClick={() => openReleaseAction('publish')} type="button">Publish ↗</button>
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

        <WorkspaceContent pageKey={`${activeSection}:${site?.id ?? publisher?.id}:${activeTab}`}>
        {activeTab === 'Overview' ? renderOverview() : null}
        {activeTab === 'Config' && site ? (
          <ConfigPanel onGenerate={() => openReleaseAction('generate')} onOpenPrebid={() => setActiveTab('Prebid.js')} key={`${site.id}:${configEntry}`} initialSection={configEntry} onChanged={() => loadHierarchy(publisher?.id, site.id, navigationRequest)} publisherId={site.id} />
        ) : null}
        {activeTab === 'Prebid.js' && site ? (
          <PrebidBuildsPanel publisherId={site.id} siteName={site.name} />
        ) : null}
        {activeTab === 'Releases' && site ? (
          <ReleasesPanel key={site.id} actionRequest={releaseAction}
            onNavigate={destination => {
              if (destination === 'prebid') setActiveTab('Prebid.js');
              else { setConfigEntry(destination === 'demand' ? 'demand-mode' : 'generator-profiles'); setActiveTab('Config'); }
            }}
            onChanged={() => loadHierarchy(publisher?.id, site.id, navigationRequest)}
            publisherId={site.id}
            siteName={site.name}
          />
        ) : null}
        {activeTab === 'Test page' && site ? <SiteTestPagePanel key={site.id} publisherId={site.id} /> : null}
        {activeTab === 'Export' && site ? <ExportPanel publisherId={site.id} site={site} /> : null}
        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}
        {activeTab === 'Monitoring' && site ? <MonitoringReadonlyPanel site={site} /> : null}
        {activeTab === 'Debug' && site ? (
          <DebugConsolePanel domain={site.domain} publisherId={site.id} siteName={site.name} />
        ) : null}
        {activeTab === 'Ads.txt' && site ? (
          <AdsTxtPanel onChanged={() => loadHierarchy(publisher?.id, site.id, navigationRequest)} site={site} />
        ) : null}
        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Test page' && activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Monitoring' && activeTab !== 'Debug' && activeTab !== 'Ads.txt'
          ? renderPlaceholder(activeTab)
          : null}
        </WorkspaceContent>
          </>
        ) : (
          <>
            <header className="topbar global-topbar">
              <div>
                <span className="eyebrow">Global workspace / {activeSection}</span>
                <h1>{activeSection}</h1>
                <p>{globalDescriptions[activeSection]}</p>
              </div>
              <button className="button secondary" onClick={() => selectGlobalSection('Publishers')} type="button">Open publishers</button>
            </header>
            <WorkspaceContent pageKey={activeSection}>
            {activeSection === 'Agencies' ? <AgenciesPanel controller={organization} publishers={publishers} onOpenPublisher={openAgencyPublisher} onOpenAgency={openAgency} /> : null}
            {activeSection === 'Releases' ? (
              <GlobalReleasesPanel onOpenSite={openSiteWorkspace} publishers={publishers} />
            ) : null}
            {activeSection === 'Prebid builds' ? (
              <GlobalPrebidBuildsPanel onOpenSite={openSiteWorkspace} publishers={publishers} />
            ) : null}
            {activeSection === 'Audit log' ? (
              <AuditLogPanel onOpenSite={openSiteWorkspace} publishers={publishers} />
            ) : null}
            {activeSection === 'API integracije' ? <ApiIntegrationsPanel sites={publishers.flatMap(p => p.sites)} /> : null}
            {activeSection === 'Settings' ? <SettingsPanel publishers={publishers} /> : null}
            </WorkspaceContent>
          </>
        )}
      </main>

      {modal === 'create-publisher' ? (
        <div className="modal-backdrop" onMouseDown={closeModal} role="presentation">
          <section className="modal-card" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div><span className="panel-kicker">Publisher account</span><h2>Create publisher</h2></div>
              <button className="icon-button" onClick={closeModal} type="button">×</button>
            </div>
            <form className="publisher-form" onSubmit={submitPublisher}>
              <label>
                <span>Publisher name</span>
                <input
                  autoFocus
                  onChange={(event) => setPublisherForm((current) => ({
                    ...current,
                    name: event.target.value,
                    id: current.id || slugify(event.target.value),
                  }))}
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
                  onChange={(event) => setPublisherForm((current) => ({
                    ...current,
                    status: event.target.value as PublisherAccountStatus,
                  }))}
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
                <button className="button primary" disabled={submitting} type="submit">{submitting ? 'Saving…' : 'Create publisher'}</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {siteModalOpen ? (
        <div className="modal-backdrop" onMouseDown={closeModal} role="presentation">
          <section className="modal-card" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div><span className="panel-kicker">Site / domain workflow</span><h2>{siteModalTitle}</h2></div>
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
                {modal === 'edit-site' ? <small>Changing this value moves the site to another publisher.</small> : null}
              </label>
              <label>
                <span>Site name</span>
                <input
                  autoFocus
                  onChange={(event) => setSiteForm((current) => ({
                    ...current,
                    name: event.target.value,
                    id: modal === 'edit-site' ? current.id : current.id || slugify(event.target.value),
                  }))}
                  placeholder="K1info.rs"
                  value={siteForm.name}
                />
              </label>
              <label>
                <span>Site ID</span>
                <input
                  disabled={modal === 'edit-site'}
                  onChange={(event) => setSiteForm((current) => ({ ...current, id: slugify(event.target.value) }))}
                  placeholder="k1info"
                  value={siteForm.id}
                />
                {modal === 'edit-site' ? <small>Site ID is immutable because configs and releases reference it.</small> : null}
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
                  {submitting
                    ? 'Saving…'
                    : modal === 'duplicate-site'
                      ? 'Duplicate site'
                      : modal === 'edit-site'
                        ? 'Save site'
                        : 'Create site'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </AppFrame>
  );
}
