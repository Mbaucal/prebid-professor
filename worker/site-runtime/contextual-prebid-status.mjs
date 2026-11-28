/** Read-only integration status from the current uploaded build's metadata. */
export function contextualPrebidStatus(builds, selectedId = null) {
  const required = ['rtdModule', 'contextualSignalsRtdProvider'];
  const result = {status: 'no-build', buildId: null, selectedBuildId: selectedId,
    selectionMatches: false, missingModules: required.slice(), evidence: 'current-build-metadata'};
  if (!Array.isArray(builds) || !builds.length) return result;
  if (builds.length !== 1 || !builds[0] || typeof builds[0] !== 'object' || Array.isArray(builds[0])) { result.status = 'unknown'; return result; }
  const build = builds[0];
  result.buildId = typeof build.id === 'string' ? build.id : null;
  result.selectionMatches = result.buildId !== null && selectedId === result.buildId;
  let modules;
  try { modules = JSON.parse(build.modules_json); } catch (_) { result.status = 'unknown'; return result; }
  if (!Array.isArray(modules) || modules.some(name => typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name))) {
    result.status = 'unknown'; return result;
  }
  result.missingModules = required.filter(name => !modules.includes(name));
  result.status = result.missingModules.length ? 'modules-missing' : 'modules-present';
  return result;
}
