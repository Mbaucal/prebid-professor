/** Build-time compatibility patch. Only the wrapper's named consent fallback is changed. */
export function patchWrapperConsentTimer(source) {
  const startMarker = 'function resolveConsent(cb, timeoutMs){';
  const endMarker = '/* ====== PPID iz ID5 ====== */';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < start || source.indexOf(startMarker, start + startMarker.length) >= 0) {
    throw new Error('Advanced runtime could not uniquely locate the wrapper consent resolver.');
  }
  const block = source.slice(start, end);
  const pattern = /(setTimeout\(function\(\)\{\s*finish\(\{p:false,\s*src:'consent:timeout'\}\);\s*\},\s*)Math\.min\(\s*\d+\s*,\s*1500\s*\)(\);)/g;
  if ([...block.matchAll(pattern)].length !== 1) {
    throw new Error('Advanced runtime could not uniquely locate the wrapper consent timer.');
  }
  const patched = block.replace(pattern, (_match, before, after) =>
    `${before}Math.max(100, Math.min(Number(timeoutMs || window.__PP_CONSENT_TIMEOUT || 1500), 30000))${after}`);
  return source.slice(0, start) + patched + source.slice(end);
}
