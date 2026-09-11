import { buildReference391 } from '../../.generated/reference391.mjs';
import { descriptor as rawDescriptor } from '../../.generated/runtime-manifest.mjs';
import { validateRuntimeDescriptor, pinRuntime, assertPinnedRuntime } from './version-pin.mjs';
import { compileRuntime } from '../runtime-compiler.ts';
import { compileReferenceBuild } from './reference-bridge.mjs';
import { previewInput, digest, assertReview } from './preview-snapshot.mjs';

export const runtimeDescriptor = validateRuntimeDescriptor(rawDescriptor);
const HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export async function readPreviewSnapshot(db, siteId) {
  if (!db) throw new Error('D1 is not configured.');
  const queries = [
    'SELECT id, name, domain, gam_path FROM publishers WHERE id = ? LIMIT 1',
    'SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1',
    'SELECT code, type, media_type, size_map_key, enabled, sort_order FROM ad_units WHERE publisher_id = ? ORDER BY sort_order, code',
    'SELECT bidder, params_json, enabled FROM bidders WHERE publisher_id = ? ORDER BY bidder',
    'SELECT bidder, scope_type, scope_key, params_json, enabled FROM bidder_overrides WHERE publisher_id = ? ORDER BY bidder, scope_type, scope_key',
    'SELECT name, map_json FROM size_maps WHERE publisher_id = ? ORDER BY name',
    'SELECT rule_key, rule_json FROM unit_rules WHERE publisher_id = ? ORDER BY rule_key',
  ];
  // A single read-only transaction: no writes, initialization, migrations or R2 access.
  const rows = await db.batch(queries.map((sql) => db.prepare(sql).bind(siteId)));
  if (rows.some((row) => row.success === false)) throw new Error('Site settings could not be read.');
  const results = rows.map((row) => row.results ?? []);
  if (!results[0][0] || !results[1][0]) throw new Error('Site or saved configuration was not found.');
  return { site: results[0][0], config: results[1][0], units: results[2], bidders: results[3], overrides: results[4], maps: results[5], rules: results[6] };
}
function timestamp() { return new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15); }
export function generatePreview(snapshot, takeOver, pin, buildTimestamp = timestamp()) {
  assertPinnedRuntime(pin, runtimeDescriptor, { configSchemaVersion: 1, capabilities: ['config-preview'] });
  const input = previewInput(snapshot, runtimeDescriptor, buildTimestamp, takeOver);
  return compileReferenceBuild(input.core, input.options, { buildReference391, compileRuntime });
}
export async function handleBuiltinPreview(request, env, siteId) {
  try {
    if (!/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId)) return response({ error: 'Invalid site ID.' }, 400);
    const snapshot = await readPreviewSnapshot(env.DB, siteId);
    if (request.method === 'GET') {
      let issue = null;
      try { previewInput(snapshot, runtimeDescriptor, timestamp()); } catch (error) { issue = error.message; }
      return response({ ok: true, site: snapshot.site, runtime: runtimeDescriptor, reviewHash: await digest(snapshot),
        summary: { units: snapshot.units.filter((unit) => unit.enabled === 1 && unit.type !== 'DRAFT').length,
          bidders: snapshot.bidders.filter((bidder) => bidder.enabled === 1).length },
        validationIssue: issue,
        takeOver: { enabled: false, adUnitCode: 'TakeOver', desktopMinWidth: 1024, desktopSize: [800, 600], mobileSize: [300, 250],
          autoCloseDesktopSec: 10, autoCloseMobileSec: 5, codelessAdUnitPath: `${snapshot.site.gam_path}Interstitial` },
        notice: 'Source preview only. No saved selection, release, CMS call or publication. Production Generate remains unchanged.' });
    }
    if (request.method !== 'POST') return response({ error: 'Method not allowed.' }, 405);
    if (!(request.headers.get('content-type') ?? '').includes('application/json')) return response({ error: 'JSON body is required.' }, 415);
    const text = await request.text();
    if (text.length > 24000) return response({ error: 'Preview request is too large.' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return response({ error: 'Invalid JSON.' }, 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return response({ error: 'Invalid preview request.' }, 400);
    if (Object.keys(body).some((key) => !['reviewHash', 'runtimeVersion', 'runtimeSha256', 'allowPreview', 'takeOver'].includes(key))) return response({ error: 'Unknown preview field; source/template input is not accepted.' }, 422);
    if (body.runtimeVersion !== runtimeDescriptor.version || body.runtimeSha256 !== runtimeDescriptor.codeSha256) return response({ error: 'Runtime changed. Refresh settings before generating.' }, 409);
    await assertReview(snapshot, body.reviewHash);
    const pin = pinRuntime(runtimeDescriptor, { allowPreview: body.allowPreview === true });
    const result = generatePreview(snapshot, body.takeOver ?? { enabled: false }, pin);
    if (result.adsJs.length > 1000000) return response({ error: 'Generated preview exceeds the size limit.' }, 413);
    return response({ ok: true, siteId, fileName: `${siteId}-ads.preview.js`, content: result.adsJs,
      checksum: await digest(result.adsJs), byteSize: new TextEncoder().encode(result.adsJs).byteLength,
      runtime: pin, completeRelease: false, requiresReleasePostprocessing: true,
      patches: result.patches, warnings: [...result.warnings,
        'Source inspection only. Prebid build/module checks, final CSS and release overlays, publication and rollback are not part of this preview. Do not replace a production wrapper with this file.'] });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview generation failed.';
    return response({ error: message }, message.includes('changed after review') ? 409 : 422);
  }
}
