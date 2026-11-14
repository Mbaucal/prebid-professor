import { descriptor as rawDescriptor } from '../../.generated/runtime-3162-manifest.mjs';
import { validateRuntimeDescriptor } from '../runtime/version-pin.mjs';
import { compileRuntime3162, idempotentStickyStyles } from './compiler.mjs';
import { dealPlan } from '../../shared/deals/gam-plan.mjs';
import { reportingContract } from '../runtime-reporting-v1/contract.mjs';
const runtimeDescriptor=validateRuntimeDescriptor(rawDescriptor);
import { previewInput } from './snapshot.mjs';
import { digest } from '../runtime/preview-snapshot.mjs';
import { assertPinnedRuntime } from '../runtime/version-pin.mjs';
import { prebidRequirements, sha256 } from '../runtime/prebid-artifact-check.mjs';
import { finalizeJavaScript } from '../runtime/artifact-minifier.mjs';
import { stickyStyles, installSharedStickyStyles, placeholderStyles } from '../runtime/artifact-styles.mjs';

const text = new TextEncoder();
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** In-memory only. Never creates a stored Release, changes a channel or publishes. */
export async function buildArtifactCandidate({ snapshot, takeOver = { enabled: false }, pin, buildTimestamp, prebid = null }) {
  assertPinnedRuntime(pin, runtimeDescriptor, { configSchemaVersion: 1, capabilities: ['config-preview'] });
  const input = previewInput(snapshot, runtimeDescriptor, buildTimestamp, takeOver);
  const config = JSON.parse(snapshot.config.config_json);
  const outputConfig = config.runtimeControls?.output ?? {};
  const cleanComments = outputConfig.cleanComments ?? true;
  if (typeof cleanComments !== 'boolean') throw new Error('Output cleanComments must be a boolean.');
  const requirements = prebidRequirements(input, config);
  if (requirements.issues.length) throw new Error(requirements.issues.map((issue) => issue.message).join(' '));
  let prebidPin = null;
  if (input.outstream.disabledRefreshCodes.length && prebid?.report?.build?.version !== '11.34.0') throw Error('This Outstream pilot requires the verified Prebid 11.34.0 build.');
  if (requirements.required) {
    if (!prebid?.report || prebid.report.status !== 'checked' || prebid.report.siteId !== snapshot.site.id || !(prebid.bytes instanceof ArrayBuffer)) {
      throw new Error('A checked Prebid artifact for this site is required.');
    }
    if (prebid.bytes.byteLength < 1 || prebid.bytes.byteLength > 8 * 1024 * 1024) throw new Error('Tessera bundles support Prebid files up to 8 MB.');
    const hash = await sha256(prebid.bytes);
    if (hash !== prebid.report.build?.sha256 || prebid.bytes.byteLength !== prebid.report.build?.byteSize) throw new Error('Prebid artifact changed after verification.');
    if (JSON.stringify(requirements.modules) !== JSON.stringify(prebid.report.requiredModules)) throw new Error('Prebid requirements differ from the generated configuration.');
    prebidPin = { ...prebid.report.build, modules: [...prebid.report.declaredModules] };
  } else if (prebid !== null) throw new Error('Do not attach a Prebid artifact to a GAM-only bundle.');

  // Validate layout before parsing/minifying source. This never guesses unsupported settings.
  const placeholderCss = placeholderStyles({...input,core:{...input.core,
    explicitUnits:input.core.explicitUnits.filter(u=>u.id!==input.overlay?.code)}});
  const stickyCss = stickyStyles(input.options.sticky.bottomAdUnitId);
  const generated = compileRuntime3162(input);
  const js = await finalizeJavaScript(idempotentStickyStyles(installSharedStickyStyles(generated.adsJs, stickyCss)), { cleanComments });
  const files = Object.create(null);
  files['ads.js'] = text.encode(js.adsJs);
  files['ads.min.js'] = text.encode(js.adsMinJs);
  files['sticky.css'] = text.encode(stickyCss || '/* Sticky is disabled for this configuration. */\n');
  files['min-height.css'] = text.encode(placeholderCss);
  files['gam-reporting.json'] = text.encode(JSON.stringify(reportingContract, null, 2) + '\n');
  files['deals-plan.json'] = text.encode(JSON.stringify(dealPlan(snapshot,input.deals??{schemaVersion:1,entries:[]}),null,2)+'\n');
  if (prebid) files['prebid.js'] = new Uint8Array(prebid.bytes.slice(0));
  // Only normalized public runtime settings, never arbitrary saved admin/connector fields.
  files['config.json'] = text.encode(`${JSON.stringify({ schemaVersion: 1, siteId: snapshot.site.id, runtime: pin,
    core: input.core, options: input.options, deals: input.deals, outstream: input.outstream, adPosition: input.overlay, lazyRules: input.lazyRules, output: { cleanComments }, prebidBuild: prebidPin }, null, 2)}\n`);
  const units = input.core.explicitUnits.filter((u) => u.id !== input.options.sticky.bottomAdUnitId && u.id !== input.overlay?.code);
  const htmlUnits = units.map((u) => `  <div id="${escapeHtml(u.id)}" class="wrapperAd${u.type === 'BTF' ? ' lazyAd' : ''}"></div>`).join('\n');
  const pbTag = requirements.required ? '  <script src="./prebid.js"></script>\n' : '';
  files['implementation.html'] = text.encode(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tessera 3.16.2 — ${escapeHtml(snapshot.site.name)}</title>
<!-- Tessera 3.16.2 integration example. Place the site's approved CMP before ad libraries. -->
<link rel="stylesheet" href="./min-height.css">
<!-- sticky.css is optional: ads.js injects the identical stylesheet. -->
<script async src="https://securepubads.g.doubleclick.net/tag/js/gpt.js" crossorigin="anonymous"></script>
${pbTag}<script defer src="./ads.min.js"></script>
</head><body>
${htmlUnits}
</body></html>\n`);
  const csv = (v) => `"${String(v).replace(/"/g, '""')}"`;
  files['div-export.csv'] = text.encode(['ad_unit,type,html', ...units.map((u) => [u.id, u.type,
    `<div id="${u.id}" class="wrapperAd${u.type === 'BTF' ? ' lazyAd' : ''}"></div>`].map(csv).join(','))].join('\n') + '\n');
  files['README.txt'] = text.encode(`Tessera 3.16.2\n\nGenerated from the saved site configuration and an exact Tessera runtime source. Generating or downloading this bundle does not change the publisher CMS, ads.txt or live script URLs. Save, stage and publish through the release workflow when ready.\n\nads.js and ads.min.js have the same parser-validated behavior. Use one, never both. Load the approved CMP before ad libraries. When Prebid is included, load prebid.js before the Tessera script. sticky.css matches the injected stylesheet and is optional. min-height.css supplies responsive placeholders, excluding Sticky and TakeOver. Empty or fluid-only breakpoints reset reserved height to 0.\n\nimplementation.html shows the script order and saved ad containers. Serving it can request real Google ads using the configured GAM paths; review it on the intended authorized site.\n\nRuntime: ${pin.runtimeVersion}\nSource SHA-256: ${pin.runtimeSha256}\nPrebid: ${prebidPin ? `${prebidPin.version} / ${prebidPin.sha256}` : 'disabled (GAM / AdX only)'}\n`);
  const manifest = {
    schemaVersion: 1, kind: 'builtin-runtime-candidate', completeRelease: false,
    siteId: snapshot.site.id, buildTimestamp, configHash: await digest(snapshot),
    runtime: pin, prebidBuild: prebidPin, minifier: js.minifier,
    patches: [...generated.patches, 'shared injected/exported sticky stylesheet', 'responsive zero-height reset', 'parser-based output formatting'],
    warnings: [...generated.warnings, 'Package creation, staging and publication are separate explicit actions.'],
    files: {},
  };
  files['README.txt'] = text.encode(new TextDecoder().decode(files['README.txt']) +
    '\nGAM reporting\nThis version adds seven slot-level request labels. GAM-only sends refresh_count, refresh_bucket, refresh_interval and refresh_policy, with no aq_* values. Completed Prebid auctions also report positive current-auction bid counts and the auction timeout flag. See gam-reporting.json for every value and its meaning.\n\nCreate the custom targeting keys/values and enable reporting in GAM before collecting results. Downloading or selecting this version does not configure GAM reporting. Counts are requests and bids, not impressions, winning demand or revenue. Old packages retain their original behavior.\n');
  files['README.txt'] = text.encode(new TextDecoder().decode(files['README.txt']) + '\nConsent readiness\nThis version waits for a completed TCF CMP decision with explicit GDPR scope. Unknown scope, missing CMP or pending user choice never become a non-personalized-ad fallback. Rejection is passed to GPT/Prebid through the CMP; these libraries enforce their serving/activity rules. No mode is inferred from a timer. A later CMP event can resume blocked work.\nPrebid readiness waits at most 3 seconds per page after the first completed decision, pre-auction hooks have a separate 10-second watchdog, and the bid deadline starts at the matching auctionInit. Failures request GAM only after a valid CMP decision, with no stale hb_* or aq_* data. Local diagnostics: window.__tesseraReadiness.snapshot(), with phase/timing only, never TC strings or IDs.\nThe previous direct ID5 localStorage-to-PPID bridge is disabled in this version pending its separate review. Existing ID5 Prebid module configuration remains under TCF enforcement.\nHosted publisher CMP/GPT verification is still required; offline tests do not prove live Google wire parameters or revenue.\n');
  files['README.txt'] = text.encode(new TextDecoder().decode(files['README.txt']) + '\nDeals and Outstream\nDeals use native returned bidder-specific deal/adId targeting. A configured Deal ID alone never makes a GAM line item eligible. Native Send All Bids exposes one selected bid per bidder per position; simultaneous same-bidder responses are not independently targetable. GAM priority is configured separately according to the commercial agreement; this package never writes to GAM.\nOutstream is a PubMatic / Prebid 11.34.0 pilot. Confirm partner activation, renderer ID, VAST cache and compatible GAM/PUC creative in staging. Responsive video sizes come from the saved position size map at the current viewport. Single eligible sizes are automatic; multi-size breakpoints use the saved choice. Banner sizes are unchanged. A pending video bid is not rendered after a viewport change selects different video dimensions. Video may render only from the selected creative. Automatic refresh stays off on all video-enabled positions; player lifecycle and revenue require separate hosted verification.\n');
  files['README.txt'] = text.encode(new TextDecoder().decode(files['README.txt']) + '\nFixed in 3.16.1\n- Effective position refresh rules start the content scheduler. A site without refresh overrides uses its inherited 30-second baseline after explicitly selecting this version. Explicitly disabled rules stay disabled.\n- Wall-clock gaps are measured from actual requests, including the initial request; a larger saved gap can delay the first automatic refresh. Sticky follows its inherited schedule, empty Sticky retries remain possible, and duplicate tab pause events preserve remaining dwell time. refresh_interval reports the effective minimum spacing (the greater of interval and wall-clock gap). Refresh counters advance only for actual allowed automatic requests.\n- An empty, invalid or timed-out TakeOver releases exactly one consent-gated Interstitial fallback. A viewport-disabled TakeOver skips cleanly; its diagnostics expose current map dimensions.\n- Initial pages without content wrappers discover configured wrappers for at most 20 seconds. This is not general infinite-scroll inventory. Existing configured lazy rules keep ownership of their requests.\n- Cached lazy targeting is revalidated against current-auction, unexpired native Prebid responses, including bidder-specific Send All Bids keys. When all previous bids expired, one replacement auction is allowed before one GAM dispatch.\n- Late window.adsKeywords is polled for 2.5 seconds and can affect later requests. Set keywords before ads.js for initial targeting and page-type size maps. SChain values are preserved exactly.\n- Generated syntax is parser-checked as ES2015. This is a syntax boundary, not a guarantee of every older browser API or polyfill.\nLimits\nThe existing safe GAM-only path after an in-flight CMP decision change is retained. Automatic CMP recovery, GEO decisions, general SPA inventory discovery and additional video partners are not added. Old scripts and saved packages remain unchanged.\n');
  files['README.txt'] = text.encode(new TextDecoder().decode(files['README.txt']) + '\nFixed in 3.16.2\n- An empty Sticky retry that the refresh interval or minimum wall-clock gap refuses is rescheduled for the exact remaining time instead of stopping. If the device clock moved back and the retry is still refused, it is rescheduled again, at most three times per retry and only while no other Sticky request was made. The retry count, maximum refreshes, Sticky close, page visibility and CMP decision still apply, and no request is sent earlier than the saved gap after the previous actual request.\n- An empty Sticky retry that becomes due while the page is hidden, or just as the page is paused, waits for the page to become active again. A refresh gap computed for one attempt is not reused by a later timer.\n- A position, including a filled Sticky, whose Default, group and position refresh settings save no minimum in-view percentage now uses the inherited threshold at refresh time: 50% unless the Default refresh, or the ATF refresh when there is no Default refresh, saves another value. Saved percentages, including 0, are unchanged, and the view entry and exit thresholds are the same as in 3.16.1.\n- While a queued content refresh is still waiting to be sent, the content timer already uses the next schedule step, so a later shorter step (for example 30, 90, 45 s) returns to the 3.16.0 request times when the queued request is sent within that next step. With very short steps and slower sends it waits as 3.16.1 did. No request is made before the interval that the actual refresh count allows; refresh counts still advance only for actual requests, and the minimum wall-clock gap still applies.\nEverything else is identical to 3.16.1. Old scripts and saved packages remain unchanged.\n');
  for (const [name, bytes] of Object.entries(files)) manifest.files[name] = { byteSize: bytes.byteLength, sha256: await sha256(bytes) };
  files['manifest.json'] = text.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files };
}
