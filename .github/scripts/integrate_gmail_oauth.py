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
    'worker/app-deploy.ts',
    "import { getMonitoringStatus } from './monitoring-readonly';\n",
    "import { getMonitoringStatus } from './monitoring-readonly';\nimport { disconnectGmail, finishGmailConnect, getGmailStatus, startGmailConnect, type GmailOAuthEnv } from './gmail-oauth';\nimport { sendGmailTest } from './gmail-send';\n",
    'gmail worker imports',
)
replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-21-monitoring-test-email-v23';",
    "const RUNTIME_BUILD = '2026-07-21-monitoring-gmail-oauth-v24';",
    'gmail runtime marker',
)
replace_once(
    'worker/app-deploy.ts',
    "  EMAIL?: EmailBinding;\n}",
    "  EMAIL?: EmailBinding;\n  GOOGLE_OAUTH_CLIENT_ID?: string;\n  GOOGLE_OAUTH_CLIENT_SECRET?: string;\n  GMAIL_TOKEN_ENCRYPTION_KEY?: string;\n}",
    'gmail env secrets',
)
replace_once(
    'worker/app-deploy.ts',
    "    if (request.method === 'GET' && pathname === '/api/audit-log') {",
    "    if (request.method === 'GET' && pathname === '/api/integrations/gmail/callback') {\n      return withBuildHeader(await finishGmailConnect(request, env as GmailOAuthEnv));\n    }\n\n    if (pathname === '/api/integrations/gmail/status') {\n      const verified = await authenticatedRequest(request, env);\n      if (verified instanceof Response) return withBuildHeader(verified);\n      if (request.method !== 'GET') return withBuildHeader(apiError('Method not allowed.', 405));\n      return withBuildHeader(await getGmailStatus(env as GmailOAuthEnv));\n    }\n\n    if (pathname === '/api/integrations/gmail/connect') {\n      const verified = await authenticatedRequest(request, env);\n      if (verified instanceof Response) return withBuildHeader(verified);\n      if (request.method !== 'GET') return withBuildHeader(apiError('Method not allowed.', 405));\n      return withBuildHeader(await startGmailConnect(verified, env as GmailOAuthEnv));\n    }\n\n    if (pathname === '/api/integrations/gmail/disconnect') {\n      const verified = await authenticatedRequest(request, env);\n      if (verified instanceof Response) return withBuildHeader(verified);\n      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));\n      return withBuildHeader(await disconnectGmail(env as GmailOAuthEnv));\n    }\n\n    if (request.method === 'GET' && pathname === '/api/audit-log') {",
    'gmail oauth routes',
)
replace_once(
    'worker/app-deploy.ts',
    "    const monitoringEmailSendTestMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-send-test$/);",
    "    const monitoringGmailSendTestMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/gmail-send-test$/);\n    if (monitoringGmailSendTestMatch) {\n      const verified = await authenticatedRequest(request, env);\n      if (verified instanceof Response) return withBuildHeader(verified);\n      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));\n      return withBuildHeader(await sendGmailTest(verified, env as GmailOAuthEnv));\n    }\n\n    const monitoringEmailSendTestMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-send-test$/);",
    'gmail send route',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "import MonitoringEmailSendTest from './MonitoringEmailSendTest';\n",
    "import MonitoringEmailSendTest from './MonitoringEmailSendTest';\nimport GmailConnectionPanel from './GmailConnectionPanel';\n",
    'gmail panel import',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "  const [serverSaving, setServerSaving] = useState(false);",
    "  const [serverSaving, setServerSaving] = useState(false);\n  const [gmailConnected, setGmailConnected] = useState(false);\n  const [gmailEmail, setGmailEmail] = useState<string | null>(null);",
    'gmail state',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "          <article className=\"monitor-readonly-card monitor-email-builder\">",
    "          <GmailConnectionPanel onConnectionChange={(connected, email) => { setGmailConnected(connected); setGmailEmail(email); }} />\n\n          <article className=\"monitor-readonly-card monitor-email-builder\">",
    'gmail panel render',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "               emailConfigured={payload.capabilities.email}",
    "               emailConfigured={gmailConnected}",
    'gmail configured prop',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "               senderEmail={draft.senderEmail}",
    "               senderEmail={gmailEmail ?? draft.senderEmail}",
    'gmail sender prop',
)
replace_once(
    'src/components/MonitoringEmailSendTest.tsx',
    "`/api/publishers/${encodeURIComponent(props.siteId)}/monitoring/email-send-test`,",
    "`/api/publishers/${encodeURIComponent(props.siteId)}/monitoring/gmail-send-test`,",
    'gmail send endpoint',
)
replace_once(
    'src/main.tsx',
    "import './monitoring-email-send.css';\n",
    "import './monitoring-email-send.css';\nimport './gmail-connection.css';\n",
    'gmail css import',
)
