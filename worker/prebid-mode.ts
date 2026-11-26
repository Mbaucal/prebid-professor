import { initializeMissingUserSync } from './user-id-config';
import { apiError, getActor, json } from './http.ts';
import type { DatabaseEnv } from './publishers';
import { readPreviewSnapshot } from './runtime/builtin-preview-service.mjs';
import { digest } from './runtime/preview-snapshot.mjs';
import { runtimeCatalog, prepareSiteRuntimeSelection } from './test-workspace/runtime-catalog.mjs';
import { commitSiteConfiguration } from './site-runtime/service.mjs';
import { bidCacheNoticedScriptApplies, bidCacheScriptVersions, bidCacheSettings, requireEligibleOverrides, supportsNamedScripts } from './site-runtime/prebid-cache-settings.mjs';
import { CACHE_POSITIONS } from './experiments/position-cache-settings.mjs';
import { BID_CACHE_RUNTIME_VERSION, bidCacheEligibleCodes, runtimeSupportsBidCache, type BidCacheUnitRow } from '../shared/bid-cache/eligibility.mjs';

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

/** The saved columns that decide which positions may reuse bids (bidCacheEligibleCodes). */
async function readCacheUnits(db: D1Database, siteId: string): Promise<BidCacheUnitRow[]> {
  const rows = await db
    .prepare('SELECT code, type, media_type, enabled FROM ad_units WHERE publisher_id = ?')
    .bind(siteId)
    .all<BidCacheUnitRow>();
  return rows.results ?? [];
}

/** The saved script version, only when the runtime catalog still has exactly that engine (the
 * same match as assertPinnedRuntime), and whether it applies bid caching. Without a verified
 * built-in version nothing applies the cache. */
