from pathlib import Path


BRANCH_SCHEDULE = "0 6 * * *"


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if new in source:
        print(f"{label}: already applied")
        return
    if old not in source:
        raise SystemExit(f"{label} anchor was not found in {path}.")
    file_path.write_text(source.replace(old, new, 1), encoding="utf-8")
    print(f"{label}: applied")


def remove_once(path: str, value: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if value not in source:
        print(f"{label}: already removed")
        return
    file_path.write_text(source.replace(value, "", 1), encoding="utf-8")
    print(f"{label}: removed")


def write_text(path: str, content: str, label: str) -> None:
    file_path = Path(path)
    normalized = content.rstrip() + "\n"
    if file_path.exists() and file_path.read_text(encoding="utf-8") == normalized:
        print(f"{label}: already current")
        return
    file_path.write_text(normalized, encoding="utf-8")
    print(f"{label}: written")


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f"Integration validation failed in {path}: {missing}")


def forbid(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    found = [needle for needle in needles if needle in source]
    if found:
        raise SystemExit(f"Integration validation found forbidden content in {path}: {found}")


# Keep the full ads.txt body private to the internal notification evaluation.
replace_once(
    "worker/ads-txt.ts",
    """export async function checkAdsTxt(
  _request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();""",
    """export async function checkAdsTxt(
  _request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  const includeInternalSnapshot = _request.headers.get('x-tessera-monitoring-snapshot') === '1';
  if (!env.DB) return databaseMissing();""",
    "internal ads.txt snapshot flag",
)
replace_once(
    "worker/ads-txt.ts",
    """        results,
        missing,
        optionalMissing,
      },""",
    """        results,
        missing,
        optionalMissing,
        ...(includeInternalSnapshot ? { content: fetched.text } : {}),
      },""",
    "internal ads.txt snapshot content",
)

# Let rule delivery reuse the exact same live snapshot without a second network fetch.
replace_once(
    "worker/monitoring-email-preview.ts",
    "export interface MonitoringEmailPreviewEnv extends DatabaseEnv {}\n",
    """export interface MonitoringEmailPreviewEnv extends DatabaseEnv {}

export type MonitoringEmailLiveSnapshot = {
  fetchedAt: string;
  finalUrl: string | null;
  httpStatus: number | null;
  content: string;
  error: string | null;
};
""",
    "monitoring preview snapshot type",
)
replace_once(
    "worker/monitoring-email-preview.ts",
    """export async function getMonitoringEmailPreviewData(
  env: MonitoringEmailPreviewEnv,
  siteId: string,
): Promise<Response> {""",
    """export async function getMonitoringEmailPreviewData(
  env: MonitoringEmailPreviewEnv,
  siteId: string,
  snapshot?: MonitoringEmailLiveSnapshot,
): Promise<Response> {""",
    "monitoring preview snapshot parameter",
)
replace_once(
    "worker/monitoring-email-preview.ts",
    """  const adsTxtUrl = site.ads_txt_url || `https://${site.domain}/ads.txt`;
  const fetchedAt = new Date().toISOString();
  let liveContent = '';
  let finalUrl: string | null = null;
  let httpStatus: number | null = null;
  let fetchError: string | null = null;

  try {
    const fetched = await fetchAdsTxt(adsTxtUrl);
    liveContent = fetched.content;
    finalUrl = fetched.finalUrl;
    httpStatus = fetched.httpStatus;
    if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
      fetchError = `ads.txt returned HTTP ${fetched.httpStatus}.`;
    }
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }""",
    """  const adsTxtUrl = site.ads_txt_url || `https://${site.domain}/ads.txt`;
  const fetchedAt = snapshot?.fetchedAt ?? new Date().toISOString();
  let liveContent = snapshot?.content ?? '';
  let finalUrl: string | null = snapshot?.finalUrl ?? null;
  let httpStatus: number | null = snapshot?.httpStatus ?? null;
  let fetchError: string | null = snapshot?.error ?? null;

  if (!snapshot) {
    try {
      const fetched = await fetchAdsTxt(adsTxtUrl);
      liveContent = fetched.content;
      finalUrl = fetched.finalUrl;
      httpStatus = fetched.httpStatus;
      if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
        fetchError = `ads.txt returned HTTP ${fetched.httpStatus}.`;
      }
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
    }
  }""",
    "monitoring preview snapshot reuse",
)

# Healthy checks must never send a recovery email. Keep the legacy setting false
# for backward-compatible JSON parsing while removing it from operator controls.
replace_once(
    "worker/monitoring-notification-settings.ts",
    "  recoveryEnabled: true,\n",
    "  recoveryEnabled: false,\n",
    "disable recovery by default",
)
replace_once(
    "worker/monitoring-notification-settings.ts",
    "    recoveryEnabled: input.recoveryEnabled !== false,\n",
    "    recoveryEnabled: false,\n",
    "force recovery disabled",
)
replace_once(
    "worker/monitoring-notification-settings.ts",
    """export async function readMonitoringNotificationState(
  db: D1Database,
  siteId: string,
): Promise<MonitoringNotificationState> {""",
    """export async function listEnabledMonitoringSiteIds(db: D1Database): Promise<string[]> {
  await ensureMonitoringNotificationTables(db);
  const result = await db.prepare(
    `SELECT site_id, settings_json
     FROM monitoring_notification_settings
     ORDER BY site_id`,
  ).all<{ site_id: string; settings_json: string }>();

  return (result.results ?? [])
    .filter((row) => normalizeSettings(parseJsonRecord(row.settings_json)).settings.enabled)
    .map((row) => row.site_id);
}

export async function readMonitoringNotificationState(
  db: D1Database,
  siteId: string,
): Promise<MonitoringNotificationState> {""",
    "enabled monitoring site lookup",
)
replace_once(
    "worker/monitoring-notification-settings.ts",
    "      scheduler: 'manual-preview-only',\n",
    "      scheduler: 'daily-cron-06-utc',\n",
    "daily scheduler metadata",
)

replace_once(
    "worker/monitoring-notification-run.ts",
    """type AdsTxtCheck = {
  status?: string;
  url?: string;
  finalUrl?: string | null;
  fetchedAt?: string;
  httpStatus?: number | null;
  requiredMissingCount?: number;
  missing?: AdsTxtEntry[];
};""",
    """type AdsTxtCheck = {
  status?: string;
  url?: string;
  finalUrl?: string | null;
  fetchedAt?: string;
  httpStatus?: number | null;
  message?: string;
  content?: string;
  requiredMissingCount?: number;
  missing?: AdsTxtEntry[];
};""",
    "notification ads.txt snapshot shape",
)
replace_once(
    "worker/monitoring-notification-run.ts",
    """async function readCheck(env: MonitoringNotificationRunEnv, siteId: string): Promise<AdsTxtCheck> {
  const response = await checkAdsTxt(new Request(`https://monitoring.internal/${encodeURIComponent(siteId)}`), env, siteId);""",
    """async function readCheck(env: MonitoringNotificationRunEnv, siteId: string): Promise<AdsTxtCheck> {
  const response = await checkAdsTxt(
    new Request(`https://monitoring.internal/${encodeURIComponent(siteId)}`, {
      headers: { 'x-tessera-monitoring-snapshot': '1' },
    }),
    env,
    siteId,
  );""",
    "internal ads.txt snapshot request",
)
replace_once(
    "worker/monitoring-notification-run.ts",
    """async function readPreviewData(env: MonitoringNotificationRunEnv, siteId: string): Promise<PreviewData> {
  const response = await getMonitoringEmailPreviewData(env, siteId);
  const payload = await response.json() as PreviewData & { error?: string; details?: unknown };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Email preview data returned HTTP ${response.status}.`);
  }
  return payload;
}""",
    """async function readPreviewData(
  env: MonitoringNotificationRunEnv,
  siteId: string,
  check: AdsTxtCheck,
): Promise<PreviewData> {
  const response = await getMonitoringEmailPreviewData(env, siteId, {
    fetchedAt: check.fetchedAt || new Date().toISOString(),
    finalUrl: check.finalUrl ?? null,
    httpStatus: check.httpStatus ?? null,
    content: check.content ?? '',
    error: check.status === 'fetch-error'
      ? check.message || 'ads.txt could not be fetched.'
      : null,
  });
  const payload = await response.json() as PreviewData & { error?: string; details?: unknown };
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Email preview data returned HTTP ${response.status}.`);
  }
  return payload;
}""",
    "single ads.txt snapshot for email delivery",
)
replace_once(
    "worker/monitoring-notification-run.ts",
    """  if (status === 'ok') {
    if (settings.recoveryEnabled && state.lastNotifiedFingerprint && state.lastNotifiedAt) {
      return { kind: 'recovery', reason: 'The site recovered after a previously notified missing-entry state.' };
    }
    return { kind: 'none', reason: 'Ads.txt is healthy and no recovery notification is pending.' };
  }""",
    """  if (status === 'ok') {
    return { kind: 'none', reason: 'Ads.txt is healthy. The daily check is recorded without sending email.' };
  }""",
    "healthy checks never send email",
)
replace_once(
    "worker/monitoring-notification-run.ts",
    """    const [preview, manifestVersion] = await Promise.all([
      readPreviewData(env, siteId),
      readManifestVersion(env, siteId),
    ]);""",
    """    const [preview, manifestVersion] = await Promise.all([
      readPreviewData(env, siteId, check),
      readManifestVersion(env, siteId),
    ]);""",
    "notification preview uses check snapshot",
)

scheduler_source = """import { apiError, getActor, json } from './http';
import { runMonitoringNotification, type MonitoringNotificationRunEnv } from './monitoring-notification-run';
import { listEnabledMonitoringSiteIds } from './monitoring-notification-settings';

export const MONITORING_DAILY_CRON = '0 6 * * *';
const MAX_CONCURRENCY = 4;

type EvaluationResult = {
  siteId: string;
  ok: boolean;
  sent: boolean;
  decision: string;
  reason: string;
  adsTxtStatus: string;
  missingCount: number;
  error: string | null;
};

export type MonitoringDailyScheduleSummary = {
  cron: string;
  actor: string;
  startedAt: string;
  finishedAt: string;
  enabledSites: number;
  checked: number;
  sent: number;
  skipped: number;
  failed: number;
  results: EvaluationResult[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

async function evaluateSite(
  env: MonitoringNotificationRunEnv,
  siteId: string,
  actor: string,
): Promise<EvaluationResult> {
  try {
    const response = await runMonitoringNotification(
      new Request(`https://monitoring.scheduler/${encodeURIComponent(siteId)}`, {
        method: 'POST',
        headers: { 'x-user-email': actor },
      }),
      env,
      siteId,
    );

    let payload: Record<string, unknown> = {};
    try {
      const parsed = await response.json() as unknown;
      if (isRecord(parsed)) payload = parsed;
    } catch {
      // A non-JSON response is reported below as a failed evaluation.
    }

    const ok = response.ok && payload.ok === true;
    const sent = payload.sent === true;
    const error = ok
      ? null
      : textValue(payload.error) || textValue(payload.details) || `Evaluation returned HTTP ${response.status}.`;

    return {
      siteId,
      ok,
      sent,
      decision: textValue(payload.decision) || (sent ? 'sent' : 'none'),
      reason: textValue(payload.reason),
      adsTxtStatus: textValue(payload.adsTxtStatus),
      missingCount: numberValue(payload.missingCount),
      error,
    };
  } catch (error) {
    return {
      siteId,
      ok: false,
      sent: false,
      decision: 'failed',
      reason: '',
      adsTxtStatus: '',
      missingCount: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runMonitoringDailySchedule(
  env: MonitoringNotificationRunEnv,
  actor = 'cloudflare-cron',
): Promise<MonitoringDailyScheduleSummary> {
  if (!env.DB) throw new Error('D1 database binding is not configured.');

  const startedAt = new Date().toISOString();
  const siteIds = await listEnabledMonitoringSiteIds(env.DB);
  const results = new Array<EvaluationResult>(siteIds.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= siteIds.length) return;
      results[index] = await evaluateSite(env, siteIds[index], actor);
    }
  }

  const workerCount = Math.min(MAX_CONCURRENCY, siteIds.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const summary: MonitoringDailyScheduleSummary = {
    cron: MONITORING_DAILY_CRON,
    actor,
    startedAt,
    finishedAt: new Date().toISOString(),
    enabledSites: siteIds.length,
    checked: results.length,
    sent: results.filter((result) => result.sent).length,
    skipped: results.filter((result) => result.ok && !result.sent).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };

  console.log(JSON.stringify({
    event: 'monitoring.daily.completed',
    cron: summary.cron,
    enabledSites: summary.enabledSites,
    checked: summary.checked,
    sent: summary.sent,
    skipped: summary.skipped,
    failed: summary.failed,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
  }));

  return summary;
}

export async function runMonitoringDailyScheduleHttp(
  request: Request,
  env: MonitoringNotificationRunEnv,
): Promise<Response> {
  try {
    const summary = await runMonitoringDailySchedule(env, `manual-scheduler:${getActor(request)}`);
    return json({ ok: true, ...summary });
  } catch (error) {
    return apiError(
      'Daily monitoring run failed.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}
"""
write_text("worker/monitoring-scheduler.ts", scheduler_source, "daily monitoring scheduler")

replace_once(
    "worker/app-deploy.ts",
    "import { runMonitoringNotification } from './monitoring-notification-run';\n",
    """import { runMonitoringNotification } from './monitoring-notification-run';
import { runMonitoringDailySchedule, runMonitoringDailyScheduleHttp } from './monitoring-scheduler';
""",
    "daily scheduler worker imports",
)
replace_once(
    "worker/app-deploy.ts",
    "const RUNTIME_BUILD = '2026-07-26-monitoring-premerge-v28';",
    "const RUNTIME_BUILD = '2026-07-29-monitoring-daily-cron-v29';",
    "daily scheduler runtime marker",
)
replace_once(
    "worker/app-deploy.ts",
    """    if (request.method === 'GET' && pathname === '/api/audit-log') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      return withBuildHeader(await listAuditLog(verified, env));
    }

    const adsTxtCheckMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/check$/);""",
    """    if (request.method === 'GET' && pathname === '/api/audit-log') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      return withBuildHeader(await listAuditLog(verified, env));
    }

    if (pathname === '/api/monitoring/daily/run') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await runMonitoringDailyScheduleHttp(verified, env));
    }

    const adsTxtCheckMatch = pathname.match(/^\\/api\\/publishers\\/([^/]+)\\/ads-txt\\/check$/);""",
    "authenticated daily scheduler test route",
)
replace_once(
    "worker/app-deploy.ts",
    """    const response = await downstream.fetch(request, env, ctx);
    return withBuildHeader(await brandTesseraHtmlResponse(response));
  },
} satisfies ExportedHandler<Env>;""",
    """    const response = await downstream.fetch(request, env, ctx);
    return withBuildHeader(await brandTesseraHtmlResponse(response));
  },

  async scheduled(controller, env): Promise<void> {
    await runMonitoringDailySchedule(env, `cloudflare-cron:${controller.cron}`);
  },
} satisfies ExportedHandler<Env>;""",
    "Cloudflare scheduled handler",
)

replace_once(
    "wrangler.jsonc",
    """  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "d1_databases": [""",
    """  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "triggers": {
    "crons": ["0 6 * * *"]
  },
  "d1_databases": [""",
    "Cloudflare daily cron configuration",
)

replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    "  scheduler: 'manual-preview-only';\n",
    "  scheduler: 'daily-cron-06-utc';\n",
    "notification scheduler response type",
)
replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    """          <span className="monitor-readonly-pill warning">PREVIEW: MANUAL EVALUATION</span>""",
    """          <span className="monitor-readonly-pill healthy">CRON READY · 06:00 UTC</span>""",
    "daily scheduler status badge",
)
replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    """        Configure the exact conditions now. On this preview branch the scheduler is intentionally disabled;
        use Evaluate rules now to run the same decision engine manually.""",
    """        The daily check is configured for 06:00 UTC and activates with the production deployment.
        Use Evaluate rules now for preview testing. Healthy checks are logged without sending email.""",
    "daily scheduler operator copy",
)
remove_once(
    "src/components/MonitoringNotificationRules.tsx",
    """            <label className="monitor-rule-toggle">
              <input checked={settings.recoveryEnabled} onChange={(event) => update('recoveryEnabled', event.target.checked)} type="checkbox" />
              <span><strong>Send a recovery email</strong><small>Sends once after a previously notified issue becomes OK.</small></span>
            </label>
""",
    "recovery email toggle",
)
replace_once(
    "src/components/MonitoringNotificationRules.tsx",
    """            <div><span>Scheduler</span><strong>Manual preview only</strong></div>""",
    """            <div><span>Scheduler</span><strong>Daily · 06:00 UTC</strong></div>""",
    "daily scheduler prerequisite",
)
remove_once(
    "src/components/MonitoringNotificationRules.tsx",
    """            <div><span>Last recovery</span><strong>{formatTime(bundle.state.lastRecoveryAt)}</strong></div>
""",
    "last recovery UI",
)

