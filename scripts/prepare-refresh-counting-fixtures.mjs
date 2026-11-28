import { mkdir, writeFile } from 'node:fs/promises';
import { transform } from '../worker/runtime-3161/refresh-counting.mjs';
import { compileRuntime316 } from '../worker/runtime-316/compiler.mjs';
import { compileRuntime3161 } from '../worker/runtime-3161/compiler.mjs';
import { previewInput as oldInput } from '../worker/runtime-316/snapshot.mjs';
import { previewInput as newInput } from '../worker/runtime-3161/snapshot.mjs';
import { descriptor } from '../.generated/runtime-316-manifest.mjs';
import { positionFixture } from '../tests/support/position-runtime-fixture.mjs';
const out = new URL('../.generated/refresh-counting-evidence/', import.meta.url);
await mkdir(out, { recursive: true });
for (const prebid of [false, true]) {
  for (const name of ['fixed', 'sequence', 'sticky', 'wall-gap', 'sticky-wall-gap']) {
    const snapshot = positionFixture(prebid);
    const c = JSON.parse(snapshot.config.config_json);
    c.runtimeControls.adPositions = {};
    const isSticky = name.startsWith('sticky');
    c.runtimeControls.sticky.bottomAdUnitId = isSticky ? 'Sticky' : '';
    snapshot.config.config_json = JSON.stringify(c);
    snapshot.units = snapshot.units.filter(u => u.code === 'Billboard');
    snapshot.overrides = [];
    if (isSticky) snapshot.units.push({ code: 'Sticky', type: 'ATF', media_type: 'banner', size_map_key: 'display', enabled: 1, sort_order: 1 });
    snapshot.maps = [{ name: 'display', map_json: JSON.stringify([{ viewport: [0, 0], sizes: [] }, { viewport: [1300, 0], sizes: [[300, 250]] }]) }];
    const isWallGap = name.endsWith('wall-gap');
    const refresh = { enabled: true, minSeconds: 30, minViewPct: 50, maxRefreshes: name === 'fixed' || isWallGap ? 3 : 4,
      minGapSeconds: isWallGap ? 100 : 0,
      schedule: name === 'fixed' || isWallGap ? { mode: 'fixed', fixedSeconds: 30 } : { mode: 'sequence', sequenceSeconds: [30, 60, 120, 240] } };
    snapshot.rules = [{ rule_key: '__DEFAULT__', rule_json: JSON.stringify({ timeout: 300, refresh }) }];
    if (isSticky) snapshot.rules.push({ rule_key: 'Billboard', rule_json: JSON.stringify({ refresh: { enabled: false } }) });
    const before = compileRuntime316(oldInput(snapshot, descriptor, '20261024_140000')).adsJs;
    const next = compileRuntime3161(newInput(snapshot, descriptor, '20261024_140000')).adsJs;
    const after = next.includes('var _tesseraRefreshPending = ') ? next : transform(next);
    await writeFile(new URL((prebid ? 'prebid-' : 'gam-') + name + '-before.js', out), before);
    await writeFile(new URL((prebid ? 'prebid-' : 'gam-') + name + '-after.js', out), after);
  }
}
console.log('Prepared actual generated before/after refresh-counter fixtures.');
