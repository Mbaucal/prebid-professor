import {parse} from 'acorn';
import {compileRuntime3161} from '../runtime-3161/compiler.mjs';
export {idempotentStickyStyles} from '../runtime-3161/compiler.mjs';

function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Tessera 3.16.2 insertion point changed: ' + before);
  return source.replace(before, () => after);
}

/** A new, explicit patch release layered over the frozen 3.16.1 output.
 * 3.16.1 stores the remaining interval/wall-clock gap when tryRefresh refuses a
 * request, but only the Sticky timer and content dwell timers read it. The
 * empty-Sticky retry timer did not: a refused retry was the last scheduled work,
 * so an empty Sticky with a larger gap than its retry delay never ran again.
 * This release defers that refused retry step to the exact remaining gap
 * through the existing pausable empty-retry timer. The gap is measured with
 * Date.now() while timers run on their own clock, so a deferred step that is
 * still refused (the wall clock stepped back) is deferred again, at most three
 * times per retry step and only while no request was dispatched or sent in
 * between. Every existing gate (closed, page visibility, cap, consent/readiness
 * dispatch, view and gap rules) is still evaluated by tryRefresh when the
 * deferred step runs.
 * Before 3.16.2 is frozen it also applies the script's inherited minimum
 * in-view percentage at refresh time when a position saves none (R3-01), and
 * the content dwell timer counts a still-pending queued refresh when it picks
 * the next schedule step (R3-09).
 */
export function compileRuntime3162(input) {
  const result = compileRuntime3161(input);
  let source = result.adsJs;

  // A stored gap describes only the latest tryRefresh decision for that slot.
  // Consumers read it right after their own call, so a value left by another
  // caller (for example a content guard retry) can no longer delay a later one.
  source = once(source, '  function tryRefresh(id, slot, minGapSec){\n',
    '  function tryRefresh(id, slot, minGapSec){\n  if(_slotState[id])_slotState[id].gapRemainingMs=null;\n');

  // Arming a retry replaces any parked step; pause/resume keeps its own value.
  source = once(source, '_sticky.emptyNextAt = now() + d;', '_sticky.emptyRemainingMs = null;\n  _sticky.emptyNextAt = now() + d;');

  // A due retry on an inactive page waits for the next resume instead of being
  // dropped; a gap refusal is deferred to the exact allowed time.
  source = once(source, `    if (!pageActive()) return;

    log('[STICKY] empty-retry after', d,'ms');
    tryRefresh(STICKY_TARGET_ID, slot, 0);
  }, d);`, `    if (!pageActive()) { _sticky.emptyRemainingMs = 1; return; }

    log('[STICKY] empty-retry after', d,'ms');
    tryRefresh(STICKY_TARGET_ID, slot, 0);
    tesseraDeferStickyEmptyRetry();
  }, d);`);
  source = once(source, 'function scheduleStickyEmptyRetry(){', `function tesseraDeferStickyEmptyRetry(){
  var state=_slotState[STICKY_TARGET_ID],gap=state&&state.gapRemainingMs;
  if(state)state.gapRemainingMs=null;
  if(gap==null||!(gap>0)||_sticky.closed)return;
  var mark=String(_tesseraLastRefreshSentAt[STICKY_TARGET_ID])+'/'+String(_lastRefreshAt[STICKY_TARGET_ID]);
  var n=_sticky.emptyGapDeferrals||0;
  if(n&&(n>=3||_sticky.emptyGapMark!==mark))return;
  _sticky.emptyGapDeferrals=n+1;
  _sticky.emptyGapMark=mark;
  log('[STICKY] empty-retry deferred by gap', gap,'ms');
  scheduleStickyEmptyRetryDelay(Math.max(1,Math.ceil(gap)));
}
function scheduleStickyEmptyRetry(){`);
  source = once(source, '  _sticky.retryIdx = idx+1;', '  _sticky.retryIdx = idx+1;\n  _sticky.emptyGapDeferrals = 0;');

  // A pause can run after the retry fell due but before its timer task did.
  // Park that step for 1 ms, like the hidden-page case, instead of dropping it.
  source = once(source, 'if(_sticky.emptyNextAt){ _sticky.emptyRemainingMs = Math.max(0, _sticky.emptyNextAt - now()); }',
    'if(_sticky.emptyNextAt){ _sticky.emptyRemainingMs = Math.max(1, _sticky.emptyNextAt - now()); }');

  // R3-01: a refresh rule without minViewPct resolves to the script's inherited
  // threshold REFRESH_IN_VIEW_PCT (Default refresh, else ATF refresh, else 50%)
  // instead of 0, so the refresh-time view check applies it. Any saved value,
  // including an explicit 0, is kept. Dwell entry reads the same value, which
  // equals the device threshold it fell back to before (an inherited 0 still
  // falls back to it), so view entry and exit are unchanged.
  if (source.split('\n  var REFRESH_IN_VIEW_PCT = ').length !== 2) throw Error('Tessera 3.16.2 insertion point changed: REFRESH_IN_VIEW_PCT');
  source = once(source, '    minViewPct: Number(refresh.minViewPct == null ? 0 : refresh.minViewPct),',
    '    minViewPct: Number(refresh.minViewPct == null ? REFRESH_IN_VIEW_PCT : refresh.minViewPct),');

  // R3-09: 3.16.1 counts a refresh when GPT actually sends it, after the batch
  // window, so the dwell timer chose the next schedule step with the old count.
  // tryRefresh now reports the one path that queued a request; while that exact
  // request is still pending it is the next completed step (one step at most,
  // no time comparison). Counting, caps, rollback and the gap check are
  // unchanged, so a send slower than the next step still waits as in 3.16.1.
  source = once(source, '      enqueueRefresh(id, slot);\n    }\n  }\n\n  function setupAutoRefresh(){',
    '      enqueueRefresh(id, slot);\n    }\n    return true;\n  }\n\n  function setupAutoRefresh(){');
  source = once(source, 'function getAdUnitRefreshRule(code){', 'function getAdUnitRefreshRule(code,pendingSteps){');
  source = once(source, '  var completed = (_refreshCounts && _refreshCounts[code]) || 0;',
    '  var completed = ((_refreshCounts && _refreshCounts[code]) || 0) + (pendingSteps > 0 ? pendingSteps : 0);');
  source = once(source, 'tryRefresh(id, slot, minSecNow);', 'var tesseraQueued = tryRefresh(id, slot, minSecNow) === true;');
  source = once(source, 'var rrNext = getAdUnitRefreshRule(id);',
    'var rrNext = getAdUnitRefreshRule(id, tesseraQueued && _tesseraRefreshPending[id] === slot ? 1 : 0);');

  parse(source, {ecmaVersion:2015});
  return {...result, adsJs:source, adsMinJs:source, patches:[...result.patches,
    '3.16.2: an empty Sticky retry refused by the refresh gap is deferred to the remaining allowed time (at most three times per step, only while nothing was dispatched)',
    '3.16.2: a due empty Sticky retry on an inactive or pausing page resumes with the page; stale gap values are not reused',
    '3.16.2: a position without its own saved minimum in-view percentage uses the script\'s inherited threshold at refresh time (50% unless the Default or, without a Default refresh, the ATF refresh saves another value); saved values, including 0, and view entry/exit are unchanged',
    '3.16.2: the content dwell timer counts a still-pending queued refresh when it picks the next schedule step, restoring the 3.16.0 request times when that request is sent within the next step; with very short steps and slower sends it waits as 3.16.1 did; no request is made before the interval the actual count allows, and counters still advance only on actual requests']};
}
