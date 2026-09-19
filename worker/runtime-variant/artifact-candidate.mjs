import { descriptor as rawDescriptor } from '../../.generated/runtime-variant-manifest.mjs';
import { validateRuntimeDescriptor } from '../runtime/version-pin.mjs';
import { compileVariant } from './compiler.mjs';
export const runtimeDescriptor=validateRuntimeDescriptor(rawDescriptor);
import { previewInput, PREBID_SHA256 } from '../runtime-cache/snapshot.mjs';
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
  if (requirements.required) {
    if (!prebid?.report || prebid.report.status !== 'checked' || prebid.report.siteId !== snapshot.site.id || !(prebid.bytes instanceof ArrayBuffer)) {
      throw new Error('A checked Prebid artifact for this site is required.');
    }
    if (prebid.bytes.byteLength < 1 || prebid.bytes.byteLength > 8 * 1024 * 1024) throw new Error('Candidate bundles support Prebid files up to 8 MB.');
    const hash = await sha256(prebid.bytes);
    if(hash!==PREBID_SHA256||prebid.report.build?.version!=='11.34.0')throw new Error('This candidate requires the exact reviewed Tanjug Prebid 11.34.0 bytes.');
    if (hash !== prebid.report.build?.sha256 || prebid.bytes.byteLength !== prebid.report.build?.byteSize) throw new Error('Prebid artifact changed after verification.');
    if (JSON.stringify(requirements.modules) !== JSON.stringify(prebid.report.requiredModules)) throw new Error('Prebid requirements differ from the generated configuration.');
    prebidPin = { ...prebid.report.build, modules: [...prebid.report.declaredModules] };
  } else if (prebid !== null) throw new Error('Do not attach a Prebid artifact to a GPT-only candidate.');

  // Validate layout before parsing/minifying source. This never guesses unsupported settings.
  const placeholderCss = placeholderStyles({...input,core:{...input.core,
    explicitUnits:input.core.explicitUnits.filter(u=>u.id!==input.overlay?.code)}});
  const stickyCss = stickyStyles(input.options.sticky.bottomAdUnitId);
  const generated = compileVariant(input,runtimeDescriptor);
  const js = await finalizeJavaScript(installSharedStickyStyles(generated.adsJs, stickyCss), { cleanComments });
  const files = Object.create(null);
  files['ads.js'] = text.encode(js.adsJs);
  files['ads.min.js'] = text.encode(js.adsMinJs);
  files['sticky.css'] = text.encode(stickyCss || '/* Sticky is disabled for this candidate. */\n');
  files['min-height.css'] = text.encode(placeholderCss);
  if (prebid) files['prebid.js'] = new Uint8Array(prebid.bytes.slice(0));
  // Only normalized public runtime settings, never arbitrary saved admin/connector fields.
  files['config.json'] = text.encode(`${JSON.stringify({ schemaVersion: 1, siteId: snapshot.site.id, runtime: pin,
    core: input.core, options: input.options, bidCache: input.bidCache, adPosition: input.overlay, lazyRules: input.lazyRules, output: { cleanComments }, prebidBuild: prebidPin }, null, 2)}\n`);
  const units = input.core.explicitUnits.filter((u) => u.id !== input.options.sticky.bottomAdUnitId && u.id !== input.overlay?.code);
  const htmlUnits = units.map((u) => `  <div id="${escapeHtml(u.id)}" class="wrapperAd${u.type === 'BTF' ? ' lazyAd' : ''}"></div>`).join('\n');
  const pbTag = requirements.required ? '  <script src="./prebid.js"></script>\n' : '';
  files['implementation.html'] = text.encode(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tessera candidate — ${escapeHtml(snapshot.site.name)}</title>
<!-- REVIEW CANDIDATE ONLY. Place the site's approved CMP before ad libraries. Do not deploy to production. -->
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
  files['README.txt'] = text.encode(`Tessera built-in runtime CANDIDATE\n\nThis ZIP is generated in memory from one saved configuration and an exact runtime source ID. It does not create a Tessera release, publish, update the publisher CMS or change any live ads.txt.\n\nDo not replace a production wrapper with this candidate. Approved isolated staging, actual GPT/Prebid delivery, stored runtime/Prebid pins, complete-release promotion and rollback remain required.\n\nads.js and ads.min.js have the same parser-validated behavior. Use one, never both. sticky.css matches the injected stylesheet and is optional. min-height.css supplies responsive placeholders, excluding sticky and TakeOver. Empty/fluid-only breakpoints reset reserved height to 0.\n\nimplementation.html is an integration example, NOT an offline safe test page. Opening it as a served page can request real Google ads using the configured GAM paths. Keep the approved CMP and use only an authorized staging page.\n\nRuntime: ${pin.runtimeVersion}\nSource SHA-256: ${pin.runtimeSha256}\nPrebid: ${prebidPin ? `${prebidPin.version} / ${prebidPin.sha256}` : 'disabled (GPT-only)'}\n`);
  const manifest = {
    schemaVersion: 1, kind: 'builtin-runtime-candidate', completeRelease: false,
    siteId: snapshot.site.id, buildTimestamp, configHash: await digest(snapshot),
    runtime: pin, prebidBuild: prebidPin, minifier: js.minifier,
    patches: [...generated.patches, 'shared injected/exported sticky stylesheet', 'responsive zero-height reset', 'parser-based output formatting'],
    warnings: [...generated.warnings, 'Candidate only. Release registration, staging delivery, publication and rollback are not included.'],
    files: {},
  };
  for (const [name, bytes] of Object.entries(files)) manifest.files[name] = { byteSize: bytes.byteLength, sha256: await sha256(bytes) };
  files['manifest.json'] = text.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, files };
}
