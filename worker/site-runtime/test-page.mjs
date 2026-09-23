import { readPackage } from './releases.mjs';
import { testPageStyles } from './test-page-styles.mjs';
import { testPageScript } from '../../.generated/test-page-client.mjs';

const decode = new TextDecoder('utf-8', { fatal: true });
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const json = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function base64(bytes) {
  let result = '';
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
const check = (ok, message, status = 409) => { if (!ok) throw Object.assign(new Error(message), { status }); };

// The authenticated HTML response has an opaque origin. Ad code cannot read the
// admin session, storage or API responses. Assets are embedded after the existing
// package reader verifies them: no public draft endpoint or auth bypass is added.
export const testPageHeaders = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  'cross-origin-opener-policy': 'same-origin',
  'content-security-policy': "sandbox allow-scripts allow-popups; default-src 'none'; script-src 'unsafe-inline' https: data: blob:; style-src 'unsafe-inline' https: data:; img-src https: data: blob:; font-src https: data:; connect-src https:; frame-src https: data: blob:; worker-src blob:; media-src https: data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function packageTestModel(files, siteId, releaseId) {
  check(files['config.json'] && files['ads.min.js'] && files['min-height.css'], 'This package does not contain the required test files.');
  const config = JSON.parse(decode.decode(files['config.json']));
  check(config.siteId === siteId && config.core && Array.isArray(config.core.explicitUnits), 'Package test configuration does not match this site.');
  const units = config.core.explicitUnits;
  check(units.length > 0 && units.length <= 500 && new Set(units.map(u => u.id)).size === units.length, 'Package positions are empty or duplicated.');
  check(units.every(u => typeof u.id === 'string' && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(u.id) && ['ATF','BTF'].includes(u.type)), 'Package positions are invalid.');
  check(typeof config.core.gamPath === 'string' && config.core.sizeMapsRaw && typeof config.core.sizeMapsRaw === 'object', 'Package GAM path or size maps are missing.');
  let adUnitPath = config.core.gamPath.trim();
  if (adUnitPath && !adUnitPath.startsWith('/')) adUnitPath = '/' + adUnitPath;
  if (adUnitPath && !adUnitPath.endsWith('/')) adUnitPath += '/';
  check(Boolean(config.prebidBuild) === Boolean(files['prebid.js']), 'Package Prebid dependency is inconsistent.');
  const overlay = config.adPosition?.code || (config.options?.takeOver?.enabled ? config.options.takeOver.adUnitCode : null);
  const normal = units.filter(u => u.id !== overlay);
  const sticky = [config.options?.sticky?.bottomAdUnitId, config.options?.sticky?.topAdUnitId].filter(Boolean);
  const lazyRules = config.lazyRules || {};
  const lazyFor = unit => ({enabled:unit.type === 'BTF', ...lazyRules.__DEFAULT__, ...lazyRules[unit.type === 'ATF' ? '__ATF__' : '__BTF__'], ...lazyRules[unit.id]});
  return {
    siteId, releaseId, runtimeVersion: config.runtime?.runtimeVersion || 'Unknown',
    adUnitPath, units: normal.map(u => ({id:u.id, type:u.type, sizes:u.sizes || [], sizeMapName:u.sizeMapName, sticky:sticky.includes(u.id), lazy:lazyFor(u)})),
    maps: config.core.sizeMapsRaw, overlay, prebidVersion: config.prebidBuild?.version || null,
    assets: {ads:base64(files['ads.min.js']), css:base64(files['min-height.css']), stickyCss:files['sticky.css'] ? base64(files['sticky.css']) : null, prebid:files['prebid.js'] ? base64(files['prebid.js']) : null},
  };
}

