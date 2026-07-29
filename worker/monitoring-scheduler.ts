import { apiError, getActor, json } from './http';
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