replace_once(
    "src/components/MonitoringReadonlyPanel.tsx",
    "import { useCallback, useEffect, useMemo, useState } from 'react';",
    "import { useCallback, useEffect, useMemo, useRef, useState } from 'react';",
    "active site ref import",
)
replace_once(
    "src/components/MonitoringReadonlyPanel.tsx",
    """  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPayload(await requestStatus(site.id));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Monitoring could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [site.id]);

  const loadServerDraft = useCallback(async () => {
    try {
      const savedDraft = await requestMonitoringEmailDraft(site.id);
      setServerDraft(savedDraft);
      setDraft(savedDraft.saved ? savedDraft.settings : loadDraft(site.id));
    } catch (requestError) {
      setServerDraft(null);
      setDraft(loadDraft(site.id));
      setError(requestError instanceof Error ? requestError.message : 'Saved email draft could not be loaded.');
    }
  }, [site.id]);""",
    """  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState<string | null>(null);
  const activeSiteId = useRef(site.id);
  activeSiteId.current = site.id;

  const load = useCallback(async () => {
    const requestedSiteId = site.id;
    setLoading(true);
    setError(null);
    try {
      const nextPayload = await requestStatus(requestedSiteId);
      if (activeSiteId.current !== requestedSiteId) return;
      setPayload(nextPayload);
    } catch (requestError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setError(requestError instanceof Error ? requestError.message : 'Monitoring could not be loaded.');
    } finally {
      if (activeSiteId.current === requestedSiteId) setLoading(false);
    }
  }, [site.id]);

  const loadServerDraft = useCallback(async () => {
    const requestedSiteId = site.id;
    try {
      const savedDraft = await requestMonitoringEmailDraft(requestedSiteId);
      if (activeSiteId.current !== requestedSiteId) return;
      setServerDraft(savedDraft);
      setDraft(savedDraft.saved ? savedDraft.settings : loadDraft(requestedSiteId));
    } catch (requestError) {
      if (activeSiteId.current !== requestedSiteId) return;
      setServerDraft(null);
      setDraft(loadDraft(requestedSiteId));
      setError(requestError instanceof Error ? requestError.message : 'Saved email draft could not be loaded.');
    }
  }, [site.id]);""",
    "discard stale monitoring responses",
)

