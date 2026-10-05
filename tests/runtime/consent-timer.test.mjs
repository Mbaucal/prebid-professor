import test from 'node:test';
import assert from 'node:assert/strict';
import { patchWrapperConsentTimer } from '../../worker/runtime/consent-timer.mjs';
const wrap = (timeout) => `function resolveConsent(cb, timeoutMs){
  setTimeout(function(){
    finish({p:false, src:'consent:timeout'});
  }, Math.min(${timeout}, 1500));
}
/* ====== PPID iz ID5 ====== */
setTimeout(function(){ unrelated(); }, Math.min(8000, 1500));`;
for (const n of [100, 1500, 8000, 30000]) test(`patches the named fallback for configured CMP value ${n}`, () => {
  const result = patchWrapperConsentTimer(wrap(n));
  assert.match(result, /Number\(timeoutMs \|\| window\.__PP_CONSENT_TIMEOUT \|\| 1500\)/);
  assert.match(result, /setTimeout\(function\(\)\{ unrelated\(\); \}, Math\.min\(8000, 1500\)\);/);
});
test('does not guess an unknown expression', () => assert.throws(() => patchWrapperConsentTimer(wrap('unknownCall()')), /uniquely/));
test('does not patch a different timeout reason', () => assert.throws(() => patchWrapperConsentTimer(wrap(1500).replace("src:'consent:timeout'", "src:'other:timeout'")), /uniquely/));
test('rejects ambiguous resolvers', () => assert.throws(() => patchWrapperConsentTimer(wrap(1500) + wrap(8000)), /uniquely/));
test('rejects an absent resolver boundary', () => assert.throws(() => patchWrapperConsentTimer(wrap(1500).replace('PPID iz ID5', 'changed')), /uniquely/));
test('does not patch the same source twice', () => assert.throws(() => patchWrapperConsentTimer(patchWrapperConsentTimer(wrap(1500))), /uniquely/));
