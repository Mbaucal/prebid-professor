import { apiError, getActor, json } from './http';
import type { DatabaseEnv } from './publishers';
import { readPreviewSnapshot } from './runtime/builtin-preview-service.mjs';
import { digest } from './runtime/preview-snapshot.mjs';
import { runtimeCatalog, prepareSiteRuntimeSelection } from './test-workspace/runtime-catalog.mjs';
import { commitSiteConfiguration } from './site-runtime/service.mjs';

type JsonRecord = Record<string, unknown>;

type ConfigRow = {
  id: string;
  config_json: string;
};

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured yet.', 503);
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseConfig(value: string): JsonRecord {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function enabledFromConfig(config: JsonRecord): boolean {
  return config.enablePrebid !== false;
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function readConfig(db: D1Database, siteId: string): Promise<ConfigRow | null> {
  return db
    .prepare('SELECT id, config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<ConfigRow>();
}

async function buildPayload(db: D1Database, siteId: string, config: JsonRecord): Promise<JsonRecord> {
  const [bidderCounts, overrideCount, currentBuild] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total,
                       SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
                FROM bidders WHERE publisher_id = ?`)
      .bind(siteId)
      .first<{ total: number | string | null; enabled: number | string | null }>(),
    db
      .prepare(`SELECT COUNT(*) AS total FROM bidder_overrides
                WHERE publisher_id = ?`)
      .bind(siteId)
      .first<{ total: number | string | null }>(),
    db
      .prepare(`SELECT id, version, uploaded_at
                FROM prebid_builds
                WHERE publisher_id = ? AND status = 'current'
                ORDER BY uploaded_at DESC LIMIT 1`)
      .bind(siteId)
      .first<{ id: string; version: string; uploaded_at: string }>(),
  ]);

  const enabled = enabledFromConfig(config);
  return {
    ok: true,
    prebidMode: {
      enabled,
      mode: enabled ? 'gam-prebid' : 'gam-adx-only',
    },
    savedState: {
      bidders: Number(bidderCounts?.total ?? 0),
      enabledBidders: Number(bidderCounts?.enabled ?? 0),
      overrides: Number(overrideCount?.total ?? 0),
      currentPrebidBuild: currentBuild
        ? {
            id: currentBuild.id,
            version: currentBuild.version,
            uploadedAt: currentBuild.uploaded_at,
          }
        : null,
    },
    releaseBehavior: enabled
      ? {
          requiresPrebidBuild: true,
          includesBidderAuctions: true,
          includesUserIdModules: true,
          implementationLoadsPrebidJs: true,
        }
      : {
          requiresPrebidBuild: false,
          includesBidderAuctions: false,
          includesUserIdModules: false,
          implementationLoadsPrebidJs: false,
        },
  };
}

export async function getPrebidMode(env: DatabaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  const row = await readConfig(env.DB, siteId);
  if (!row) return apiError('Publisher config was not found.', 404);
  return json(await buildPayload(env.DB, siteId, parseConfig(row.config_json)));
}

export async function updatePrebidMode(
  request: Request,
  env: DatabaseEnv & { BUILDS?: R2Bucket },
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('JSON body could not be read.');
  }

  if (!isRecord(body) || typeof body.enabled !== 'boolean') {
    return apiError('enabled must be true or false.', 422);
  }

  const row = await readConfig(env.DB, siteId);
  if (!row) return apiError('Publisher config was not found.', 404);

  const config = parseConfig(row.config_json);
  const previousEnabled = enabledFromConfig(config);
  const enabled = body.enabled;
  const controls = isRecord(config.runtimeControls) ? config.runtimeControls : {};
  const positions = isRecord(controls.adPositions) ? controls.adPositions : {};
  if (!enabled && Object.values(positions).some(value => isRecord(value) && value.demand === 'site')) {
    return apiError('This TakeOver uses Prebid + GAM. Change its demand to GAM only before disabling Prebid.', 422);
  }
  if (isRecord(config.builtinRuntimeSelection)) {
    try {
      const saved = await readPreviewSnapshot(env.DB.withSession('first-primary'), siteId, { includePrebid: true });
      const current = JSON.parse(saved.config.config_json);
      const plan = await prepareSiteRuntimeSelection({siteId, snapshot:saved, catalog:runtimeCatalog,
        expectedRevision:await digest(saved), selection:{runtime:current.builtinRuntimeSelection.runtime,
          allowPreview:true, enablePrebid:enabled, prebidBuildId:enabled && saved.prebidBuilds.length===1?saved.prebidBuilds[0].id:null}}, env.BUILDS);
      await commitSiteConfiguration(env,saved,plan.configJson,getActor(request),{audit:{
        action:'prebid_mode.updated',entityType:'prebid_mode',entityId:siteId,
        details:{previousEnabled:enabledFromConfig(current),enabled,mode:enabled?'gam-prebid':'gam-adx-only',savedBidderConfigurationPreserved:true},
      }});
      return json(await buildPayload(env.DB,siteId,JSON.parse(plan.configJson)));
    } catch (error) {
      const failure=error as Error & {status?:number};
      return apiError(failure.message||'Prebid mode could not be saved.',failure.status??422);
    }
  }
  config.enablePrebid = enabled;

  const actor = getActor(request);
  const now = new Date().toISOString();

  try {
    const result = await env.DB.batch([
      env.DB
        .prepare('UPDATE publisher_configs SET config_json = ?, updated_at = ? WHERE publisher_id = ? AND config_json = ?')
        .bind(JSON.stringify(config), now, siteId, row.config_json),
      env.DB
        .prepare(`INSERT INTO audit_log (
          id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
        ) SELECT ?, ?, 'prebid_mode.updated', ?, 'prebid_mode', ?, ?, ? WHERE changes()=1`) 
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          siteId,
          JSON.stringify({
            previousEnabled,
            enabled,
            mode: enabled ? 'gam-prebid' : 'gam-adx-only',
            savedBidderConfigurationPreserved: true,
          }),
          now,
        ),
    ]);
    if(result[0]?.meta?.changes!==1)return apiError('Site settings changed. Reload before changing Prebid mode.',409);
  } catch (error) {
    return apiError(
      'Prebid mode could not be saved.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json(await buildPayload(env.DB, siteId, config));
}