require(
    "worker/ads-txt.ts",
    "x-tessera-monitoring-snapshot",
    "includeInternalSnapshot ? { content: fetched.text }",
)
require(
    "worker/monitoring-email-preview.ts",
    "export type MonitoringEmailLiveSnapshot",
    "snapshot?: MonitoringEmailLiveSnapshot",
    "if (!snapshot)",
)
require(
    "worker/monitoring-notification-settings.ts",
    "recoveryEnabled: false",
    "export async function listEnabledMonitoringSiteIds",
    "scheduler: 'daily-cron-06-utc'",
)
require(
    "worker/monitoring-notification-run.ts",
    "content?: string",
    "Ads.txt is healthy. The daily check is recorded without sending email.",
    "readPreviewData(env, siteId, check)",
)
require(
    "worker/monitoring-scheduler.ts",
    "MONITORING_DAILY_CRON = '0 6 * * *'",
    "runMonitoringDailySchedule",
    "runMonitoringDailyScheduleHttp",
)
require(
    "worker/app-deploy.ts",
    "2026-07-29-monitoring-daily-cron-v29",
    "/api/monitoring/daily/run",
    "async scheduled(controller, env)",
)
require(
    "wrangler.jsonc",
    '"crons": ["0 6 * * *"]',
)
require(
    "src/components/MonitoringNotificationRules.tsx",
    "CRON READY · 06:00 UTC",
    "Healthy checks are logged without sending email.",
    "Daily · 06:00 UTC",
)
forbid(
    "src/components/MonitoringNotificationRules.tsx",
    "Send a recovery email",
    "PREVIEW: MANUAL EVALUATION",
    "Manual preview only",
)
require(
    "src/components/MonitoringReadonlyPanel.tsx",
    "useMemo, useRef, useState",
    "activeSiteId.current !== requestedSiteId",
)
print(f"Daily monitoring integration passed for cron {BRANCH_SCHEDULE}.")
