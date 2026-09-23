/** MBA-54: server-side selection planning, not an HTTP handler or database writer.
 * Inputs must come from an authenticated caller's isolated saved-site snapshot
 * and a code-owned runtime catalog, never a browser-supplied catalog/snapshot.
 * A proposal still needs an atomic revision-checked settings transaction. It is
 * not a receipt, authorization to save, deployment, or proof of ad delivery.
 */
import { validateRuntimeDescriptor, pinRuntime, assertPinnedRuntime } from './version-pin.mjs';
import { previewInput, digest } from './preview-snapshot.mjs';
import { prebidRequirements } from '../runtime-demand-v1/requirements.mjs';
import { inspectPrebidArtifact } from './prebid-artifact-check.mjs';
import { prebidFailureMessage } from '../runtime-demand-v1/requirements.mjs';

const HASH = /^[a-f0-9]{64}$/;
const SITE = /^[a-z0-9][a-z0-9-]{0,97}$/;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_PREBID_BYTES = 8 * 1024 * 1024;
const PIN_KEYS = ['schemaVersion','runtimeId','runtimeVersion','runtimeSha256','configSchemaVersion','capabilities'];
const PB_KEYS = ['id','version','sha256','byteSize','modules'];
const BLOCKED = new Set(['__proto__','prototype','constructor']);
export class RuntimeSelectionError extends Error {
  constructor(code, message, status = 422) { super(message); this.name = 'RuntimeSelectionError'; this.code = code; this.status = status; }
}
const fail = (code, message, status) => { throw new RuntimeSelectionError(code, message, status); };
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function exactKeys(value, keys) {
  if (!object(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value,key))) {
    fail('invalid_selection', 'Use the exact runtime and Prebid selection fields. Source, templates and URLs are not accepted.');
  }
}
// Clone before the first await. Reject values JSON would silently discard, as
// well as accessors/prototype keys. Public errors never reflect the input value.
function copyJson(value) {
  let count = 0;
  function visit(item, depth) {
    if (++count > 20000 || depth > 32) fail('invalid_input', 'Selection input exceeds the supported structure.');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      if (item.length > MAX_JSON_BYTES) fail('invalid_input', 'Selection input is too large.');
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (!item || typeof item !== 'object') fail('invalid_input', 'Selection input must contain JSON data only.');
    const array = Array.isArray(item);
    if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype) && !(Object.getPrototypeOf(item) === null && !array)) {
      fail('invalid_input', 'Selection input must contain plain JSON data.');
    }
    if (Object.getOwnPropertySymbols(item).length) fail('invalid_input','Symbol fields are not accepted.');
    const result = array ? [] : {};
    for (const key of Object.getOwnPropertyNames(item)) {
      if (array && key === 'length') continue;
      const property = Object.getOwnPropertyDescriptor(item,key);
      if (BLOCKED.has(key) || !property.enumerable || !Object.hasOwn(property,'value') || (array && !/^(0|[1-9][0-9]*)$/.test(key))) {
        fail('invalid_input', 'Selection input contains an unsupported property.');
      }
      result[key] = visit(property.value,depth+1);
    }
    if (array && Object.keys(item).length !== item.length) fail('invalid_input', 'Sparse arrays are not accepted.');
    return result;
  }
  const result = visit(value,0);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_JSON_BYTES) fail('invalid_input', 'Selection input is too large.');
  return result;
}
function savedInputs(siteId, snapshot, catalog) {
  if (typeof siteId !== 'string' || !SITE.test(siteId)) fail('invalid_site','Invalid site identity.');
  const saved = copyJson(snapshot);
  if (saved?.site?.id !== siteId || typeof saved?.config?.config_json !== 'string' || !Array.isArray(saved.prebidBuilds)) {
    fail('site_snapshot_required','A saved snapshot including this site and its Prebid build records is required.');
  }
  let config;
  try { config = copyJson(JSON.parse(saved.config.config_json)); }
  catch { fail('invalid_configuration','The saved site configuration is not valid JSON data.'); }
  if (!object(config)) fail('invalid_configuration','The saved site configuration must be an object.');
  const entries = copyJson(catalog);
  if (!Array.isArray(entries) || !entries.length || entries.length > 32) fail('invalid_catalog','The built-in runtime catalog is unavailable.');
  const ids = new Set(); const runtimes = [];
  for (const entry of entries) {
    let runtime;
    try { runtime = validateRuntimeDescriptor(entry); }
    catch { fail('invalid_catalog','The built-in runtime catalog needs review.'); }
    const key = JSON.stringify([runtime.id,runtime.version]);
    if (ids.has(key)) fail('invalid_catalog','The built-in runtime catalog is ambiguous.');
    ids.add(key); runtimes.push(runtime);
  }
  return { saved, config, runtimes };
}
function resolveRuntime(pin, runtimes) {
  exactKeys(pin,PIN_KEYS);
  const runtime = runtimes.find((entry) => entry.id === pin.runtimeId && entry.version === pin.runtimeVersion);
  if (!runtime) fail('runtime_unavailable','The selected exact runtime is unavailable. Choose an explicit upgrade.',409);
  try { assertPinnedRuntime(pin,runtime,{configSchemaVersion:1,capabilities:['config-preview']}); }
  catch { fail('runtime_changed','The selected runtime bytes or capabilities changed. Choose an explicit upgrade.',409); }
  return runtime;
}
function normalizedRequirements(saved, config, runtime, inputAdapter) {
  const { prebidBuilds, ...snapshot } = saved;
  snapshot.config = { ...snapshot.config, config_json:JSON.stringify(config) };
  let requirements;
  try { requirements = prebidRequirements(inputAdapter(snapshot,runtime,'20000101_000000'),config); }
  catch { fail('unsupported_configuration','The saved settings are not supported by this built-in runtime. Resolve configuration validation first.'); }
  if (requirements.issues.length) fail('unsupported_prebid_modules','The configured bidder or User ID modules need review before selecting a build.');
  return { snapshot, requirements };
}
async function checkedPrebid(siteId, builds, buildId, requirements, bucket) {
  if (!requirements.required) {
    if (buildId !== null) fail('prebid_mode_mismatch','GPT-only selection must not contain a Prebid build.');
    return null;
  }
  // Existing storage exposes exactly one current build; do not silently select
  // another current/archived row, alter its status, or follow a file_url.
  if (typeof buildId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(buildId) || builds.length !== 1 || builds[0]?.id !== buildId) {
    fail('prebid_selection_required','Select the exact current Prebid build for this site.',409);
  }
  let bytes = null;
  const readOnlyBucket = { async get(key) {
    if (!bucket || typeof bucket.get !== 'function') throw new Error('Unavailable');
    const stored = await bucket.get(key);
    if (!stored) return null;
    if (!Number.isSafeInteger(stored.size) || stored.size < 1 || stored.size > MAX_PREBID_BYTES) throw new Error('Size');
    const metadata = { sha256:stored.customMetadata?.sha256, version:stored.customMetadata?.version };
    return { size:stored.size, customMetadata:metadata, async arrayBuffer() {
      const original = await stored.arrayBuffer();
      if (!(original instanceof ArrayBuffer) || original.byteLength !== stored.size || original.byteLength > MAX_PREBID_BYTES) throw new Error('Size');
      bytes = original.slice(0);
      return bytes;
    } };
  } };
  let report;
  try { report = await inspectPrebidArtifact({siteId,builds,requirements},readOnlyBucket); }
  catch { fail('prebid_verification_failed','The selected Prebid artifact could not be verified.'); }
  if (report.status !== 'checked' || !bytes) fail('prebid_verification_failed',prebidFailureMessage(report));
  return { pin:{...report.build,modules:[...report.declaredModules]}, report, bytes };
}

