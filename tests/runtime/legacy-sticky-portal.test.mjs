import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'acorn';
import { buildReference391 } from '../../.generated/reference391.mjs';
import { compileRuntime } from '../../worker/runtime-compiler.ts';
import { compileReferenceBuild } from '../../worker/runtime/reference-bridge.mjs';
import { fixture } from './bridge-fixture.mjs';
import { patchLegacyStickyPortal, patchLegacyStickyPortalCss } from '../../worker/legacy-sticky-portal.mjs';

const f = fixture(); f.options.enablePrebid = false; f.options.takeOver.enabled = false;
const actual = compileReferenceBuild(f.core, f.options, { buildReference391, compileRuntime }).adsJs;

test('legacy portal stays byte-identical while disabled', () => {
  assert.strictEqual(patchLegacyStickyPortal(actual, false), actual);
  assert.strictEqual(patchLegacyStickyPortalCss('unchanged css', false), 'unchanged css');
});
test('actual generated reference gets code-scoped CSS properties, one reusable button and closed-state cleanup', () => {
  const output = patchLegacyStickyPortal(actual, true);
  assert.notEqual(output, actual);
  parse(output, { ecmaVersion: 'latest' });
  assert(!/\.setProperty\(['"](?:zIndex|pointerEvents|alignItems|justifyContent|borderRadius|fontFamily|fontSize|lineHeight|boxShadow|userSelect)['"]/.test(output));
  assert(output.includes("document.getElementById('close_sticky_ad') || host.querySelector('#close_sticky_ad')"));
  assert.equal(output.split('if (_sticky && _sticky.closed) return;').length - 1, 2);
  assert.equal(output.split('if (btn.parentNode === document.body) btn.parentNode.removeChild(btn);').length - 1, 2);
  assert.equal(patchLegacyStickyPortal(output, true), output, 'repeated compilation cannot duplicate patches');
});
test('unrelated text, both quote styles and unrelated styles are preserved', () => {
  const output = patchLegacyStickyPortal(actual.replace("setProperty('zIndex'", 'setProperty("zIndex"'), true);
  assert(output.includes('setProperty("z-index"'));
  const withText = actual + '\nvar partnerLabel="setProperty(\\\"zIndex\\\", 5)";';
  assert(patchLegacyStickyPortal(withText, true).endsWith('var partnerLabel="setProperty(\\\"zIndex\\\", 5)";'));
  const unrelated = '\nfunction customPartnerStyle(){partner.style.setProperty("zIndex","2");}';
  assert(patchLegacyStickyPortal(actual + unrelated, true).endsWith(unrelated), 'unrelated partner code stays byte-identical');
});
test('unsupported or ambiguous imported portal source fails before a new package is stored', () => {
  assert.throws(() => patchLegacyStickyPortal('function unrelated(){}', true), /compatible template/);
  assert.throws(() => patchLegacyStickyPortal(actual + '\nfunction ensureStickyClose(){}', true), /compatible template/);
});
test('external CSS separates portal appearance from desktop and mobile in-host position', () => {
  const input = '#Sticky #close_sticky_ad,\nbody > #close_sticky_ad {position:absolute!important;top:6px!important;}\n@media(max-width:767px){#Sticky #close_sticky_ad, body > #close_sticky_ad {top:-8px!important;}}';
  const output = patchLegacyStickyPortalCss(input, true);
  assert.equal(patchLegacyStickyPortalCss(output, true), output);
  assert(output.includes('#Sticky #close_sticky_ad {position:absolute!important;top:6px!important;}'));
  const portal = output.slice(output.indexOf('/* Tessera legacy portal appearance:'));
  assert(!/\b(position|top|right|bottom|left)\s*:/.test(portal));
  assert(portal.includes('z-index: 2147483647 !important;'));
});
