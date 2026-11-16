/** Re-run the accepted map/boot behavioral regressions against the new compiler. */
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = resolve(process.env.ACCOUNTS_RUNTIME_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const output = resolve(dirname(fileURLToPath(import.meta.url)), '../.generated/review-mba412-composition');
await mkdir(output, {recursive: true});
const cases = [
  {name: 'maps', file: 'audit-size-map-selection.test.mjs', old: '3211'},
  {name: 'boot', file: 'boot3212.test.mjs', old: '3212', pattern: 'WIRE-F1|active TakeOver|capped and viewport|CRIT-1|decision flip|decision before boot|slots defined by|container inserted|decision defines no slots|BL-1|geo-dependent|ineligible TakeOver|failing cap|slot removed|script in head'},
];
for (const test of cases) {
  const original = resolve(root, 'tests/runtime', test.file);
  let source = await readFile(original, 'utf8');
  assert(source.includes(`{compileRuntime${test.old}}`), 'Source compiler import changed; review the harness');
  source = source.replace(`{compileRuntime${test.old}}`, `{compileRuntime3221 as compileRuntime${test.old}}`)
    .replace(`runtime-${test.old}/compiler.mjs`, 'runtime-3221/compiler.mjs')
    .replace(`runtime-${test.old}/snapshot.mjs`, 'runtime-3221/snapshot.mjs');
  source = source.replace(/from '([^']+)'/g, (whole, name) => name.startsWith('.')
    ? `from '${pathToFileURL(resolve(dirname(original), name)).href}'` : whole);
  const path = resolve(output, `${test.name}.test.mjs`);
  await writeFile(path, source);
  const result = spawnSync(process.execPath, ['--test', ...(test.pattern ? [`--test-name-pattern=${test.pattern}`] : []), path], {stdio: 'inherit'});
  assert.equal(result.status, 0, `3.22.1 ${test.name} regression failed`);
}
