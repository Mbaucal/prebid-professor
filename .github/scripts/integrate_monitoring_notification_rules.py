from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if new in source:
        print(f'{label}: already applied')
        return
    if old not in source:
        raise SystemExit(f'{label} anchor was not found in {path}.')
    file_path.write_text(source.replace(old, new, 1), encoding='utf-8')
    print(f'{label}: applied')


def remove_once(path: str, value: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding='utf-8')
    if value not in source:
        print(f'{label}: already removed')
        return
    file_path.write_text(source.replace(value, '', 1), encoding='utf-8')
    print(f'{label}: removed')


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding='utf-8')
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f'Integration validation failed in {path}: {missing}')


replace_once(
    'worker/app-deploy.ts',
    "import { sendMonitoringTestEmail, type EmailBinding } from './monitoring-email-send';\n",
    "import { getMonitoringNotificationSettings, updateMonitoringNotificationSettings } from './monitoring-notification-settings';\nimport { runMonitoringNotification } from './monitoring-notification-run';\n",
    'notification worker imports',
)
replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-25-monitoring-gmail-identity-v25';",
    "const RUNTIME_BUILD = '2026-07-25-monitoring-notification-rules-v26';",
    'notification runtime marker',
)
remove_once(
    'worker/app-deploy.ts',
    '  EMAIL?: EmailBinding;\n',
    'obsolete email env binding',
)
remove_once(
    'worker/app-deploy.ts',
    "        email: env.EMAIL ? 'configured' : 'not-bound',\n",
    'obsolete email health field',
)
old_cloudflare_route = """    const monitoringEmailSendTestMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/email-send-test$/);
    if (monitoringEmailSendTestMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await sendMonitoringTestEmail(
        verified,
        env,
        decodeURIComponent(monitoringEmailSendTestMatch[1]),
      ));
    }

"""
remove_once('worker/app-deploy.ts', old_cloudflare_route, 'obsolete Cloudflare email route')
notification_route_anchor = """    const monitoringGmailSendTestMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/gmail-send-test$/);
"""
notification_routes = """    const monitoringNotificationSettingsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/notification-settings$/);
    if (monitoringNotificationSettingsMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(monitoringNotificationSettingsMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await getMonitoringNotificationSettings(env, siteId));
      if (request.method === 'PUT') return withBuildHeader(await updateMonitoringNotificationSettings(verified, env, siteId));
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const monitoringNotificationRunMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/notifications\/run$/);
    if (monitoringNotificationRunMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await runMonitoringNotification(
        verified,
        env,
        decodeURIComponent(monitoringNotificationRunMatch[1]),
      ));
    }

    const monitoringGmailSendTestMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/gmail-send-test$/);
"""
replace_once(
    'worker/app-deploy.ts',
    notification_route_anchor,
    notification_routes,
    'notification API routes',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "import GmailConnectionPanel from './GmailConnectionPanel';\n",
    "import GmailConnectionPanel from './GmailConnectionPanel';\nimport MonitoringNotificationRules from './MonitoringNotificationRules';\n",
    'notification rules component import',
)
remove_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "  capabilities: {\n    email: boolean;\n  };\n",
    'obsolete monitoring email capability type',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "  '{{sender_name}}',\n",
    "  '{{sender_name}}',\n  '{{notification_kind}}',\n",
    'notification template variable',
)
remove_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "      if (!draft.senderEmail.trim()) warnings.push('Sender email is empty.');\n",
    'obsolete sender email warning',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    '          <p>Runtime checks remain read-only. Email templates can be previewed, saved per site and manually test-sent when the Cloudflare EMAIL binding is ready.</p>',
    '          <p>Runtime checks remain read-only. Email templates can be previewed, saved per site, sent through the connected Gmail account and evaluated against staged notification rules.</p>',
    'monitoring Gmail heading copy',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "                <span className={`monitor-readonly-pill ${payload.capabilities.email ? 'healthy' : 'warning'}`}>\n                  {payload.capabilities.email ? 'MANUAL TEST READY' : 'EMAIL BINDING MISSING'}\n                </span>",
    "                <span className={`monitor-readonly-pill ${gmailConnected ? 'healthy' : 'warning'}`}>\n                  {gmailConnected ? 'GMAIL READY' : 'GMAIL DISCONNECTED'}\n                </span>",
    'Gmail status badge',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "              <label><span>Sender email</span><input onChange={(event) => updateDraft('senderEmail', event.target.value)} placeholder=\"alerts@example.com\" type=\"email\" value={draft.senderEmail} /></label>",
    "              <label><span>Sender account</span><input disabled value={gmailEmail ?? 'Connect Gmail above'} /></label>",
    'connected Gmail sender field',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "                  <div><span>From</span><strong>{draft.senderName || '—'}{draft.senderEmail ? ` <${draft.senderEmail}>` : ''}</strong></div>",
    "                  <div><span>From</span><strong>{draft.senderName || '—'}{gmailEmail ? ` <${gmailEmail}>` : ''}</strong></div>",
    'Gmail preview sender',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    '              emailConfigured={gmailConnected}',
    '              gmailConnected={gmailConnected}',
    'Gmail test prop',
)
remove_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    '              senderEmail={gmailEmail ?? draft.senderEmail}\n',
    'obsolete sender email prop',
)
rules_anchor = """            />
          </article>

          <div className="monitor-readonly-note">
"""
rules_insert = """            />
          </article>

          <MonitoringNotificationRules
            gmailConnected={gmailConnected}
            siteId={site.id}
            templateSaved={Boolean(serverDraft?.saved)}
          />

          <div className="monitor-readonly-note">
"""
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    rules_anchor,
    rules_insert,
    'notification rules render',
)
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    '            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Only the explicit Send test email action sends a message; no Cron, reminder, recovery workflow, release mutation or R2 write is enabled.',
    '            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Gmail test sends and manual rule evaluation are explicit actions; the scheduler is still disabled on this preview branch and no release or R2 object is modified.',
    'notification preview safety note',
)

old_sender = Path('worker/monitoring-email-send.ts')
if old_sender.exists():
    old_sender.unlink()
    print('obsolete Cloudflare email sender: removed')
else:
    print('obsolete Cloudflare email sender: already removed')

require(
    'worker/app-deploy.ts',
    '2026-07-25-monitoring-notification-rules-v26',
    "from './monitoring-notification-settings'",
    "from './monitoring-notification-run'",
    '/monitoring\\/notification-settings',
    '/monitoring\\/notifications\\/run',
)
require(
    'src/components/MonitoringReadonlyPanel.tsx',
    "from './MonitoringNotificationRules'",
    '{{notification_kind}}',
    'GMAIL READY',
    '<MonitoringNotificationRules',
    'gmailConnected={gmailConnected}',
)
if "monitoring-email-send'" in Path('worker/app-deploy.ts').read_text(encoding='utf-8'):
    raise SystemExit('Obsolete Cloudflare email sender import remains in worker/app-deploy.ts.')
if 'payload.capabilities.email' in Path('src/components/MonitoringReadonlyPanel.tsx').read_text(encoding='utf-8'):
    raise SystemExit('Obsolete Cloudflare email capability remains in MonitoringReadonlyPanel.tsx.')
print('Monitoring notification rules integration validation passed.')