function selectedRuntime(config: JsonRecord): { selectedRuntime: { id: string; version: string } | null; runtimeSupportsBidCache: boolean } {
  const selection = isRecord(config.builtinRuntimeSelection) ? config.builtinRuntimeSelection : null;
  const pin = selection && isRecord(selection.runtime) ? selection.runtime : null;
  const descriptor = pin?.schemaVersion === 1 && Array.isArray(pin.capabilities)
    ? runtimeCatalog.find(runtime => runtime.id === pin.runtimeId && runtime.version === pin.runtimeVersion
      && runtime.codeSha256 === pin.runtimeSha256 && runtime.configSchemaVersion === pin.configSchemaVersion
      && JSON.stringify(runtime.capabilities) === JSON.stringify(pin.capabilities))
    : undefined;
  return descriptor
    ? { selectedRuntime: { id: descriptor.id, version: descriptor.version }, runtimeSupportsBidCache: runtimeSupportsBidCache(descriptor) }
    : { selectedRuntime: null, runtimeSupportsBidCache: false };
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
  const [site, units, bidders] = await Promise.all([
    db.prepare('SELECT domain, gam_path FROM publishers WHERE id = ?').bind(siteId).first(),
    readCacheUnits(db, siteId),
    db.prepare('SELECT bidder, account_json, enabled FROM bidders WHERE publisher_id = ?').bind(siteId).all(),
  ]);
  return {
    revision: await digest(config),
    // Every site can save bid cache settings; prebidMode.enabled says whether they are active.
    bidCacheAvailable: true,
    bidCachePositions: bidCacheEligibleCodes(units, config),
    bidCacheRuntimeVersion: BID_CACHE_RUNTIME_VERSION,
    // The versions the panels name, the same as Generate's bid caching refusal: those that apply bid caching with the
    // site's other saved options, at most two, such as ["3.24.0 (Preview)", "3.26.0 (Preview)"]; empty when none does.
    bidCacheScriptVersions: bidCacheScriptVersions(config, bidders.results ?? []),
    // Whether a version with a runtime notice applies them: never named, but still selectable in Script setup.
    bidCacheNoticedScriptApplies: bidCacheNoticedScriptApplies(config, bidders.results ?? []),
    ...selectedRuntime(config),
    // Only adds a sentence about new named scripts. It never changes which settings can be
    // saved or which positions are listed. Named scripts keep the reviewed inventory of
    // CACHE_POSITIONS and refuse an override for any other position (settingsForScript).
    namedScriptLibrary: supportsNamedScripts(site),
    namedScriptPositions: supportsNamedScripts(site) ? [...CACHE_POSITIONS] : [],
    ok: true,
    prebidMode: {
      enabled,
      mode: enabled ? 'gam-prebid' : 'gam-adx-only',
      bidCache: bidCacheSettings(config.prebidBidCache),
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
  try { return json(await buildPayload(env.DB, siteId, parseConfig(row.config_json))); }
  catch { return apiError('Saved Prebid settings need review.', 422); }
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
  let bidCache;
  try { bidCache = bidCacheSettings(Object.hasOwn(body,'bidCache') ? body.bidCache : config.prebidBidCache); }
  catch (error) { return apiError((error as Error).message, 422); }
  if (Object.hasOwn(body,'bidCache') && body.revision !== await digest(config)) {
    return apiError('Prebid settings changed. Reload before saving.', 409);
  }
  if (Object.hasOwn(body,'bidCache')) {
    // New or changed position overrides must name this site's own eligible positions.
    const eligible = bidCacheEligibleCodes(await readCacheUnits(env.DB, siteId), config);
    try { requireEligibleOverrides(bidCache, config.prebidBidCache, eligible); }
    catch (error) { return apiError((error as Error).message, 422); }
  }
  const previousEnabled = enabledFromConfig(config);
  const enabled = body.enabled;
  const controls = isRecord(config.runtimeControls) ? config.runtimeControls : {};
  const positions = isRecord(controls.adPositions) ? controls.adPositions : {};
  if (!enabled && Object.values(positions).some(value => isRecord(value) && value.demand === 'site')) {
    return apiError('This TakeOver uses Prebid + GAM. Change its demand to GAM only before disabling Prebid.', 422);
  }
  if (isRecord(config.builtinRuntimeSelection) && enabled !== previousEnabled) {
    try {
      const saved = await readPreviewSnapshot(env.DB.withSession('first-primary'), siteId, { includePrebid: true });
      const current = JSON.parse(saved.config.config_json);
      if (await digest(current) !== await digest(config)) return apiError('Prebid settings changed. Reload before saving.', 409);
      const plan = await prepareSiteRuntimeSelection({siteId, snapshot:saved, catalog:runtimeCatalog,
        expectedRevision:await digest(saved), selection:{runtime:current.builtinRuntimeSelection.runtime,
          allowPreview:true, enablePrebid:enabled, prebidBuildId:enabled && saved.prebidBuilds.length===1?saved.prebidBuilds[0].id:null}}, env.BUILDS);
      const selectedConfig = JSON.parse(plan.configJson);
      const nextConfig = enabled ? initializeMissingUserSync(selectedConfig) : selectedConfig;
      if (Object.hasOwn(body,'bidCache')) nextConfig.prebidBidCache = bidCache;
      await commitSiteConfiguration(env,saved,JSON.stringify(nextConfig),getActor(request),{audit:{
        action:'prebid_mode.updated',entityType:'prebid_mode',entityId:siteId,
        details:{previousEnabled:enabledFromConfig(current),enabled,mode:enabled?'gam-prebid':'gam-adx-only',savedBidderConfigurationPreserved:true,bidCache},
      }});
      return json(await buildPayload(env.DB,siteId,nextConfig));
    } catch (error) {
      const failure=error as Error & {status?:number};
      return apiError(failure.message||'Prebid mode could not be saved.',failure.status??422);
    }
  }
  config.enablePrebid = enabled;
  // Only turning Prebid on fills in a missing user sync setting, as Script setup does.
  // Saving bid caching or re-saving the same mode leaves user sync as it is.
  if (enabled && !previousEnabled) Object.assign(config, initializeMissingUserSync(config));
  if (Object.hasOwn(body,'bidCache')) config.prebidBidCache = bidCache;

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
            bidCache,
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
