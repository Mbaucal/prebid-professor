import { checkAdsTxt } from './ads-txt';
import { apiError, json } from './http';
import type { DatabaseEnv } from './publishers';

type JsonRecord = Record<string, unknown>;
type OverallStatus = 'healthy' | 'warning' | 'error' | 'not-published';

type SiteRow = {
  id: string;
  name: string;
  domain: string;
  current_release_id: string | null;
  current_version: string;
  ads_txt_url: string | null;
};

type ArtifactStatus = {
  fileName: string;
  required: boolean;
  found: boolean;
  size: number | null;
  uploadedAt: string | null;
  url: string;
};

export interface MonitoringReadonlyEnv extends DatabaseEnv {
  BUILDS?: R2Bucket;
  EMAIL?: unknown;
}

const ARTIFACT_FILES = [
  'ads.js',
  'ads.min.js',
  'prebid.js',
  'config.json',
  'manifest.json',
  'min-height.css',
  'sticky.css',
  'div-export.csv',
  'implementation.html',
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function readJsonObject(object: R2ObjectBody | null): Promise<JsonRecord> {
  if (!object) return {};
  try {
    const parsed = JSON.parse(await object.text()) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requiresPrebid(config: JsonRecord): boolean {
  if (config.enablePrebid === false || config.prebidBuild === null) return false;
  const build = config.prebidBuild;
  if (isRecord(build) && String(build.version ?? '').trim().toLowerCase() === 'disabled') return false;
  return true;
}

function absoluteArtifactUrl(request: Request, siteId: string, fileName: string): string {
  return new URL(`/cdn/${encodeURIComponent(siteId)}/current/${encodeURIComponent(fileName)}`, request.url).toString();
}

async function readAdsTxtStatus(env: MonitoringReadonlyEnv, siteId: string): Promise<JsonRecord> {
  const response = await checkAdsTxt(
    new Request(`https://monitoring.internal/${encodeURIComponent(siteId)}`),
    env,
    siteId,
  );
  const text = await response.text();
  try {
    const payload = JSON.parse(text) as { check?: unknown; error?: string };
    if (response.ok && isRecord(payload.check)) return payload.check;
    return {
      status: 'fetch-error',
      message: payload.error || `Ads.txt checker returned HTTP ${response.status}.`,
      missing: [],
      optionalMissing: [],
    };
  } catch {
    return {
      status: 'fetch-error',
      message: text || `Ads.txt checker returned HTTP ${response.status}.`,
      missing: [],
      optionalMissing: [],
    };
  }
}

export async function getMonitoringStatus(
  request: Request,
  env: MonitoringReadonlyEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);

  const site = await env.DB
    .prepare(
      `SELECT id, name, domain, current_release_id, current_version, ads_txt_url
       FROM publishers
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(siteId)
    .first<SiteRow>();

  if (!site) return apiError('Site not found.', 404);

  const checkedAt = new Date().toISOString();
  const published = Boolean(site.current_version) && site.current_version !== 'draft';
  const messages: string[] = [];
  let manifestVersion: string | null = null;
  let versionMatches: boolean | null = null;
  let demandMode = 'unknown';
  let artifacts: ArtifactStatus[] = [];

  if (!published) {
    messages.push('No production version is assigned to this site.');
  } else if (!env.BUILDS) {
    messages.push('R2 build storage is not configured.');
  } else {
    if (!site.current_release_id) {
      messages.push('This legacy site has production version metadata without a release ID; current-channel artifacts are still checked.');
    }
    const prefix = `publishers/${site.id}/current/`;
    const [manifest, config] = await Promise.all([
      readJsonObject(await env.BUILDS.get(`${prefix}manifest.json`)),
      readJsonObject(await env.BUILDS.get(`${prefix}config.json`)),
    ]);

    manifestVersion = typeof manifest.version === 'string' ? manifest.version : null;
    versionMatches = manifestVersion ? manifestVersion === site.current_version : false;
    const prebidRequired = requiresPrebid(config);
    demandMode = prebidRequired ? 'GAM + Prebid' : 'GAM / AdX only';

    artifacts = await Promise.all(
      ARTIFACT_FILES.map(async (fileName): Promise<ArtifactStatus> => {
        const object = await env.BUILDS!.head(`${prefix}${fileName}`);
        const required = fileName !== 'sticky.css' && (fileName !== 'prebid.js' || prebidRequired);
        return {
          fileName,
          required,
          found: Boolean(object),
          size: object?.size ?? null,
          uploadedAt: object?.uploaded ? object.uploaded.toISOString() : null,
          url: absoluteArtifactUrl(request, site.id, fileName),
        };
      }),
    );

    if (!manifestVersion) messages.push('Production manifest.json is missing or does not contain a version.');
    if (versionMatches === false) {
      messages.push(`Production manifest version ${manifestVersion ?? 'unknown'} does not match dashboard version ${site.current_version}.`);
    }
    const missingRequired = artifacts.filter((artifact) => artifact.required && !artifact.found);
    if (missingRequired.length) {
      messages.push(`Missing required production artifact(s): ${missingRequired.map((artifact) => artifact.fileName).join(', ')}.`);
    }
  }

  const adsTxt = await readAdsTxtStatus(env, site.id);
  const adsStatus = String(adsTxt.status ?? 'fetch-error');
  const missingRequiredArtifacts = artifacts.some((artifact) => artifact.required && !artifact.found);

  let overall: OverallStatus = 'healthy';
  if (!published) overall = 'not-published';
  else if (!env.BUILDS || !manifestVersion || versionMatches === false || missingRequiredArtifacts) overall = 'error';
  else if (adsStatus === 'missing' || adsStatus === 'fetch-error') overall = 'error';
  else if (adsStatus === 'empty' || Number(adsTxt.optionalMissingCount ?? 0) > 0) overall = 'warning';

  if (adsStatus === 'missing') {
    messages.push(`${Number(adsTxt.requiredMissingCount ?? 0)} required ads.txt entr${Number(adsTxt.requiredMissingCount ?? 0) === 1 ? 'y is' : 'ies are'} missing.`);
  } else if (adsStatus === 'fetch-error') {
    messages.push(String(adsTxt.message ?? 'Ads.txt could not be fetched.'));
  } else if (adsStatus === 'empty') {
    messages.push('No expected ads.txt entries are configured.');
  }

  return json({
    ok: true,
    checkedAt,
    overall,
    site: {
      id: site.id,
      name: site.name,
      domain: site.domain,
      adsTxtUrl: site.ads_txt_url || `https://${site.domain}/ads.txt`,
    },
    runtime: {
      published,
      currentReleaseId: site.current_release_id,
      expectedVersion: published ? site.current_version : null,
      manifestVersion,
      versionMatches,
      demandMode,
      artifacts,
    },
    adsTxt,
    messages: Array.from(new Set(messages)),
    readOnly: true,
    capabilities: {
      email: Boolean(env.EMAIL),
    },
  });
}
