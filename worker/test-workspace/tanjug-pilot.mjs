import { metadata, zipBase64, previewHtml, prebidConfig } from '../../.generated/tanjug-pilot.mjs';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const style = `*{box-sizing:border-box}body{margin:0;background:#edf0f5;color:#202a3b;font:16px system-ui}header{background:#171c24;color:white;padding:20px 28px;display:flex;justify-content:space-between}header a{color:white}main{padding:24px;max-width:1800px;margin:auto}.card{background:white;border:1px solid #d7dfec;border-radius:16px;padding:24px;margin-bottom:20px}h1{margin:0;font-size:28px}h2{font-size:20px}p{line-height:1.6;color:#536278}.actions{display:flex;gap:10px;flex-wrap:wrap}button,.button{display:inline-block;padding:12px 16px;border:1px solid #bcc9db;border-radius:9px;background:white;color:#283951;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}.primary{background:#f47725;border-color:#f47725;color:#231a12}iframe{display:block;width:100%;max-width:100%;height:78vh;min-height:500px;border:1px solid #bcc9db;border-radius:10px;margin:16px auto}code{overflow-wrap:anywhere}.badge{background:#e6f3eb;color:#24603b;border-radius:20px;padding:6px 10px;font-size:13px}li{line-height:1.8}details{margin-top:20px}summary{cursor:pointer;font-weight:700}a:focus-visible,button:focus-visible{outline:3px solid #f47725;outline-offset:3px}@media(max-width:600px){main{padding:12px}.card{padding:16px}h1{font-size:23px}header{padding:16px}}`;
function page() {
  return `<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tessera · Tanjug TEST</title><style>${style}</style></head><body><header><strong>Tessera · TEST</strong><a href="/">Nazad na Tesseru</a></header><main>
<section class="card"><span class="badge">Tanjug TEST v1 · TakeOver OFF</span><h1 style="margin-top:14px">Tanjug paket je spreman za probu</h1><p>19 pozicija · 6 mapa veličina · Criteo, OpenX, Teads i PubMatic.<br>GAM: <code>/22852026051/Tanjug.rs-Display/</code><br>ads.js ${escape(metadata.manifest.runtime.runtimeVersion)} · Prebid ${escape(metadata.manifest.prebidBuild.version)} sa 15 modula.</p>
<div class="actions"><a class="button primary" href="/test-api/pilots/tanjug/download">Preuzmi Tanjug ZIP</a><a class="button" href="/test-api/pilots/tanjug/prebid-config">Preuzmi prebid-config.json</a></div>
<p>ZIP sadrži novi ads.js, originalni Prebid i primer ugradnje za izolovanu test stranicu. Na toj stranici ostaje postojeći CMP. Provera stvarnih oglasa je sledeći korak.</p></section>
<section class="card"><h2>Pregled sa probnim banerima</h2><p>Ovaj prikaz pokreće novi ads.js uz probne banere, bez stvarne aukcije. Proveri Billboard i Sticky, pa skroluj do InText pozicija. Prikaz služi proveri pozicija i ponašanja skripte; nije kopija dizajna Tanjugovog sajta.</p><div class="actions"><button id="desktop" type="button" aria-pressed="true">Desktop</button><button id="mobile" type="button" aria-pressed="false">Mobilni · 390 px</button></div>
<iframe id="pilot-preview" title="Tanjug probne pozicije bez stvarnih oglasa" sandbox="allow-scripts" referrerpolicy="no-referrer" src="/pilot/tanjug/preview"></iframe></section>
<section class="card"><h2>Istorija paketa</h2><p><strong>Tanjug TEST v1 · 14.09.2026.</strong><br>Preuzeti su originalni GAM path, svi bidder ID-jevi, nazivi pozicija i mape. TakeOver je OFF. Prebid je nadograđen sa 10.10.0 na 11.34.0, uz potrebne module za valutu, floor i schain. Ugrađena skripta donosi zajednički sticky CSS, rezervisanu visinu pozicija i obradu CMP čekanja.</p><p>Refresh na mobilnom sada traži 50% vidljivosti, umesto prethodnih 40%. Zadržani su početnih 30 sekundi, rast intervala za 50%, maksimum 120 sekundi i 20 osvežavanja. Lotame podešavanje je preneto bez dopisivanja client ID-ja.</p><details><summary>Identitet i sadržaj paketa</summary><p>Paket: <code>${escape(metadata.descriptor.packageSha256)}</code></p><ul>${metadata.descriptor.files.map((f) => `<li>${escape(f.name)} · ${f.byteSize} B</li>`).join('')}</ul></details></section></main><script src="/pilot/tanjug/ui.js" defer></script></body></html>`;
}
const ui = `const frame=document.getElementById('pilot-preview');for(const mode of ['desktop','mobile'])document.getElementById(mode).addEventListener('click',()=>{frame.style.width=mode==='mobile'?'390px':'100%';for(const id of ['desktop','mobile'])document.getElementById(id).setAttribute('aria-pressed',String(id===mode));frame.src='/pilot/tanjug/preview';});`;

// Called only after the existing exact TEST boundary and authentication checks.
// Static, immutable package: no DB/R2 access, no arbitrary path or publisher selector.
export function tanjugPilotResponse(request, headers) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.search) return null;
  const response = (body, type, extra = {}) => new Response(body, { headers: { ...headers, 'content-type': type, ...extra } });
  switch (url.pathname) {
    case '/pilot/tanjug': return response(page(), 'text/html; charset=utf-8', {
      'content-security-policy': headers['content-security-policy'] + "; frame-src 'self'",
    });
    case '/pilot/tanjug/ui.js': return response(ui, 'application/javascript; charset=utf-8');
    case '/pilot/tanjug/preview': return response(previewHtml, 'text/html; charset=utf-8', {
      // Also sandbox top-level navigation to this URL. No same-origin capability,
      // parent access, storage, forms, popups or external script/network access.
      'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src about:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
      'referrer-policy': 'no-referrer',
    });
    case '/test-api/pilots/tanjug/download': return response(Uint8Array.from(atob(zipBase64), (c) => c.charCodeAt(0)), 'application/zip', {
      'content-disposition': `attachment; filename="${metadata.version}.zip"`, 'x-tessera-package-sha256': metadata.descriptor.packageSha256,
    });
    case '/test-api/pilots/tanjug/prebid-config': return response(JSON.stringify(prebidConfig, null, 2) + '\n', 'application/json; charset=utf-8', {
      'content-disposition': 'attachment; filename="prebid-config.json"',
    });
    default: return null;
  }
}
