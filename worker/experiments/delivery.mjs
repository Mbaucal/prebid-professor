import { describeCandidate } from '../runtime/draft-release-store.mjs';
import { sha256 } from '../runtime/prebid-artifact-check.mjs';
import { describeDelivery, selectDelivery, SCRIPT_LAYOUT } from '../test-workspace/delivery-layout.mjs';

// Opt-in foundation only: no import from either live Worker, no DB/R2 bindings,
// no deployment, no mutation of a saved package or existing /ads.js route.
export const EXPERIMENT_PROFILE = 'experiment-preview-v1';
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,97}$/;
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const encode = value => JSON.stringify(value).replace(/</g, '\\u003c');
const noStore = {
  'cache-control': 'private, no-store',
  'cdn-cache-control': 'no-store',
  'cloudflare-cdn-cache-control': 'no-store',
  'content-type': 'application/javascript; charset=utf-8',
  'access-control-allow-origin': '*',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex',
};

function validate(input) {
  const expected = ['controlPackageSha256','enabled','experimentId','profile','revision','siteId','testPackageSha256','trafficB'];
  requireThat(input && Object.keys(input).sort().join(',') === expected.join(','), 'Unexpected experiment fields.');
  requireThat(input.profile === EXPERIMENT_PROFILE && typeof input.siteId === 'string' && NAME.test(input.siteId)
    && typeof input.experimentId === 'string' && NAME.test(input.experimentId), 'Invalid experiment identity.');
  requireThat(Number.isSafeInteger(input.revision) && input.revision > 0, 'Invalid experiment revision.');
  requireThat(typeof input.enabled === 'boolean' && Number.isInteger(input.trafficB) && input.trafficB >= 0 && input.trafficB <= 100, 'Invalid traffic allocation.');
  requireThat(HASH.test(input.controlPackageSha256) && HASH.test(input.testPackageSha256), 'Exact package pins are required.');
  return Object.freeze(structuredClone(input));
}

// Kept self-contained so exactly this function is serialized and exercised by tests.
function boot(context, assets) {
  var current = document.currentScript;
  if (!current || !current.src) return;
  var registry = window.__tesseraExperiments;
  if (!registry) registry = window.__tesseraExperiments = Object.create(null);
  if (registry[context.siteId]) return;
  var started = Date.now();
  var events = [];
  var state = { context: Object.freeze(context), status: 'loading',
    snapshot: function () { return { context: state.context, events: events.slice() }; } };
  registry[context.siteId] = state;
  function record(type) {
    events.push(Object.freeze({ type: type, elapsedMs: Math.max(0, Date.now() - started) }));
  }
  record('assigned'); // denominator includes conflicts, empty pages and failed loads
  // One experiment owns the shared GPT/Prebid namespace on this document.
  if (window.__tesseraExperimentOwner || window.__TESSERA_RUNTIME_STARTED || window.pbjs) {
    state.status = 'conflict'; record('conflict'); return;
  }
  window.__tesseraExperimentOwner = context.siteId;
  var loaderUrl = new URL(current.src);
  var nonce = current.nonce;
  function fail() { state.status = 'load-error'; record('load-error'); }
  function insert(name, hash, done) {
    var entry = document.createElement('script');
    entry.src = new URL('./releases/' + context.packageSha256 + '/' + name, loaderUrl).href;
    entry.integrity = hash;
    entry.crossOrigin = 'anonymous';
    entry.async = true;
    if (nonce) entry.nonce = nonce;
    var settled = false;
    entry.onload = function () { if (settled) return; settled = true; done(); };
    entry.onerror = function () { if (settled) return; settled = true; fail(); };
    try { (document.head || document.documentElement).appendChild(entry); }
    catch (_) { entry.onerror(); }
  }
  function ads() {
    // Detect a legacy runtime inserted while the pinned dependency was loading.
    if (window.__TESSERA_RUNTIME_STARTED) { state.status = 'conflict'; record('conflict'); return; }
    insert('ads.js', assets.ads, function () { state.status = 'loaded'; record('script-loaded'); });
  }
  if (assets.prebid) insert('prebid.js', assets.prebid, function () { record('prebid-loaded'); ads(); });
  else ads();
}

