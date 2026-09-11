/** Read-only artifact inspection. No execution, publication, migrations or writes.
 * Header declarations are checked, not treated as proof of live auction behavior.
 */
const MAX_BYTES = 20 * 1024 * 1024;
const HEADER_BYTES = 500_000;
const MODULE = /^[A-Za-z][A-Za-z0-9_]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ADAPTERS = Object.freeze({
  adform: 'adformBidAdapter', connectad: 'connectadBidAdapter', criteo: 'criteoBidAdapter',
  eskimi: 'eskimiBidAdapter', ix: 'ixBidAdapter', magnite: 'magniteBidAdapter',
  ogury: 'oguryBidAdapter', openx: 'openxBidAdapter', pubmatic: 'pubmaticBidAdapter',
  richaudience: 'richaudienceBidAdapter', rtbhouse: 'rtbhouseBidAdapter',
  smartadserver: 'smartadserverBidAdapter', teads: 'teadsBidAdapter',
});
const USER_IDS = Object.freeze({ sharedId: 'sharedIdSystem', id5Id: 'id5IdSystem',
  teadsId: 'teadsIdSystem', criteo: 'criteoIdSystem', lotamePanoramaId: 'lotamePanoramaIdSystem' });
const unique = (items) => [...new Set(items)].sort();
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function moduleList(value) {
  if (!Array.isArray(value) || value.length > 1000 || value.some((v) => typeof v !== 'string' || !MODULE.test(v))) {
    throw new Error('Invalid module declarations.');
  }
  return unique(value);
}
export async function sha256(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** Derives requirements from the normalized generator input, not browser data. */
export function prebidRequirements(input, savedConfig = {}) {
  if (!record(input?.core) || !record(input?.options) || typeof input.options.enablePrebid !== 'boolean') {
    throw new Error('Normalized generator input is required.');
  }
  if (!input.options.enablePrebid) return { required: false, modules: [], issues: [] };
  const modules = ['consentManagementTcf', 'tcfControl'];
  const issues = [];
  for (const bidder of input.core.bidders ?? []) {
    const name = bidder?.bidder;
    if (typeof name === 'string' && Object.hasOwn(ADAPTERS, name)) modules.push(ADAPTERS[name]);
    else issues.push({ code: 'unmapped_bidder', message: `The adapter mapping for ${String(name)} must be verified before release.` });
  }
  if (input.options.floors?.enabled) modules.push('priceFloors');
  if (input.options.currencyConversion?.enabled) modules.push('currency');
  const configured = savedConfig?.userIdConfig?.modules;
  for (const id of input.core.userSync?.userIds ?? []) {
    modules.push('userId');
    const explicit = Array.isArray(configured)
      ? configured.filter((row) => row?.enabled === true && row.name === id.name) : [];
    const candidates = unique(explicit.map((row) => row.moduleCode));
    const known = typeof id?.name === 'string' && Object.hasOwn(USER_IDS, id.name) ? USER_IDS[id.name] : null;
    const chosen = candidates.length === 1 ? candidates[0] : known;
    if (candidates.length > 1 || (known && chosen !== known) || typeof chosen !== 'string' || !MODULE.test(chosen)) {
      issues.push({ code: 'unmapped_user_id', message: `The User ID module for ${String(id?.name)} must be verified before release.` });
    } else modules.push(chosen);
  }
  return { required: true, modules: unique(modules), issues };
}

export function parsePrebidHeader(text) {
  // Only inspect comment blocks, never execute the uploaded source.
  const blocks = text.match(/\/\*[\s\S]*?\*\//g) ?? [];
  for (const block of blocks) {
    const version = block.match(/prebid\.js\s+v?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9._-]+)?)/i)?.[1];
    const declarations = block.match(/Modules:\s*([\s\S]*?)\*\//i)?.[1];
    if (!version || !declarations) continue;
    return { version, modules: moduleList(declarations.split(',').map((v) => v.trim())) };
  }
  throw new Error('A Prebid version and Modules header could not be read.');
}

