/** Mutable admin preflight. Historical compiler bytes remain unchanged. */
export function assertCompilerStrings(value, field = 'Settings', depth = 0) {
  if (depth > 32) throw new Error(`${field} is too deeply nested.`);
  if (typeof value === 'string' && /[\u2028\u2029]/.test(value)) {
    throw new Error(`${field} contains a Unicode line separator (U+2028/U+2029). Replace it with a normal space before generating.`);
  }
  if (Array.isArray(value)) value.forEach((item, index) => assertCompilerStrings(item, `${field}[${index}]`, depth + 1));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    if (/[\u2028\u2029]/.test(key)) throw new Error(`${field} contains a Unicode line separator in a field name. Replace it with a normal space before generating.`);
    assertCompilerStrings(item, `${field}.${key}`, depth + 1);
  }
}

export function supportsLiteralSchain(runtime) {
  return runtime?.capabilities?.includes('literal-schain') === true
    || [['tessera-3.16.1', '3.16.1'], ['tessera-3.16.2', '3.16.2']].some(([id, version]) =>
      (runtime?.runtimeId ?? runtime?.id) === id && (runtime?.runtimeVersion ?? runtime?.version) === version);
}

export function assertSchainCompatibility(schain, runtime) {
  if (!schain || schain.enabled === false || supportsLiteralSchain(runtime)) return;
  for (const [index, node] of (schain.nodes ?? []).entries()) {
    for (const field of ['sid', 'rid', 'name']) if (typeof node?.[field] === 'string' && /\$(?:\$|&|'|`)/.test(node[field])) {
      throw new Error(`SChain node ${index + 1}.${field} contains a replacement token unsupported by this script version. Use a literal-safe script version or correct the value before generating.`);
    }
  }
}

export function assertSnapshotCompilerCompatibility(snapshot, runtime) {
  const config = JSON.parse(snapshot.config.config_json);
  for (const row of snapshot.bidders ?? []) assertCompilerStrings(JSON.parse(row.params_json), `Bidder ${row.bidder}.params`);
  for (const row of snapshot.overrides ?? []) assertCompilerStrings(JSON.parse(row.params_json), `Bidder override ${row.bidder}/${row.scope_key}.params`);
  assertCompilerStrings(config.userSync, 'User IDs');
  assertCompilerStrings(config.runtimeControls, 'Runtime settings');
  assertSchainCompatibility(config.runtimeControls?.schain, runtime);
  for (const [key, rule] of [
    ...(snapshot.rules ?? []).map(row => [row.rule_key, JSON.parse(row.rule_json)]),
    ...Object.entries(config.advancedUnitRules ?? {}),
  ]) if (rule?.timeout !== undefined && (!Number.isInteger(rule.timeout) || rule.timeout < 100 || rule.timeout > 30000)) {
    throw new Error(`Unit rule ${key}.timeout must be an integer between 100 and 30000. Review the saved rule before generating.`);
  }
  for (const id of config.userSync?.userIds ?? []) if (id.name === 'id5Id' && (!Number.isInteger(id.params?.partner) || id.params.partner <= 0)) {
    throw new Error('ID5 params.partner must be a positive integer. Open User ID modules and save the corrected Partner Number before generating.');
  }
}
