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
    "import MockupBuilderPanel from './components/MockupBuilderPanel';\nimport MonitoringPanel from './components/MonitoringPanel';\n",
    'MonitoringPanel import',
)

replace_once(
    'src/App.tsx',
    "const publisherTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Mockup', 'Debug', 'Ads.txt'] as const;",
    "const publisherTabs = ['Overview', 'Config', 'Prebid.js', 'Releases', 'Export', 'Mockup', 'Monitoring', 'Debug', 'Ads.txt'] as const;",
    'publisher tabs',
)

replace_once(
    'src/App.tsx',
    "        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n        {activeTab === 'Debug' && site ? (",
    "        {activeTab === 'Mockup' && site ? <MockupBuilderPanel publisherId={site.id} siteName={site.name} /> : null}\n        {activeTab === 'Monitoring' && site ? <MonitoringPanel site={site} /> : null}\n        {activeTab === 'Debug' && site ? (",
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
    "import './global-workspaces.css';\nimport './monitoring.css';\n",
    'monitoring stylesheet import',
)

replace_once(
    'worker/app-deploy.ts',
    "import { listAuditLog } from './audit-log';\n",
    "import { listAuditLog } from './audit-log';\nimport {\n  checkMonitoring,\n  getMonitoring,\n  previewMonitoringEmail,\n  runScheduledMonitoring,\n  sendMonitoringEmail,\n  updateMonitoring,\n  type EmailBinding,\n} from './monitoring';\n",
    'monitoring worker imports',
)

replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-20-tessera-branding-v18';",
    "const RUNTIME_BUILD = '2026-07-20-site-monitoring-v19';",
    'runtime build marker',
)

replace_once(
    'worker/app-deploy.ts',
    "  DEPLOY_CALLBACK_SECRET?: string;\n}",
    "  DEPLOY_CALLBACK_SECRET?: string;\n  EMAIL?: EmailBinding;\n}",
    'email binding type',
)

replace_once(
    'worker/app-deploy.ts',
    "        workerEntrypoint: 'worker/app-deploy.ts',\n",
    "        workerEntrypoint: 'worker/app-deploy.ts',\n        email: env.EMAIL ? 'configured' : 'not-bound',\n",
    'health email status',
)

monitoring_routes = """
    const monitoringActionMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/(check|email-preview|send-test|send-now)$/);
    if (monitoringActionMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      const siteId = decodeURIComponent(monitoringActionMatch[1]);
      const action = monitoringActionMatch[2];
      if (action === 'check') return withBuildHeader(await checkMonitoring(verified, env, siteId));
      if (action === 'email-preview') return withBuildHeader(await previewMonitoringEmail(verified, env, siteId));
      if (action === 'send-test') return withBuildHeader(await sendMonitoringEmail(verified, env, siteId, 'test'));
      return withBuildHeader(await sendMonitoringEmail(verified, env, siteId, 'manual'));
    }

    const monitoringMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring$/);
    if (monitoringMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(monitoringMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await getMonitoring(env, siteId));
      if (request.method === 'PUT') return withBuildHeader(await updateMonitoring(verified, env, siteId));
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

"""
replace_once(
    'worker/app-deploy.ts',
    "    const releaseDeleteMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/releases\\/([^/]+)$/);\n",
    monitoring_routes + "    const releaseDeleteMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/releases\\/([^/]+)$/);\n",
    'monitoring routes',
)

replace_once(
    'worker/app-deploy.ts',
    "    const response = await downstream.fetch(request, env, ctx);\n    return withBuildHeader(await brandTesseraHtmlResponse(response));\n  },\n} satisfies ExportedHandler<Env>;",
    "    const response = await downstream.fetch(request, env, ctx);\n    return withBuildHeader(await brandTesseraHtmlResponse(response));\n  },\n\n  scheduled(_controller, env, ctx) {\n    ctx.waitUntil(runScheduledMonitoring(env));\n  },\n} satisfies ExportedHandler<Env>;",
    'scheduled monitoring handler',
)

replace_once(
    'wrangler.jsonc',
    "  \"r2_buckets\": [\n    {\n      \"binding\": \"BUILDS\",\n      \"bucket_name\": \"prebid-professor-builds\"\n    }\n  ],\n  \"observability\": {",
    "  \"r2_buckets\": [\n    {\n      \"binding\": \"BUILDS\",\n      \"bucket_name\": \"prebid-professor-builds\"\n    }\n  ],\n  \"triggers\": {\n    \"crons\": [\"7 * * * *\"]\n  },\n  \"observability\": {",
    'hourly monitoring cron',
)

replace_once(
    'src/components/SettingsPanel.tsx',
    "  auth?: string;\n",
    "  auth?: string;\n  email?: string;\n",
    'settings health email type',
)

replace_once(
    'src/components/SettingsPanel.tsx',
    "            <div><span>Authentication</span><strong className={`settings-status ${statusClass(health?.auth)}`}>{display(health?.auth)}</strong></div>\n",
    "            <div><span>Authentication</span><strong className={`settings-status ${statusClass(health?.auth)}`}>{display(health?.auth)}</strong></div>\n            <div><span>Email Service</span><strong className={`settings-status ${statusClass(health?.email)}`}>{display(health?.email)}</strong></div>\n",
    'settings email status row',
)
