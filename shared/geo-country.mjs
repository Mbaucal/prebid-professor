/** Country metadata only. This module does not make consent or serving decisions. */
export function normalizeCountry(value) {
  // ISO 3166-1 alpha-2 plus XK, which can occur in IP geolocation databases.
  const codes = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW';
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value)) return null;
  return codes.split(' ').includes(value) ? value : null;
}

/** Self-contained factory: also serialized into the optional browser helper. */
export function createCountrySignal(options) {
  // ES2015 source is shared by the optional helper and the generated ads runtime.
  var root = options.root;
  var normalize = options.normalizeCountry;
  var timeoutMs = 1500;
  function now() { return root.performance && typeof root.performance.now === 'function' ? root.performance.now() : Date.now(); }
  var snapshot = Object.freeze({version:1, status:'idle', country:null, source:null, reason:null, elapsedMs:0});
  var promise;
  function ready() {
    if (promise) return promise;
    // Assign before starting fetch: even reentrant consumers share this promise.
    var resolve;
    promise = new Promise(function(done) { resolve = done; });
    var started = now();
    var timer;
    var controller;
    var settled = false;
    snapshot = Object.freeze({version:1, status:'pending', country:null, source:null, reason:null, elapsedMs:0});
    function elapsed() { return Math.max(0, Math.round(now() - started)); }
    function finish(country, reason) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) root.clearTimeout(timer);
      snapshot = Object.freeze({version:1, status:country ? 'known' : 'unknown', country,
        source:country ? 'cloudflare' : null, reason, elapsedMs:elapsed()});
      resolve(snapshot);
    }
    function fail(reason) { finish(null, reason); try { if (controller) controller.abort(); } catch (ignored) {} }
    if (typeof root.fetch !== 'function') { finish(null, 'unsupported'); return promise; }
    try {
      if (typeof root.AbortController === 'function') controller = new root.AbortController();
      timer = root.setTimeout(function() { fail('timeout'); }, timeoutMs);
      var init = {method:'GET', mode:'cors', credentials:'omit', cache:'no-store',
        redirect:'error', referrerPolicy:'no-referrer'};
      if (controller) init.signal = controller.signal;
      Promise.resolve(root.fetch(options.endpoint, init)).then(function(response) {
        if (settled) return;
        if (!response.ok) { fail('http-error'); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) {
          fail('invalid-response'); return;
        }
        return response.text();
      }).then(function(text) {
        if (settled) return;
        if (elapsed() >= timeoutMs) { fail('timeout'); return; }
        if (text.length > 2048) { fail('invalid-response'); return; }
        var data;
        try { data = JSON.parse(text); } catch (ignored) { fail('invalid-response'); return; }
        if (!data || data.version !== 1 || data.source !== 'cloudflare') { fail('invalid-response'); return; }
        var country = normalize(data.country);
        if (data.status === 'known' && country) finish(country, null);
        else if (data.status === 'unknown' && data.country === null) finish(null, 'unavailable');
        else fail('invalid-response');
      }).catch(function() { if (!settled) fail('network-error'); });
    } catch (ignored) { fail('network-error'); }
    return promise;
  }
  return Object.freeze({version:1, getSnapshot:function() { return snapshot; }, ready:ready});
}

export function countryClientSource(endpoint) {
  // Keep both functions self-contained; verify the emitted, bundled source too.
  return `/* Optional country signal v1. No consent or ad-serving changes. */\n(function(root){\n` +
    `if (Object.prototype.hasOwnProperty.call(root, '__AD_GEO')) return;\n` +
    `var api = (${createCountrySignal.toString()})({root:root,endpoint:${JSON.stringify(endpoint).replace(/</g, '\\u003c')},normalizeCountry:(${normalizeCountry.toString()})});\n` +
    `Object.defineProperty(root,'__AD_GEO',{value:api,configurable:false,writable:false});\n` +
    `api.ready();\n})(window);\n`;
}
