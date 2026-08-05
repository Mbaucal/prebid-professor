import {
  getAuthenticatedUser,
  type AuthEnv,
} from './auth';
import baseApp from './app-ads-txt-duplicate-requirements';
import { getManagedAdsTxtFile } from './ads-txt-managed-file';
import { apiError } from './http';
import type { ReleaseEnv } from './releases';

const MANAGED_FILE_BUILD = '2026-08-05-ads-txt-managed-file-v1';

interface Env extends ReleaseEnv, AuthEnv {
  ASSETS: Fetcher;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GMAIL_TOKEN_ENCRYPTION_KEY?: string;
  ADS_TXT_CONNECTOR_ENCRYPTION_KEY?: string;
}

const downstream = baseApp as {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response>;
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> | void;
};

function withBuildHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-tessera-ads-txt-managed-file-build', MANAGED_FILE_BUILD);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const managedFileMatch = pathname.match(
      /^\/api\/publishers\/([^/]+)\/ads-txt\/managed-file$/,
    );

    if (managedFileMatch) {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return withBuildHeader(apiError('Authentication required.', 401));
      if (request.method !== 'GET') {
        return withBuildHeader(apiError('Method not allowed.', 405));
      }
      return withBuildHeader(await getManagedAdsTxtFile(
        env,
        decodeURIComponent(managedFileMatch[1]),
      ));
    }

    return withBuildHeader(await downstream.fetch(request, env, ctx));
  },

  scheduled(controller, env, ctx): Promise<void> | void {
    return downstream.scheduled?.(controller, env, ctx);
  },
} satisfies ExportedHandler<Env>;
