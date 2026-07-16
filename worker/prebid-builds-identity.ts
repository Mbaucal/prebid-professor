import { apiError, json } from './http';
import {
  activatePrebidBuild as activateBase,
  deletePrebidBuild,
  downloadPrebidBuild,
  listPrebidBuilds as listBase,
  type PrebidBuildEnv,
  uploadPrebidBuild as uploadBase,
} from './prebid-builds';
import { readRequiredUserIdModules } from './user-id-config';

export { deletePrebidBuild, downloadPrebidBuild };
export type { PrebidBuildEnv };

type JsonRecord = Record<string, unknown>;

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function parseModulesFromHeader(text: string): string[] {
  const match = text.match(/Modules:\s*([\s\S]*?)\s*\*\//i);
  if (!match?.[1]) return [];
  return uniqueSorted(
    match[1]
      .replace(/[\r\n]+/g, ' ')
      .split(',')
      .map((module) => module.trim()),
  );
}

async function requiredIdentityModules(env: PrebidBuildEnv, siteId: string): Promise<string[]> {
  if (!env.DB) return [];
  return readRequiredUserIdModules(env.DB, siteId);
}

export async function listPrebidBuilds(env: PrebidBuildEnv, siteId: string): Promise<Response> {
  const response = await listBase(env, siteId);
  if (!response.ok) return response;

  const payload = (await response.json()) as JsonRecord;
  const requiredUserIdModules = await requiredIdentityModules(env, siteId);
  const builds = Array.isArray(payload.builds) ? payload.builds : [];

  payload.requiredUserIdModules = requiredUserIdModules;
  payload.builds = builds.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const build = value as JsonRecord;
    const modules = Array.isArray(build.modules)
      ? build.modules.filter((item): item is string => typeof item === 'string')
      : [];
    const moduleSet = new Set(modules);
    const missingUserIdModules = requiredUserIdModules.filter((module) => !moduleSet.has(module));
    return {
      ...build,
      missingUserIdModules,
      valid: Boolean(build.valid) && missingUserIdModules.length === 0,
    };
  });

  return json(payload);
}

export async function uploadPrebidBuild(
  request: Request,
  env: PrebidBuildEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured yet.', 503);

  const requiredUserIdModules = await requiredIdentityModules(env, siteId);
  if (requiredUserIdModules.length) {
    let form: FormData;
    try {
      form = await request.clone().formData();
    } catch {
      return apiError('Upload form could not be read.');
    }

    const value = form.get('file');
    if (!(value instanceof File)) return apiError('A prebid.js file is required.');
    const bytes = await value.slice(0, 500_000).arrayBuffer();
    const modules = parseModulesFromHeader(new TextDecoder().decode(bytes));
    const moduleSet = new Set(modules);
    const missing = requiredUserIdModules.filter((module) => !moduleSet.has(module));
    if (missing.length) {
      return apiError(
        'Prebid build is missing configured User ID modules.',
        422,
        { missingUserIdModules: missing },
      );
    }
  }

  const response = await uploadBase(request, env, siteId);
  if (!response.ok) return response;

  const payload = (await response.json()) as JsonRecord;
  payload.requiredUserIdModules = requiredUserIdModules;
  return json(payload, { status: response.status });
}

export async function activatePrebidBuild(
  request: Request,
  env: PrebidBuildEnv,
  siteId: string,
  buildId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured yet.', 503);

  const requiredUserIdModules = await requiredIdentityModules(env, siteId);
  if (requiredUserIdModules.length) {
    const row = await env.DB
      .prepare(
        `SELECT modules_json
         FROM prebid_builds
         WHERE publisher_id = ? AND id = ?
         LIMIT 1`,
      )
      .bind(siteId, buildId)
      .first<{ modules_json: string }>();

    if (!row) return apiError('Prebid build not found.', 404);
    let modules: string[] = [];
    try {
      const parsed = JSON.parse(row.modules_json) as unknown;
      if (Array.isArray(parsed)) modules = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      modules = [];
    }
    const moduleSet = new Set(modules);
    const missing = requiredUserIdModules.filter((module) => !moduleSet.has(module));
    if (missing.length) {
      return apiError(
        'This build cannot become current because configured User ID modules are missing.',
        422,
        { missingUserIdModules: missing },
      );
    }
  }

  return activateBase(request, env, siteId, buildId);
}
