from pathlib import Path


def replace_once(source: str, old: str, new: str, label: str) -> str:
    if new in source:
        return source
    if old not in source:
        raise SystemExit(f'{label} anchor was not found.')
    return source.replace(old, new, 1)


path = Path('src/App.tsx')
source = path.read_text(encoding='utf-8')

source = replace_once(
    source,
    "import AdsTxtPanel from './components/AdsTxtPanel';\n",
    "import AdsTxtPanel from './components/AdsTxtPanel';\n"
    "import AuditLogPanel from './components/AuditLogPanel';\n"
    "import GlobalPrebidBuildsPanel from './components/GlobalPrebidBuildsPanel';\n"
    "import GlobalReleasesPanel from './components/GlobalReleasesPanel';\n"
    "import SettingsPanel from './components/SettingsPanel';\n",
    'global workspace imports',
)

source = replace_once(
    source,
    "const navItems = ['Publishers', 'Releases', 'Prebid builds', 'Audit log', 'Settings'];\n",
    "const navItems = ['Publishers', 'Releases', 'Prebid builds', 'Audit log', 'Settings'] as const;\n"
    "type GlobalSection = (typeof navItems)[number];\n"
    "const globalDescriptions: Record<GlobalSection, string> = {\n"
    "  Publishers: 'Manage publisher accounts, sites and every site-level configuration workflow.',\n"
    "  Releases: 'Review immutable releases across all publishers and sites.',\n"
    "  'Prebid builds': 'Inspect every uploaded Prebid.js build and module manifest.',\n"
    "  'Audit log': 'Review configuration, release and operational activity recorded in D1.',\n"
    "  Settings: 'Check runtime health, bindings, security and retention safeguards.',\n"
    "};\n",
    'global navigation type',
)

source = replace_once(
    source,
    "  const [activePublisherId, setActivePublisherId] = useState<string | null>(null);\n",
    "  const [activeSection, setActiveSection] = useState<GlobalSection>('Publishers');\n"
    "  const [activePublisherId, setActivePublisherId] = useState<string | null>(null);\n",
    'active global section state',
)

source = replace_once(
    source,
    "  function selectPublisher(account: PublisherAccount) {\n"
    "    setActivePublisherId(account.id);\n"
    "    setActiveSiteId(account.sites[0]?.id ?? null);\n"
    "    setActiveTab('Overview');\n"
    "  }\n\n"
    "  function selectSite(accountId: string, selectedSite: Site) {\n"
    "    setActivePublisherId(accountId);\n"
    "    setActiveSiteId(selectedSite.id);\n"
    "  }\n",
    "  function selectPublisher(account: PublisherAccount) {\n"
    "    setActiveSection('Publishers');\n"
    "    setActivePublisherId(account.id);\n"
    "    setActiveSiteId(account.sites[0]?.id ?? null);\n"
    "    setActiveTab('Overview');\n"
    "  }\n\n"
    "  function selectSite(accountId: string, selectedSite: Site) {\n"
    "    setActiveSection('Publishers');\n"
    "    setActivePublisherId(accountId);\n"
    "    setActiveSiteId(selectedSite.id);\n"
    "  }\n\n"
    "  function selectGlobalSection(section: GlobalSection) {\n"
    "    setActiveSection(section);\n"
    "    setModal(null);\n"
    "  }\n\n"
    "  function openSiteWorkspace(\n"
    "    publisherAccountId: string,\n"
    "    siteId: string,\n"
    "    tab: 'Overview' | 'Releases' | 'Prebid.js',\n"
    "  ) {\n"
    "    setActivePublisherId(publisherAccountId);\n"
    "    setActiveSiteId(siteId);\n"
    "    setActiveTab(tab);\n"
    "    setActiveSection('Publishers');\n"
    "  }\n",
    'global navigation handlers',
)

source = replace_once(
    source,
    "  const siteModalOpen = modal === 'create-site' || modal === 'edit-site' || modal === 'duplicate-site';\n",
    "  const publisherWorkspace = activeSection === 'Publishers';\n"
    "  const siteModalOpen = modal === 'create-site' || modal === 'edit-site' || modal === 'duplicate-site';\n",
    'publisher workspace flag',
)

