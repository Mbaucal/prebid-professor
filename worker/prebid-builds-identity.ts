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
import { isLegacyPrebidConfig, legacyPrebidModules, checkedLegacyPrebidModules } from './legacy-prebid-requirements';

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

async function legacyConfig(env: PrebidBuildEnv, siteId: string): Promise<JsonRecord | null> {
  const row = await env.DB?.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1').bind(siteId).first<{config_json: string}>();
  if (!row) return null;
  try {
    const value = JSON.parse(row.config_json) as JsonRecord;
    return value && typeof value === 'object' && !Array.isArray(value) && isLegacyPrebidConfig(value) ? value : null;
  } catch { return null; }
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
  const config = await legacyConfig(env, siteId);
  if (requiredUserIdModules.length || config) {
    let form: FormData;
    try {
      form = await request.clone().formData();
    } catch {
      return apiError('Upload form could not be read.');
    }

    const value = form.get('file');
    if (!(value instanceof File)) return apiError('A prebid.js file is required.');
    const bytes = await value.slice(0, 500_000).arrayBuffer();
    const source = new TextDecoder().decode(bytes);
    const modules = parseModulesFromHeader(source);
    const moduleSet = new Set(modules);
    let required: string[];
    try {
      required = uniqueSorted([...requiredUserIdModules, ...(config ? legacyPrebidModules(config, source.match(/prebid\.js\s+v?(\d+\.\d+\.\d+)/i)?.[1] ?? '9.0.0') : [])]);
    } catch (error) { return apiError(error instanceof Error ? error.message : 'Prebid module requirements could not be verified.', 422); }
    const missing = required.filter((module) => !moduleSet.has(module));
    if (missing.length) {
      return apiError(
        'Prebid build is missing modules required by the saved site settings.',
        422,
        { missingUserIdModules: missing.filter(module => requiredUserIdModules.includes(module)), missingModules: missing },
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
  const config = await legacyConfig(env, siteId);
  if (requiredUserIdModules.length || config) {
    const row = await env.DB
      .prepare(
        `SELECT version, modules_json, file_key
         FROM prebid_builds
         WHERE publisher_id = ? AND id = ?
         LIMIT 1`,
      )
      .bind(siteId, buildId)
      .first<{ version: string; modules_json: string; file_key: string }>();

    if (!row) return apiError('Prebid build not found.', 404);
    let modules: string[] = [];
    try {
      const parsed = JSON.parse(row.modules_json) as unknown;
      if (Array.isArray(parsed)) modules = parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      modules = [];
    }
    const moduleSet = new Set(modules);
    let required: string[];
    try { required = uniqueSorted([...requiredUserIdModules, ...(config ? legacyPrebidModules(config, row.version) : [])]); }
    catch (error) { return apiError(error instanceof Error ? error.message : 'Prebid module requirements could not be verified.', 422); }
    let missing: string[];
    try { missing = uniqueSorted([...required.filter(module => !moduleSet.has(module)), ...(config ? await checkedLegacyPrebidModules(config, row, env.BUILDS) : [])]); }
    catch (error) { return apiError(error instanceof Error ? error.message : 'The stored Prebid file could not be verified.', 422); }
    if (missing.length) {
      return apiError(
        'This build cannot become current because modules required by the saved site settings are missing.',
        422,
        { missingUserIdModules: missing.filter(module => requiredUserIdModules.includes(module)), missingModules: missing },
      );
    }
  }

  return activateBase(request, env, siteId, buildId);
}
