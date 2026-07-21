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
    'src/components/MonitoringReadonlyPanel.tsx',
    "import type { Site } from '../shared/types';\n",
    "import type { Site } from '../shared/types';\nimport MonitoringEmailSendTest from './MonitoringEmailSendTest';\n",
    'manual test component import',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "  messages: string[];\n  readOnly: true;\n};",
    "  messages: string[];\n  readOnly: true;\n  capabilities: {\n    email: boolean;\n  };\n};",
    'monitoring capabilities type',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "          <p>Runtime checks remain read-only. Email templates can be previewed and optionally saved per site in Tessera, but email sending is still disabled.</p>",
    "          <p>Runtime checks remain read-only. Email templates can be previewed, saved per site and manually test-sent when the Cloudflare EMAIL binding is ready.</p>",
    'monitoring heading copy',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    '                <span className="monitor-readonly-pill warning">NO EMAIL SENDING</span>',
    "                <span className={`monitor-readonly-pill ${payload.capabilities.email ? 'healthy' : 'warning'}`}>\n                  {payload.capabilities.email ? 'MANUAL TEST READY' : 'EMAIL BINDING MISSING'}\n                </span>",
    'email capability badge',
)

preview_anchor = """            ) : null}
          </article>

          <div className=\"monitor-readonly-note\">
"""
preview_insert = """            ) : null}
            <MonitoringEmailSendTest
              attachmentContent={preview?.attachmentContent ?? ''}
              attachmentName={preview?.attachmentName ?? ''}
              body={preview?.body ?? ''}
              bodyFormat={preview?.bodyFormat ?? 'plain'}
              cc={draft.cc}
              emailConfigured={payload.capabilities.email}
              previewReady={Boolean(preview)}
              replyTo={draft.replyTo}
              senderEmail={draft.senderEmail}
              senderName={draft.senderName}
              siteId={site.id}
              subject={preview?.subject ?? ''}
              to={draft.to}
            />
          </article>

          <div className=\"monitor-readonly-note\">
"""
replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    preview_anchor,
    preview_insert,
    'manual test component render',
)

replace_once(
    'src/components/MonitoringReadonlyPanel.tsx',
    "            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Saving creates or updates only an isolated per-site email-draft record; no email is sent, no Cron runs and no release or R2 object is modified.",
    "            <strong>Safe staged rollout:</strong> runtime monitoring remains read-only. Only the explicit Send test email action sends a message; no Cron, reminder, recovery workflow, release mutation or R2 write is enabled.",
    'monitoring safety note',
)

replace_once(
    'src/main.tsx',
    "import './monitoring-email-preview.css';\n",
    "import './monitoring-email-preview.css';\nimport './monitoring-email-send.css';\n",
    'manual test stylesheet import',
)

replace_once(
    'worker/monitoring-readonly.ts',
    "export interface MonitoringReadonlyEnv extends DatabaseEnv {\n  BUILDS?: R2Bucket;\n}",
    "export interface MonitoringReadonlyEnv extends DatabaseEnv {\n  BUILDS?: R2Bucket;\n  EMAIL?: unknown;\n}",
    'monitoring email capability env',
)

replace_once(
    'worker/monitoring-readonly.ts',
    "    messages: Array.from(new Set(messages)),\n    readOnly: true,\n",
    "    messages: Array.from(new Set(messages)),\n    readOnly: true,\n    capabilities: {\n      email: Boolean(env.EMAIL),\n    },\n",
    'monitoring capabilities response',
)

replace_once(
    'worker/app-deploy.ts',
    "import { getMonitoringEmailDraft, updateMonitoringEmailDraft } from './monitoring-email-settings';\n",
    "import { getMonitoringEmailDraft, updateMonitoringEmailDraft } from './monitoring-email-settings';\nimport { sendMonitoringTestEmail, type EmailBinding } from './monitoring-email-send';\n",
    'manual test sender import',
)

replace_once(
    'worker/app-deploy.ts',
    "const RUNTIME_BUILD = '2026-07-21-monitoring-draft-storage-v22';",
    "const RUNTIME_BUILD = '2026-07-21-monitoring-test-email-v23';",
    'monitoring v23 marker',
)

replace_once(
    'worker/app-deploy.ts',
    "  DEPLOY_CALLBACK_SECRET?: string;\n}",
    "  DEPLOY_CALLBACK_SECRET?: string;\n  EMAIL?: EmailBinding;\n}",
    'email binding env type',
)

replace_once(
    'worker/app-deploy.ts',
    "        workerEntrypoint: 'worker/app-deploy.ts',\n",
    "        workerEntrypoint: 'worker/app-deploy.ts',\n        email: env.EMAIL ? 'configured' : 'not-bound',\n",
    'health email capability',
)

route_anchor = """    const monitoringEmailSettingsMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-settings$/);
"""
route_insert = """    const monitoringEmailSendTestMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-send-test$/);
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

    const monitoringEmailSettingsMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/monitoring\\/email-settings$/);
"""
replace_once(
    'worker/app-deploy.ts',
    route_anchor,
    route_insert,
    'manual test email route',
)

replace_once(
    'wrangler.jsonc',
    "  \"r2_buckets\": [\n    {\n      \"binding\": \"BUILDS\",\n      \"bucket_name\": \"prebid-professor-builds\"\n    }\n  ],\n  \"observability\": {",
    "  \"r2_buckets\": [\n    {\n      \"binding\": \"BUILDS\",\n      \"bucket_name\": \"prebid-professor-builds\"\n    }\n  ],\n  \"send_email\": [\n    {\n      \"name\": \"EMAIL\"\n    }\n  ],\n  \"observability\": {",
    'Cloudflare send_email binding',
)