export async function inspectPrebidArtifact({ siteId, builds, requirements }, bucket) {
  if (typeof siteId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,97}$/.test(siteId)) throw new Error('Invalid site ID.');
  if (!record(requirements) || typeof requirements.required !== 'boolean' || !Array.isArray(requirements.issues)) throw new Error('Invalid requirements.');
  const requiredModules = moduleList(requirements.modules);
  const report = { siteId, status: 'blocked', required: requirements.required,
    requiredModules, declaredModules: [], missingModules: [], build: null,
    issues: [...requirements.issues], completeRelease: false,
    notice: 'This checks stored bytes, checksums and module declarations only. Live GPT/Prebid delivery and the complete release still require testing.' };
  if (!requirements.required) { report.status = 'not_required'; return report; }
  const fail = (code, message) => { report.issues.push({ code, message }); return report; };
  if (!Array.isArray(builds) || builds.length !== 1) return fail('current_build_missing_or_ambiguous', 'Choose exactly one current Prebid.js build for this site.');
  const build = builds[0];
  if (!record(build) || build.publisher_id !== siteId || build.status !== 'current') return fail('build_site_mismatch', 'The selected build does not belong to this site.');
  if (typeof build.id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(build.id) || typeof build.version !== 'string' || !VERSION.test(build.version)) return fail('invalid_build_metadata', 'Stored build ID or version is invalid.');
  const prefix = `publishers/${siteId}/prebid-builds/${build.id}/`;
  if (typeof build.file_key !== 'string' || !build.file_key.startsWith(prefix) || !build.file_key.slice(prefix.length) || build.file_key.slice(prefix.length).includes('/')) {
    return fail('unverified_build_path', 'The stored build file path needs verification; no unrelated R2 object was read.');
  }
  report.build = { id: build.id, version: build.version, sha256: null, byteSize: null };
  let declared;
  try { declared = moduleList(JSON.parse(build.modules_json)); }
  catch { return fail('invalid_module_metadata', 'Stored module declarations are invalid.'); }
  report.declaredModules = declared;
  report.missingModules = requiredModules.filter((module) => !declared.includes(module));
  if (report.missingModules.length) report.issues.push({ code: 'modules_missing', message: `Missing modules: ${report.missingModules.join(', ')}.` });
  if (!bucket || typeof bucket.get !== 'function') return fail('storage_unavailable', 'R2 build storage is not configured.');
  let object;
  try { object = await bucket.get(build.file_key); }
  catch { return fail('storage_read_failed', 'The saved Prebid.js file could not be read. Try again.'); }
  if (!object) return fail('build_file_missing', 'The selected Prebid.js file is missing from R2.');
  if (!Number.isSafeInteger(object.size) || object.size < 1 || object.size > MAX_BYTES) return fail('invalid_build_size', 'The Prebid.js file must be between 1 byte and 20 MB.');
  const expected = object.customMetadata?.sha256;
  if (typeof expected !== 'string' || !SHA256.test(expected)) return fail('checksum_missing', 'The stored artifact has no verified upload checksum. Revalidate or upload it through the Prebid.js workspace.');
  let bytes;
  try { bytes = await object.arrayBuffer(); }
  catch { return fail('storage_read_failed', 'The Prebid.js file body could not be read. Try again.'); }
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== object.size || bytes.byteLength > MAX_BYTES) return fail('build_size_mismatch', 'The stored file length does not match its metadata.');
  report.build.byteSize = bytes.byteLength;
  report.build.sha256 = await sha256(bytes);
  if (report.build.sha256 !== expected) return fail('checksum_mismatch', 'The saved Prebid.js bytes no longer match the upload checksum.');
  let header;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.trimStart().startsWith('<')) return fail('invalid_build_content', 'An HTML document cannot be used as Prebid.js.');
    header = parsePrebidHeader(text.slice(0, HEADER_BYTES));
  } catch { return fail('invalid_build_header', 'The saved file is not readable Prebid.js with version/module declarations.'); }
  if (header.version !== build.version || (object.customMetadata?.version && object.customMetadata.version !== build.version)) return fail('version_mismatch', 'The Prebid version differs between the stored file and metadata.');
  if (JSON.stringify(header.modules) !== JSON.stringify(declared)) return fail('module_metadata_mismatch', 'The module declarations in Prebid.js differ from the saved build metadata.');
  if (!report.issues.length) report.status = 'checked';
  return report;
}
