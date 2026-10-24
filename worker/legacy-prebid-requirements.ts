import { USER_ID_CATALOG } from './user-id-config';
import { parsePrebidHeader, sha256 } from './runtime/prebid-artifact-check-v2.mjs';

type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Requirements of the imported-template path, independent of frozen engines. */
export function legacyPrebidModules(config: JsonRecord, version: string): string[] {
  if (config.enablePrebid === false) return [];
  const controls = isRecord(config.runtimeControls) ? config.runtimeControls : {};
  const consent = isRecord(controls.consent) ? controls.consent : {};
  const conversion = isRecord(controls.currencyConversion) ? controls.currencyConversion : {};
  const floors = isRecord(controls.floors) ? controls.floors : null;
  const modules: string[] = [];
  if (consent.mode !== 'contextual-test') {
    modules.push(Number(version.split('.')[0]) < 9 ? 'consentManagement' : 'consentManagementTcf');
    modules.push(Number(version.split('.')[0]) < 9 ? 'gdprEnforcement' : 'tcfControl');
  }
  if (conversion.enabled !== false) modules.push('currency');
  if (floors && floors.enabled !== false) modules.push('priceFloors');
  const editable = isRecord(config.userIdConfig) ? config.userIdConfig : {};
  const configured = Array.isArray(editable.modules) ? editable.modules.filter(isRecord) : [];
  const sync = isRecord(config.userSync) ? config.userSync : {};
  const ids = Array.isArray(sync.userIds) ? sync.userIds.filter(isRecord) : [];
  for (const id of ids) {
    const matching = configured.filter(item => item.enabled === true && item.name === id.name);
    const catalog = USER_ID_CATALOG.find(item => item.name === id.name);
    const explicit = [...new Set(matching.map(item => item.moduleCode))];
    const code = explicit.length === 1 ? explicit[0] : catalog?.moduleCode;
    if (explicit.length > 1 || typeof code !== 'string' || !/^[A-Za-z0-9_]+$/.test(code)
      || (catalog && code !== catalog.moduleCode)) {
      throw new Error(`The Prebid User ID module for ${String(id.name)} must be verified before release.`);
    }
    modules.push('userId', code);
  }
  return [...new Set(modules)].sort();
}

export function isLegacyPrebidConfig(config: JsonRecord): boolean {
  return config.enablePrebid !== false && !(isRecord(config.builtinRuntimeSelection) && config.builtinRuntimeSelection.runtime)
    && typeof config.generatorProfileId === 'string' && config.generatorProfileId.trim().length > 0;
}

/** Validate actual saved bytes, not an editable database module declaration alone. */
export async function checkedLegacyPrebidModules(
  config: JsonRecord,
  build: {version: string; modules_json: string; file_key: string},
  bucket: R2Bucket | undefined,
): Promise<string[]> {
  if (!bucket) throw new Error('Prebid storage is unavailable.');
  const object = await bucket.get(build.file_key);
  if (!object || !Number.isSafeInteger(object.size) || object.size < 1 || object.size > 20 * 1024 * 1024) {
    throw new Error('The current Prebid.js file is missing or has an invalid size.');
  }
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength !== object.size) throw new Error('The current Prebid.js file length differs from its stored metadata.');
  const header = parsePrebidHeader(new TextDecoder().decode(bytes.slice(0, 500_000)));
  let declared: unknown;
  try { declared = JSON.parse(build.modules_json); } catch { declared = null; }
  if (!Array.isArray(declared) || declared.some(value => typeof value !== 'string')
    || JSON.stringify([...new Set(declared)].sort()) !== JSON.stringify([...header.modules].sort())
    || header.version !== build.version) {
    throw new Error('The current Prebid.js header differs from its saved module or version metadata. Upload the original file again.');
  }
  const expected = object.customMetadata?.sha256;
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || await sha256(bytes) !== expected) {
    throw new Error('The current Prebid.js file does not match its verified upload checksum. Upload the original file again.');
  }
  return legacyPrebidModules(config, header.version).filter(module => !header.modules.includes(module));
}
