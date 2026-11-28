// Synthetic per-position browser fixture only. The frozen legacy runtime has a
// 1500 ms non-Sticky GPT guard and a callback failsafe 500 ms after its longest
// 1500 ms auction timeout. Keep one additional 500 ms of scheduling margin.
// Production settings and previously saved packages do not read this module.
export const positionCacheFixtureTiming = Object.freeze({
  gptGuardMs: 1500,
  maximumAuctionTimeoutMs: 1500,
  callbackFailsafeMs: 500,
  schedulingMarginMs: 500,
});

export const positionCacheFixtureRefreshSeconds = Math.ceil(
  Object.values(positionCacheFixtureTiming).reduce((total, value) => total + value, 0) / 1000,
);
