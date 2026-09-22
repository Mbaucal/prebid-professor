import { readPackage } from './releases.mjs';
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
    assets: {ads:base64(files['ads.min.js']), css:base64(files['min-height.css']), prebid:files['prebid.js'] ? base64(files['prebid.js']) : null},
  };
}

export function renderPackageTestPage(model) {
  const cards = model.units.map(u => `<article class="slot-card" data-slot-card="${escape(u.id)}"><div class="slot-title"><strong>${escape(u.id)}</strong><small data-slot-state="${escape(u.id)}">Waiting</small></div><div id="${escape(u.id)}" class="wrapperAd${u.type === 'BTF' ? ' lazyAd' : ''}"></div></article>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · ${escape(model.siteId)} · Test page</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f2f5f7;color:#243945;font:15px/1.5 system-ui,sans-serif}header{background:#163e3d;color:#fff;padding:26px max(18px,calc((100vw - 1280px)/2))}h1{font-size:30px;margin:4px 0}h2{font-size:20px;margin:0 0 8px}header p{margin:6px 0;color:#c8e0dd}main{max-width:1320px;margin:auto;padding:20px}.panel,.metric,.slot-card{background:#fff;border:1px solid #dce5e7;border-radius:10px;padding:18px;margin-bottom:18px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric strong{display:block;font-size:28px}.muted,small{color:#617582}.actions,.statuses{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.statuses{margin-bottom:14px}button{font:inherit;padding:9px 14px;border-radius:7px;border:1px solid #cfdcde;background:#fff;cursor:pointer;color:#20443f}button.primary{background:#08795f;color:white;border-color:#08795f}button:disabled{opacity:.5;cursor:default}.pill{display:inline-block;padding:3px 8px;background:#eaf0f3;border-radius:5px;font-size:12px}.ok{background:#dff3e9;color:#006647}.wait{background:#fff0cc;color:#785409}.bad{background:#ffe0e6;color:#a12438}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;text-align:left}td,th{padding:10px;border-bottom:1px solid #e4ebee;vertical-align:top}th{color:#617582;background:#f6f8f9}.sizes{min-width:190px;max-width:360px;font-size:12px}.slot-title{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}.slot-card{scroll-margin-top:12px}.wrapperAd{outline:1px dashed #8ba8a2;background:repeating-linear-gradient(135deg,#f1f8f5,#f1f8f5 10px,#e8f1ee 10px,#e8f1ee 20px);margin-inline:auto}.float{position:fixed;right:12px;bottom:12px;z-index:2147483647;display:flex;gap:8px}.float button{box-shadow:0 2px 14px #0002}pre{white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;font-size:12px}textarea{width:100%;min-height:160px}a{color:#08795f}summary{cursor:pointer}footer{margin:24px 0 90px;color:#617582;font-size:13px}@media(max-width:700px){main{padding:12px}.metrics{grid-template-columns:repeat(2,1fr);gap:8px}.metric,.panel,.slot-card{padding:12px}.metric{margin-bottom:4px}h1{font-size:25px}}
footer,code{overflow-wrap:anywhere}
</style></head><body>
<header><small style="color:#b5d7d0">TESSERA / ${escape(model.siteId)} / TEST PAGE</small><h1>Check your saved ad positions</h1><p>Original saved package · script ${escape(model.runtimeVersion)} · ${model.prebidVersion ? 'Prebid ' + escape(model.prebidVersion) : 'GAM / AdX only'}</p></header>
<main><section class="metrics"><div class="metric"><span class="muted">DIVs present</span><strong data-metric="dom">—</strong></div><div class="metric"><span class="muted">GPT slots registered</span><strong data-metric="gpt">—</strong></div><div class="metric"><span class="muted">Active at this width</span><strong data-metric="active">—</strong></div><div class="metric"><span class="muted">Positions requested</span><strong data-metric="requests">—</strong></div></section>
<section class="panel"><div class="statuses"><span class="pill" data-asset="ads">ads.js: not started</span><span class="pill" data-asset="gpt">GPT: not started</span>${model.prebidVersion ? '<span class="pill" data-asset="prebid">Prebid: not started</span>' : ''}<span class="pill" data-viewport></span></div><div class="actions"><button class="primary" data-action="start">Start test</button><button data-action="console" disabled>Google Publisher Console</button><button data-action="scan" disabled>Scroll through positions</button><button data-action="copy">Copy report</button><button data-action="restart">Restart test</button></div><p data-summary role="status">Ready to test the selected package.</p><p class="muted">Start test loads the saved script${model.prebidVersion ? ' and its original Prebid file' : ''} and Google GPT. This can send real ad requests. Empty responses are OK for this check. Lazy positions wait until you scroll near them; a disabled size-map breakpoint is not a missing slot.</p><p class="muted">This isolated test has no publisher CMP or publisher storage context. It does not confirm consent, demand or the layout on the real website. Your saved settings and published channels stay unchanged.</p><textarea data-report hidden readonly aria-label="Report to copy"></textarea></section>
<section class="panel"><h2>All ${model.units.length} in-page positions</h2><div class="table-scroll"><table><thead><tr><th>Position</th><th>DIV</th><th>GPT</th><th>Sizes at this width</th><th>Requests</th><th>Last response</th></tr></thead><tbody data-rows></tbody></table></div><p class="muted" data-extras></p>${model.overlay ? `<p class="muted">TakeOver ${escape(model.overlay)} is created by the runtime. It has no handoff DIV and is shown separately when GPT registers it.</p>` : ''}</section>
<details class="panel"><summary>Package details and errors</summary><p>Package: <code>${escape(model.releaseId)}</code></p><p>GAM path: <code>${escape(model.adUnitPath)}</code></p><p>The table uses the saved package configuration. Registration, requests and responses are actual GPT observations, not simulated results.</p><pre data-errors>No errors recorded.</pre></details>
<h2>Test containers</h2><p class="muted">Diagnostic layout. Boxes show containers, not ad creatives. Sticky remains controlled by the saved script and may be hidden without a filled ad. Resize and restart for a fresh mobile or desktop test.</p>${cards}
<footer>Saved release ${escape(model.releaseId)} · No release or configuration writes.</footer></main><div class="float"><button data-action="stop" hidden>Stop scrolling</button><button data-action="top">↑ Results</button></div>
<script type="application/json" data-test-model>${json(model)}</script><script>${testPageScript}</script></body></html>`;
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
