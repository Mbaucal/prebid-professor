/** Country metadata only. This module does not make consent or serving decisions. */
export function normalizeCountry(value) {
  // ISO 3166-1 alpha-2 plus XK, which can occur in IP geolocation databases.
  const codes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW';
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) return null;
  return codes.split(' ').includes(value) ? value : null;
}

/** Self-contained factory: also serialized into the optional browser helper. */
export function createCountrySignal(options) {
  const root = options.root;
  const normalize = options.normalizeCountry;
  const timeoutMs = 1500;
  const now = () => root.performance?.now?.() ?? Date.now();
  let snapshot = Object.freeze({version:1, status:'idle', country:null, source:null, reason:null, elapsedMs:0});
  let promise;
  function ready() {
    if (promise) return promise;
    // Assign before starting fetch: even reentrant consumers share this promise.
    let resolve;
    promise = new Promise(done => { resolve = done; });
    const started = now();
    let timer;
    let controller;
    let settled = false;
    snapshot = Object.freeze({...snapshot, status:'pending'});
    const elapsed = () => Math.max(0, Math.round(now() - started));
    const finish = (country, reason) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) root.clearTimeout(timer);
      snapshot = Object.freeze({version:1, status:country ? 'known' : 'unknown', country,
        source:country ? 'cloudflare' : null, reason, elapsedMs:elapsed()});
      resolve(snapshot);
    };
    const fail = reason => { finish(null, reason); try { controller?.abort(); } catch {} };
    if (typeof root.fetch !== 'function') { finish(null, 'unsupported'); return promise; }
    try {
      if (typeof root.AbortController === 'function') controller = new root.AbortController();
      timer = root.setTimeout(() => fail('timeout'), timeoutMs);
      const init = {method:'GET', mode:'cors', credentials:'omit', cache:'no-store',
        redirect:'error', referrerPolicy:'no-referrer'};
      if (controller) init.signal = controller.signal;
      Promise.resolve(root.fetch(options.endpoint, init)).then(async response => {
        if (settled) return;
        if (!response.ok) { fail('http-error'); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
          fail('invalid-response'); return;
        }
        const text = await response.text();
        if (settled) return;
        if (elapsed() >= timeoutMs) { fail('timeout'); return; }
        if (text.length > 2048) { fail('invalid-response'); return; }
        let data;
        try { data = JSON.parse(text); } catch { fail('invalid-response'); return; }
        if (!data || data.version !== 1 || data.source !== 'cloudflare') { fail('invalid-response'); return; }
        const country = normalize(data.country);
        if (data.status === 'known' && country) finish(country, null);
        else if (data.status === 'unknown' && data.country === null) finish(null, 'unavailable');
        else fail('invalid-response');
      }).catch(() => { if (!settled) fail('network-error'); });
    } catch { fail('network-error'); }
    return promise;
  }
  return Object.freeze({version:1, getSnapshot:() => snapshot, ready});
}

export function countryClientSource(endpoint) {
  // Keep both functions self-contained; verify the emitted, bundled source too.
  return `/* Optional country signal v1. No consent or ad-serving changes. */\n(function(root){\n` +
    `if (Object.prototype.hasOwnProperty.call(root, '__AD_GEO')) return;\n` +
    `var api = (${createCountrySignal.toString()})({root:root,endpoint:${JSON.stringify(endpoint).replace(/</g, '\\u003c')},normalizeCountry:(${normalizeCountry.toString()})});\n` +
    `Object.defineProperty(root,'__AD_GEO',{value:api,configurable:false,writable:false});\n` +
    `api.ready();\n})(window);\n`;
}