function integrity(hash) {
  return 'sha256-' + btoa(String.fromCharCode(...hash.match(/../g).map(byte => parseInt(byte, 16))));
}

/** Verify and snapshot both full packages before exposing only public JS files.
 * The registry must contain precisely the pinned packages; A/A uses one package.
 * All inputs are copied before yielding to prevent caller mutation races.
 */
export async function createExperimentDelivery(input, packages, { random = Math.random } = {}) {
  const config = validate(input);
  const pins = [...new Set([config.controlPackageSha256, config.testPackageSha256])].sort();
  requireThat(packages && Object.keys(packages).sort().join(',') === pins.join(','), 'Package registry must match the experiment pins.');
  const pending = pins.map(pin => ({pin, promise: describeCandidate(config.siteId, packages[pin])}));
  const checked = await Promise.all(pending.map(async ({pin, promise}) => {
    const original = await promise;
    requireThat(original.descriptor.packageSha256 === pin, 'Package pin does not match verified bytes.');
    const layout = await describeDelivery(original.descriptor, SCRIPT_LAYOUT);
    const delivery = await selectDelivery(original.files, original.descriptor, layout);
    return {pin, layout, files: delivery.files};
  }));
  const assets = new Map();
  const scriptHashes = new Map();
  const prebidHashes = new Map();
  for (const {pin, layout, files} of checked) {
    for (const file of layout.files) {
      assets.set('/releases/' + pin + '/' + file.name, {bytes: files[file.name], hash: file.sha256});
      if (file.name === 'ads.js') scriptHashes.set(pin, file.sha256);
      if (file.name === 'prebid.js') prebidHashes.set(pin, file.sha256);
    }
  }
  const loaderSha256 = await sha256(new TextEncoder().encode(boot.toString()));
  const identity = {config, loaderSha256, deliveries: checked.map(({pin,layout}) => ({packageSha256: pin, deliverySha256: layout.sha256}))};
  const deliverySha256 = await sha256(new TextEncoder().encode(JSON.stringify(identity)));

  return Object.freeze({
    deliverySha256,
    // Hosting adapters must call this only for the explicit experiment route.
    // No arbitrary origin fetching, query-string overrides, cookies or storage.
    fetch(request) {
      const url = new URL(request.url);
      if (!['GET','HEAD'].includes(request.method)) return new Response(null, {status:405, headers:{...noStore,allow:'GET, HEAD'}});
      if (url.search) return new Response(null, {status:404, headers:noStore});
      if (url.pathname === '/ads.js') {
        let variant = 'A';
        if (config.enabled && config.trafficB > 0) {
          if (config.trafficB === 100) variant = 'B';
          else {
            const sample = random();
            requireThat(typeof sample === 'number' && Number.isFinite(sample) && sample >= 0 && sample < 1, 'Invalid allocation sample.');
            variant = sample < config.trafficB / 100 ? 'B' : 'A';
          }
        }
        const pin = variant === 'A' ? config.controlPackageSha256 : config.testPackageSha256;
        const value = request.cf?.country;
        const country = typeof value === 'string' && /^[A-Z]{2}$/.test(value) && !['XX','ZZ','EU'].includes(value) ? value : null;
        const context = {profile:config.profile, siteId:config.siteId, experimentId:config.experimentId,
          revision:config.revision, active:config.enabled, variant, packageSha256:pin, deliverySha256, country};
        const body = '(' + boot.toString() + ')(' + encode(context) + ',' + encode({ads:integrity(scriptHashes.get(pin)),prebid:prebidHashes.has(pin)?integrity(prebidHashes.get(pin)):null}) + ');\n';
        return new Response(request.method === 'HEAD' ? null : body, {headers:noStore});
      }
      const asset = assets.get(url.pathname);
      if (!asset) return new Response(null, {status:404, headers:noStore});
      const headers = {...noStore, 'cache-control':'public, max-age=31536000, immutable',
        'cdn-cache-control':'public, max-age=31536000, immutable',
        'cloudflare-cdn-cache-control':'public, max-age=31536000, immutable', etag:'"'+asset.hash+'"'};
      // Asset URLs never contain geography or experimental assignment. They
      // contain only verified original bytes; config/manifest stay private.
      return new Response(request.method === 'HEAD' ? null : asset.bytes.slice(), {headers});
    },
  });
}
