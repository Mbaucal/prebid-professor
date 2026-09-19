import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {cacheArm, fullCacheLoader, CACHE_RELEASE} from './full-cache-v2.mjs';
import {validatePackageSettings} from './package-settings-v1.mjs';

const once = (source, marker, replacement) => {
  assert.equal(source.split(marker).length, 2, 'Review changed runtime marker: ' + marker);
  return source.replace(marker, replacement);
};

/** New compiler profile; all accepted fixed profiles remain byte-for-byte frozen. */
export function configuredCacheArm(source, variant, input, release) {
  const settings = validatePackageSettings(input);
  assert(['A', 'B'].includes(variant));
  assert.match(release, /^tanjug-ab-2\.0\.0-[a-f0-9]{64}$/);
  const arm = settings.arms[variant];
  let output = cacheArm(source, arm.mode === 'auction-with-cache' ? 'B' : 'A').replaceAll(CACHE_RELEASE, release);
  if (arm.mode === 'auction-with-cache') {
    output = once(output, "mode:'auction-with-cache',maxAgeSeconds:60,",
      `mode:'auction-with-cache',maxAgeSeconds:${arm.maxBidAgeSeconds},`);
  }
  if (arm.refreshSeconds !== null) {
    // Align sticky, mobile and dwell timers with the rule used at refresh time.
    // Disabled/excluded slots, viewability, activity and count limits stay intact.
    for (const name of ['STICKY_TOP_REFRESH_SEC', 'STICKY_REFRESH_SEC', 'DWELL_MIN_VIEW_SEC',
      'MIN_SECONDS_BETWEEN_REFRESHES', 'MOBILE_MIN_SECONDS_BETWEEN_REFRESHES']) {
      output = once(output, `var ${name} = 30;`, `var ${name} = ${arm.refreshSeconds};`);
    }
    const marker = '        var completed = _refreshCounts && _refreshCounts[code] || 0;';
    output = once(output, marker, `        refresh = Object.assign({}, refresh, {
            minSeconds: ${arm.refreshSeconds}, minGapSeconds: ${arm.refreshSeconds},
            schedule: {mode: 'fixed', fixedSeconds: ${arm.refreshSeconds}}
        });
        schedule = refresh.schedule;
${marker}`);
  }
  parse(output, {ecmaVersion: 'latest'});
  return output;
}

export function configuredCacheLoader(config) {
  const settings = validatePackageSettings(config.settings);
  assert.match(config.release, /^tanjug-ab-2\.0\.0-[a-f0-9]{64}$/);
  let output = fullCacheLoader({...config, settings, release: CACHE_RELEASE}).replaceAll(CACHE_RELEASE, config.release);
  output = once(output, "sample[0]<2147483648?'A':'B'",
    `sample[0]<${4294967296 * (100 - settings.trafficBPercent) / 100}?'A':'B'`);
  output = once(output, "mode:assigned==='B'?'auction-with-cache':'fresh-only'",
    "mode:assigned?config.settings.arms[assigned].mode:null,trafficBPercent:config.settings.trafficBPercent,refreshSeconds:assigned?config.settings.arms[assigned].refreshSeconds:null,maxBidAgeSeconds:assigned?config.settings.arms[assigned].maxBidAgeSeconds||null:null");
  parse(output, {ecmaVersion: 'latest'});
  return output;
}
