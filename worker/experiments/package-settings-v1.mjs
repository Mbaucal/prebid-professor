// Shared editor/compiler contract. No implicit coercion, hidden clamp or live writes.
export const DEFAULT_PACKAGE_SETTINGS = Object.freeze({
  schemaVersion: 1,
  trafficBPercent: 50,
  arms: Object.freeze({
    A: Object.freeze({ mode: 'fresh-only', refreshSeconds: null }),
    B: Object.freeze({ mode: 'auction-with-cache', refreshSeconds: null, maxBidAgeSeconds: 60 }),
  }),
});

function keys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== expected.slice().sort().join(',')) {
    throw Error(`${label}: unsupported or missing settings.`);
  }
}
function integer(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw Error(`${label}: enter a whole number from ${min} to ${max}.`);
  }
  return value;
}
export function validatePackageSettings(input) {
  keys(input, ['schemaVersion', 'trafficBPercent', 'arms'], 'A/B package');
  if (input.schemaVersion !== 1) throw Error('Unsupported A/B settings version.');
  const trafficBPercent = integer(input.trafficBPercent, 0, 100, 'B traffic percentage');
  keys(input.arms, ['A', 'B'], 'Variants');
  const arms = {};
  for (const variant of ['A', 'B']) {
    const value = input.arms[variant];
    if (!['fresh-only', 'auction-with-cache'].includes(value?.mode)) throw Error(`${variant}: unsupported auction mode.`);
    const cached = value.mode === 'auction-with-cache';
    keys(value, ['mode', 'refreshSeconds', ...(cached ? ['maxBidAgeSeconds'] : [])], variant);
    arms[variant] = Object.freeze({
      mode: value.mode,
      // null explicitly preserves the reviewed per-position schedules.
      refreshSeconds: value.refreshSeconds === null ? null : integer(value.refreshSeconds, 1, 7200, `${variant} refresh seconds`),
      ...(cached ? {maxBidAgeSeconds: integer(value.maxBidAgeSeconds, 1, 300, `${variant} maximum bid age`)} : {}),
    });
  }
  return Object.freeze({schemaVersion: 1, trafficBPercent, arms: Object.freeze(arms)});
}
