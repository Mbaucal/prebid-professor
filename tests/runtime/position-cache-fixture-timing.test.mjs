import assert from 'node:assert/strict';
import test from 'node:test';
import {positionCacheFixtureTiming, positionCacheFixtureRefreshSeconds} from '../../scripts/position-cache-fixture-timing.mjs';

// An auction interval measures starts; GPT's legacy guard measures submissions.
// Use an independent clock trace, including the observed slow round 3 / fast
// round 4 transition. Missing rounds must remain visible to the real verifier.
function submittedRounds(intervalMs, callbackDelaysMs) {
  const submitted = [];
  let previous = -Infinity;
  for (let index = 0; index < callbackDelaysMs.length; index++) {
    const now = index * intervalMs + callbackDelaysMs[index];
    if (now - previous >= 1500) {
      submitted.push(index + 1);
      previous = now;
    }
  }
  return submitted;
}

test('old two-second fixture loses round 4 after a 700 ms round 3 response', () => {
  assert.deepEqual(submittedRounds(2000, [0, 0, 700, 0, 0]), [1, 2, 3, 5]);
});

test('position fixture preserves every round through the same latency transition', () => {
  assert.equal(positionCacheFixtureRefreshSeconds, 4);
  assert.deepEqual(submittedRounds(positionCacheFixtureRefreshSeconds * 1000, [0, 0, 700, 0, 0]), [1, 2, 3, 4, 5]);
});

test('fixture covers the full frozen callback bound and keeps the existing 45-second wait', () => {
  const intervalMs = positionCacheFixtureRefreshSeconds * 1000;
  const latestCallbackMs = 1500 + 500;
  assert.deepEqual(positionCacheFixtureTiming, {
    gptGuardMs: 1500, maximumAuctionTimeoutMs: 1500,
    callbackFailsafeMs: 500, schedulingMarginMs: 500,
  });
  assert.equal(intervalMs - latestCallbackMs - 1500, 500);
  assert.deepEqual(submittedRounds(intervalMs, [0, 0, latestCallbackMs, 0, 0]), [1, 2, 3, 4, 5]);
  assert(4 * intervalMs + latestCallbackMs < 45000);
});
