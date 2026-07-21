from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if new in source:
        return
    if old not in source:
        raise SystemExit(f'{label} anchor was not found in {path}.')
    file_path.write_text(source.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/App.tsx',
    "import MockupBuilderPanel from './components/MockupBuilderPanel';\n",
    "import MockupBuilderPanel from './components/MockupBuilderPanel';\nimport MonitoringReadonlyPanel from './components/MonitoringReadonlyPanel';\n",
    'MonitoringReadonlyPanel import',
)

replace_once(
    'src/App.tsx',
    "const publisherTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Mockup', 'Debug', 'Ads.txt'] as const;",
    "const publisherTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Mockup', 'Monitoring', 'Debug', 'Ads.txt'] as const;",
    'Monitoring tab',
)

replace_once(
    'src/App.tsx',
    "        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n        {activeTab === 'Debug' && site ? (",
    "        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n        {activeTab === 'Monitoring' && site ? <MonitoringReadonlyPanel site={site} /> : null}\n        {activeTab === 'Debug' && site ? (",
    'Monitoring panel render',
)

replace_once(
    'src/App.tsx',
    "activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Debug' && activeTab !== 'Ads.txt'",
    "activeTab !== 'Export' && activeTab !== 'Mockup' && activeTab !== 'Monitoring' && activeTab !== 'Debug' && activeTab !== 'Ads.txt'",
    'Monitoring placeholder exclusion',
)

replace_once(
    'src/main.tsx',
    "import './global-workspaces.css';\n",
    "import './global-workspaces.css';\nimport './monitoring-readonly.css';\n",
    'Monitoring stylesheet',
)

replace_once(
    'worker/app-deploy.ts',
    "import { listAuditLog } from './audit-log';\n",
    "import { listAuditLog } from './audit-log';\nimport { getMonitoringStatus } from './monitoring-readonly';\n",
    'Monitoring API import',
)

replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-21-tessera-ui-stable';",
    "const RUNTIME_BUILD = '2026-07-21-monitoring-readonly-v20';",
    'Runtime marker',
)

monitoring_route = """    const monitoringStatusMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/status$/);
    if (monitoringStatusMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'GET') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await getMonitoringStatus(
        verified,
        env,
        decodeURIComponent(monitoringStatusMatch[1]),
      ));
    }

"""
replace_once(
    'worker/app-deploy.ts',
    "    const releaseDeleteMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/releases\\/([^/]+)$/);\n",
    monitoring_route + "    const releaseDeleteMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/releases\\/([^/]+)$/);\n",
    'Monitoring API route',
)