source = replace_once(
    source,
    "        <nav className=\"main-nav\" aria-label=\"Main navigation\">\n"
    "          {navItems.map((item, index) => (\n"
    "            <button className={index === 0 ? 'nav-item active' : 'nav-item'} key={item} type=\"button\">{item}</button>\n"
    "          ))}\n"
    "        </nav>\n",
    "        <nav className=\"main-nav\" aria-label=\"Main navigation\">\n"
    "          {navItems.map((item) => (\n"
    "            <button\n"
    "              className={item === activeSection ? 'nav-item active' : 'nav-item'}\n"
    "              key={item}\n"
    "              onClick={() => selectGlobalSection(item)}\n"
    "              type=\"button\"\n"
    "            >\n"
    "              {item}\n"
    "            </button>\n"
    "          ))}\n"
    "        </nav>\n",
    'clickable global navigation',
)

source = replace_once(
    source,
    "        <HierarchySidebar\n"
    "          activePublisherId={publisher?.id ?? null}\n"
    "          activeSiteId={site?.id ?? null}\n"
    "          error={hierarchyError}\n"
    "          loading={loading}\n"
    "          onAddSite={openCreateSiteForPublisher}\n"
    "          onCreatePublisher={openCreatePublisher}\n"
    "          onMoveSite={moveSiteToPublisher}\n"
    "          onSelectPublisher={selectPublisher}\n"
    "          onSelectSite={selectSite}\n"
    "          publishers={publishers}\n"
    "        />\n",
    "        {publisherWorkspace ? (\n"
    "          <HierarchySidebar\n"
    "            activePublisherId={publisher?.id ?? null}\n"
    "            activeSiteId={site?.id ?? null}\n"
    "            error={hierarchyError}\n"
    "            loading={loading}\n"
    "            onAddSite={openCreateSiteForPublisher}\n"
    "            onCreatePublisher={openCreatePublisher}\n"
    "            onMoveSite={moveSiteToPublisher}\n"
    "            onSelectPublisher={selectPublisher}\n"
    "            onSelectSite={selectSite}\n"
    "            publishers={publishers}\n"
    "          />\n"
    "        ) : (\n"
    "          <div className=\"global-sidebar-context\">\n"
    "            <span>Global workspace</span>\n"
    "            <strong>{activeSection}</strong>\n"
    "            <small>{publishers.length} publisher{publishers.length === 1 ? '' : 's'} · {totalSites} site{totalSites === 1 ? '' : 's'}</small>\n"
    "            <button onClick={() => selectGlobalSection('Publishers')} type=\"button\">← Return to publishers</button>\n"
    "          </div>\n"
    "        )}\n",
    'conditional hierarchy sidebar',
)

source = replace_once(
    source,
    "      <main className=\"workspace\">\n"
    "        <header className=\"topbar\">\n",
    "      <main className=\"workspace\">\n"
    "        {publisherWorkspace ? (\n"
    "          <>\n"
    "        <header className=\"topbar\">\n",
    'publisher workspace opening',
)

old_close = (
    "        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Debug' && activeTab !== 'Ads.txt'\n"
    "          ? renderPlaceholder(activeTab)\n"
    "          : null}\n"
    "      </main>\n"
)
new_close = (
    "        {activeTab !== 'Overview' && activeTab !== 'Config' && activeTab !== 'Prebid.js' && activeTab !== 'Releases' && activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Debug' && activeTab !== 'Ads.txt'\n"
    "          ? renderPlaceholder(activeTab)\n"
    "          : null}\n"
    "          </>\n"
    "        ) : (\n"
    "          <>\n"
    "            <header className=\"topbar global-topbar\">\n"
    "              <div>\n"
    "                <span className=\"eyebrow\">Global workspace / {activeSection}</span>\n"
    "                <h1>{activeSection}</h1>\n"
    "                <p>{globalDescriptions[activeSection]}</p>\n"
    "              </div>\n"
    "              <button className=\"button secondary\" onClick={() => selectGlobalSection('Publishers')} type=\"button\">Open publishers</button>\n"
    "            </header>\n"
    "            {activeSection === 'Releases' ? (\n"
    "              <GlobalReleasesPanel onOpenSite={openSiteWorkspace} publishers={publishers} />\n"
    "            ) : null}\n"
    "            {activeSection === 'Prebid builds' ? (\n"
    "              <GlobalPrebidBuildsPanel onOpenSite={openSiteWorkspace} publishers={publishers} />\n"
    "            ) : null}\n"
    "            {activeSection === 'Audit log' ? (\n"
    "              <AuditLogPanel onOpenSite={openSiteWorkspace} publishers={publishers} />\n"
    "            ) : null}\n"
    "            {activeSection === 'Settings' ? <SettingsPanel publishers={publishers} /> : null}\n"
    "          </>\n"
    "        )}\n"
    "      </main>\n"
)
source = replace_once(source, old_close, new_close, 'global workspace rendering')

path.write_text(source, encoding='utf-8')
print('Global sidebar workspaces integrated into App.tsx.')