/** Plan an explicit change; preserve all other saved configuration fields.
 * configJson is server-internal: do not send arbitrary saved fields to a client.
 * basedOnRevision must be rechecked atomically by a future settings writer.
 */
export async function prepareSiteRuntimeSelection({siteId,snapshot,catalog,expectedRevision,selection,inputAdapter=previewInput}, bucket) {
  const { saved,config,runtimes } = savedInputs(siteId,snapshot,catalog);
  const requested = copyJson(selection);
  exactKeys(requested,['runtime','allowPreview','enablePrebid','prebidBuildId']);
  if (typeof requested.allowPreview !== 'boolean' || typeof requested.enablePrebid !== 'boolean') fail('invalid_selection','Prebid mode and preview opt-in must be explicit booleans.');
  if (typeof expectedRevision !== 'string' || !HASH.test(expectedRevision) || await digest(saved) !== expectedRevision) {
    fail('configuration_changed','Site settings changed after review. Reload settings before changing the selection.',409);
  }
  const runtime = resolveRuntime(requested.runtime,runtimes);
  let pin;
  try { pin = pinRuntime(runtime,{allowPreview:requested.allowPreview}); }
  catch { fail('preview_opt_in_required','Selecting a preview runtime requires explicit opt-in.'); }
  const next = { ...config, enablePrebid:requested.enablePrebid };
  const { requirements } = normalizedRequirements(saved,next,runtime,inputAdapter);
  const checked = await checkedPrebid(siteId,saved.prebidBuilds,requested.prebidBuildId,requirements,bucket);
  const chosen = { schemaVersion:1, runtime:pin, prebid:checked?.pin ?? null };
  next.builtinRuntimeSelection = chosen;
  return { siteId, basedOnRevision:expectedRevision, configJson:JSON.stringify(next), selection:chosen,
    changed:await digest(config) !== await digest(next), persisted:false, publishable:false };
}

/** Resolve a persisted selection for the existing server-side candidate builder.
 * Recheck original bytes on every generation. A new current build or changed
 * catalog is a conflict, never an implicit upgrade. Historical release reads
 * must keep using readDraftRelease instead of regenerating through this path.
 */
export async function readPinnedSiteRuntime({siteId,snapshot,catalog,inputAdapter=previewInput}, bucket) {
  const { saved,config,runtimes } = savedInputs(siteId,snapshot,catalog);
  if (!config.builtinRuntimeSelection) fail('runtime_selection_required','Choose and save an exact built-in runtime first.',409);
  const chosen = config.builtinRuntimeSelection;
  exactKeys(chosen,['schemaVersion','runtime','prebid']);
  if (chosen.schemaVersion !== 1 || typeof config.enablePrebid !== 'boolean') fail('invalid_selection','The saved runtime selection schema or Prebid mode is invalid.');
  if (config.enablePrebid) exactKeys(chosen.prebid,PB_KEYS);
  else if (chosen.prebid !== null) fail('prebid_mode_mismatch','GPT-only settings must not retain a Prebid pin.');
  const runtime = resolveRuntime(chosen.runtime,runtimes);
  const { snapshot:settings,requirements } = normalizedRequirements(saved,config,runtime,inputAdapter);
  const checked = await checkedPrebid(siteId,saved.prebidBuilds,chosen.prebid?.id ?? null,requirements,bucket);
  if (checked && await digest(checked.pin) !== await digest(chosen.prebid)) {
    fail('prebid_pin_changed','The saved Prebid version, checksum or modules changed. Select and review an explicit replacement.',409);
  }
  return { siteId, snapshot:settings, descriptor:runtime, pin:chosen.runtime,
    prebid:checked ? {report:checked.report,bytes:checked.bytes} : null,
    revision:await digest(saved), publishable:false };
}