export function renderPackageTestPage(model) {
  const container = u => `<div id="${escape(u.id)}" class="wrapperAd${u.type === 'BTF' ? ' lazyAd' : ''}"></div>`;
  const cards = model.units.map(u => `<article class="slot-card" data-slot-card="${escape(u.id)}"><div class="slot-title"><strong>${escape(u.id)}</strong><small data-slot-state="${escape(u.id)}">Waiting</small></div>${u.sticky ? '<p class="muted">Sticky is attached directly to the page. Its saved CSS controls its screen position.</p>' : container(u)}</article>`).join('\n');
  const sticky = model.units.filter(u => u.sticky);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · ${escape(model.siteId)} · Test page</title>
<style>${testPageStyles}</style></head><body>
<div class="brandbar"><span class="brandmark" aria-hidden="true"><i></i><i></i><i></i></span><div><strong>Tessera</strong><small>Ad-tech control plane</small></div></div>
<header><div class="eyebrow">${escape(model.siteId)} / Saved package</div><h1>Test page</h1><p>Check your saved ad positions · script ${escape(model.runtimeVersion)} · ${model.prebidVersion ? 'Prebid ' + escape(model.prebidVersion) : 'GAM / AdX only'}</p></header>
<main><section class="metrics"><div class="metric"><span class="muted">DIVs present</span><strong data-metric="dom">—</strong></div><div class="metric"><span class="muted">GPT slots registered</span><strong data-metric="gpt">—</strong></div><div class="metric"><span class="muted">Active at this width</span><strong data-metric="active">—</strong></div><div class="metric"><span class="muted">Positions requested</span><strong data-metric="requests">—</strong></div></section>
<section class="panel"><div class="statuses"><span class="pill" data-asset="ads">ads.js: not started</span><span class="pill" data-asset="gpt">GPT: not started</span>${model.prebidVersion ? '<span class="pill" data-asset="prebid">Prebid: not started</span>' : ''}<span class="pill" data-viewport></span></div><div class="actions"><button class="primary" data-action="start">Start test</button><button data-action="console" disabled>Google Publisher Console</button><button data-action="scan" disabled>Scroll through positions</button><button data-action="copy">Copy report</button><button data-action="restart">Restart test</button></div><p data-summary role="status" aria-live="polite">Ready to test the selected package.</p><p class="notice" data-resize-notice hidden></p><p class="muted"><small>Start loads the original scripts and can send real ad requests. An empty ad is OK for this check.</small></p><details class="help"><summary>How this test works</summary><p>Start test loads the saved script${model.prebidVersion ? ' and its original Prebid file' : ''} and Google GPT. This can send real ad requests. Empty responses are OK for this check. Lazy positions wait until you scroll near them; a disabled size-map breakpoint is not a missing slot.</p><p class="muted">This isolated test has no publisher CMP or publisher storage context. It does not confirm consent, demand or the layout on the real website. Your saved settings and published channels stay unchanged.</p></details><textarea data-report hidden readonly aria-label="Report to copy"></textarea></section>
<section class="panel"><h2>All ${model.units.length} in-page positions</h2><p class="muted">Registration confirms the slot ID and GAM path. Empty responses are OK; lazy positions wait until you scroll near them.</p><p class="muted table-hint">Swipe the table to see sizes and responses.</p><div class="table-scroll" tabindex="0" role="region" aria-label="Ad position results"><table><thead><tr><th scope="col">Position</th><th scope="col">DIV</th><th scope="col">GPT</th><th scope="col">Sizes at this width</th><th scope="col">Requests</th><th scope="col">Last response</th></tr></thead><tbody data-rows></tbody></table></div><p class="muted" data-extras></p>${model.overlay ? `<p class="muted">TakeOver ${escape(model.overlay)} is created by the runtime. It has no handoff DIV and is shown separately when GPT registers it.</p>` : ''}</section>
${sticky.length ? `<section class="panel"><h2>Sticky inspection</h2><p class="muted">Live state reads the real ad container. An empty response can keep it hidden. Use CSS preview to see the saved Sticky position without an ad; it does not change the real slot or its GAM result.</p><div data-sticky-inspection></div><p class="muted">Opening the console with a button on this page saves the real state first and closes CSS preview. Compare it with Live state after opening. Google adds its own ad overlays. For a fresh comparison, open this page without console URL parameters.</p></section>` : ''}
<details class="panel" data-details><summary>Package details and errors <span class="pill" data-error-count>0 errors</span></summary><p>Package: <code>${escape(model.releaseId)}</code></p><p>GAM path: <code>${escape(model.adUnitPath)}</code></p><p>The table uses the saved package configuration. Registration, requests and responses are actual GPT observations, not simulated results.</p><pre data-errors>No errors recorded.</pre></details>
<h2>Test containers</h2><p class="muted">Diagnostic layout. Boxes show containers, not ad creatives. Sticky uses its original saved CSS; inspect its live state or enable CSS preview above. Resize and restart for a fresh mobile or desktop test.</p>${cards}
<footer>Saved release ${escape(model.releaseId)} · No release or configuration writes.</footer></main><div class="float"><span class="scan-progress" data-scan-progress hidden role="status"></span><button data-action="stop" hidden>Stop scrolling</button><button data-action="top">↑ Results</button></div>
${sticky.map(container).join('\n')}<script type="application/json" data-test-model>${json(model)}</script><script>${testPageScript}</script></body></html>`;
}

// Caller must authenticate the actor before entering this read-only response.
export async function packageTestPageResponse(request, env, site, releaseId, options = {}) {
  try {
    check(request.method === 'GET', 'Method not allowed.', 405);
    const query = new URL(request.url).searchParams;
    check([...query].every(([key,value]) => ['google_console','google_force_console','googfc'].includes(key) && ['', '1'].includes(value) && query.getAll(key).length === 1), 'Unknown test-page option.', 400);
    const saved = await readPackage(env, site, releaseId, options);
    return new Response(renderPackageTestPage(packageTestModel(saved.files, site, releaseId)), { headers:testPageHeaders });
  } catch (error) {
    return new Response(JSON.stringify({error:error.message}), {status:error.status || 422, headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
  }
}
