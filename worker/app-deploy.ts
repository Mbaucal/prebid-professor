import {
  getAuthenticatedUser,
  isSameOriginMutation,
  type AuthEnv,
} from './auth';
import compatApp from './app-compat';
import {
  checkAdsTxt,
  deleteAdsTxtRequirement,
  listAdsTxtRequirements,
  updateAdsTxtRequirement,
} from './ads-txt';
import { createAdsTxtRequirementFlexible } from './ads-txt-flexible';
import { copyAdsTxtRequirementsLarge, importAdsTxtRequirementsLarge } from './ads-txt-bulk';
import { listAuditLog } from './audit-log';
import { getMonitoringEmailPreviewData } from './monitoring-email-preview';
import { getMonitoringEmailDraft, updateMonitoringEmailDraft } from './monitoring-email-settings';
import { getMonitoringNotificationSettings, updateMonitoringNotificationSettings } from './monitoring-notification-settings';
import { runMonitoringNotification } from './monitoring-notification-run';
import { runMonitoringDailySchedule, runMonitoringDailyScheduleHttp } from './monitoring-scheduler';
import { getMonitoringStatus } from './monitoring-readonly';
import { disconnectGmail, finishGmailConnect, getGmailStatus, startGmailConnect, type GmailOAuthEnv } from './gmail-oauth';
import { sendGmailTest } from './gmail-send';
import { apiError } from './http';
import { getPrebidMode, updatePrebidMode } from './prebid-mode';
import { deleteRelease } from './release-deletion';
import type { ReleaseEnv } from './releases';
import { brandTesseraHtmlResponse } from './tessera-html-branding';

const RUNTIME_BUILD = '2026-07-29-monitoring-review-hardening-v31';

interface Env extends ReleaseEnv, AuthEnv {
  ASSETS: Fetcher;
  GITHUB_ACTIONS_TOKEN?: string;
  GITHUB_DEPLOY_REPOSITORY?: string;
  GITHUB_DEPLOY_REF?: string;
  DEPLOY_CALLBACK_SECRET?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
}

const downstream = compatApp as {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
};

function withAuthenticatedActor(request: Request, email: string): Request {
  const headers = new Headers(request.headers);
  headers.set('x-user-email', email);
  return new Request(request, { headers });
}

function normalizeVerifiedSameOriginRequest(request: Request): Request {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return request;

  const requestOrigin = new URL(request.url).origin;
  const originHeader = request.headers.get('origin')?.trim() ?? '';
  const refererHeader = request.headers.get('referer')?.trim() ?? '';
  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? '';

  let verifiedSameOrigin = false;
  if (originHeader && originHeader !== 'null') {
    try {
      verifiedSameOrigin = new URL(originHeader).origin === requestOrigin;
    } catch {
      verifiedSameOrigin = false;
    }
  } else if (refererHeader) {
    try {
      verifiedSameOrigin = new URL(refererHeader).origin === requestOrigin;
    } catch {
      verifiedSameOrigin = false;
    }
  } else if (originHeader === 'null' && fetchSite === 'same-origin') {
    verifiedSameOrigin = true;
  }

  if (!verifiedSameOrigin) return request;
  const headers = new Headers(request.headers);
  headers.set('origin', requestOrigin);
  headers.set('sec-fetch-site', 'same-origin');
  return new Request(request, { headers });
}

async function authenticatedRequest(request: Request, env: Env): Promise<Request | Response> {
  const user = await getAuthenticatedUser(request, env);
  if (!user) return apiError('Authentication required.', 401);

  const normalized = normalizeVerifiedSameOriginRequest(request);
  if (!isSameOriginMutation(normalized)) {
    return apiError('Cross-site state-changing request blocked.', 403);
  }
  return withAuthenticatedActor(normalized, user.email);
}

function withBuildHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-prebid-professor-build', RUNTIME_BUILD);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function healthWithBuildMarker(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await downstream.fetch(request, env, ctx);
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.set('cache-control', 'no-store');
    headers.set('x-prebid-professor-build', RUNTIME_BUILD);
    return new Response(
      `${JSON.stringify({
        ...payload,
        runtimeBuild: RUNTIME_BUILD,
        workerEntrypoint: 'worker/app-deploy.ts',
        gmailOAuth: {
          configured: Boolean(
            env.GOOGLE_OAUTH_CLIENT_ID
            && env.GOOGLE_OAUTH_CLIENT_SECRET
            && env.GMAIL_TOKEN_ENCRYPTION_KEY
          ),
        },
      }, null, 2)}\n`,
      { status: response.status, headers },
    );
  } catch {
    return withBuildHeader(response);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    if (request.method === 'GET' && pathname === '/api/health') {
      return healthWithBuildMarker(request, env, ctx);
    }

    if (request.method === 'GET' && pathname === '/api/integrations/gmail/callback') {
      return withBuildHeader(await finishGmailConnect(request, env as GmailOAuthEnv));
    }

    if (pathname === '/api/integrations/gmail/status') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'GET') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await getGmailStatus(env as GmailOAuthEnv));
    }

    if (pathname === '/api/integrations/gmail/connect') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'GET') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await startGmailConnect(verified, env as GmailOAuthEnv));
    }

    if (pathname === '/api/integrations/gmail/disconnect') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await disconnectGmail(env as GmailOAuthEnv));
    }

    if (request.method === 'GET' && pathname === '/api/audit-log') {
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

    const adsTxtCheckMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/check$/);
    if (adsTxtCheckMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await checkAdsTxt(verified, env, decodeURIComponent(adsTxtCheckMatch[1])));
    }

    const adsTxtImportMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/import$/);
    if (adsTxtImportMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await importAdsTxtRequirementsLarge(
        verified,
        env,
        decodeURIComponent(adsTxtImportMatch[1]),
      ));
    }

    const adsTxtCopyMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/copy$/);
    if (adsTxtCopyMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await copyAdsTxtRequirementsLarge(
        verified,
        env,
        decodeURIComponent(adsTxtCopyMatch[1]),
      ));
    }

    const adsTxtItemMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements\/([^/]+)$/);
    if (adsTxtItemMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(adsTxtItemMatch[1]);
      const requirementId = decodeURIComponent(adsTxtItemMatch[2]);
      if (request.method === 'PATCH') {
        return withBuildHeader(await updateAdsTxtRequirement(verified, env, siteId, requirementId));
      }
      if (request.method === 'DELETE') {
        return withBuildHeader(await deleteAdsTxtRequirement(verified, env, siteId, requirementId));
      }
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const adsTxtCollectionMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/ads-txt\/requirements$/);
    if (adsTxtCollectionMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(adsTxtCollectionMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await listAdsTxtRequirements(env, siteId));
      if (request.method === 'POST') {
        return withBuildHeader(await createAdsTxtRequirementFlexible(verified, env, siteId));
      }
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const monitoringNotificationSettingsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/notification-settings$/);
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
    if (monitoringGmailSendTestMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'POST') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await sendGmailTest(verified, env as GmailOAuthEnv));
    }

    const monitoringEmailSettingsMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/email-settings$/);
    if (monitoringEmailSettingsMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      const siteId = decodeURIComponent(monitoringEmailSettingsMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await getMonitoringEmailDraft(env, siteId));
      if (request.method === 'PUT') return withBuildHeader(await updateMonitoringEmailDraft(verified, env, siteId));
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const monitoringEmailDataMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/email-preview-data$/);
    if (monitoringEmailDataMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      if (request.method !== 'GET') return withBuildHeader(apiError('Method not allowed.', 405));
      return withBuildHeader(await getMonitoringEmailPreviewData(
        env,
        decodeURIComponent(monitoringEmailDataMatch[1]),
      ));
    }

    const monitoringStatusMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/monitoring\/status$/);
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

    const releaseDeleteMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/releases\/([^/]+)$/);
    if (releaseDeleteMatch && request.method === 'DELETE') {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);
      return withBuildHeader(await deleteRelease(
        verified,
        env,
        decodeURIComponent(releaseDeleteMatch[1]),
        decodeURIComponent(releaseDeleteMatch[2]),
      ));
    }

    const prebidModeMatch = pathname.match(/^\/api\/publishers\/([^/]+)\/prebid-mode$/);
    if (prebidModeMatch) {
      const verified = await authenticatedRequest(request, env);
      if (verified instanceof Response) return withBuildHeader(verified);

      const siteId = decodeURIComponent(prebidModeMatch[1]);
      if (request.method === 'GET') return withBuildHeader(await getPrebidMode(env, siteId));
      if (request.method === 'PUT') return withBuildHeader(await updatePrebidMode(verified, env, siteId));
      return withBuildHeader(apiError('Method not allowed.', 405));
    }

    const response = await downstream.fetch(request, env, ctx);
    return withBuildHeader(await brandTesseraHtmlResponse(response));
  },

  async scheduled(controller, env): Promise<void> {
    await runMonitoringDailySchedule(env, `cloudflare-cron:${controller.cron}`);
  },
} satisfies ExportedHandler<Env>;
