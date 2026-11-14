import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {previewInput as previewInput3212} from '../worker/runtime-3212/snapshot.mjs';
import {compileRuntime3212} from '../worker/runtime-3212/compiler.mjs';
import {descriptor as descriptor3212} from '../.generated/runtime-3212-manifest.mjs';
import {previewInput as previewInput3210} from '../worker/runtime-321/snapshot.mjs';
import {compileRuntime321} from '../worker/runtime-321/compiler.mjs';
import {descriptor as descriptor3210} from '../.generated/runtime-321-manifest.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {configure} from '../tests/runtime/artifact-fixture.mjs';

// 3.21.2 boot programs for scripts/verify-boot3212-browser.py, plus production 3.21.0
// programs from the same saved settings as the page-targeting reference.
const output = new URL('../.generated/boot3212-browser/', import.meta.url);
await mkdir(output, {recursive: true});
const runtimes = [
  {version: '3.21.2', descriptor: descriptor3212, input: previewInput3212, compile: compileRuntime3212},
  {version: '3.21.0', descriptor: descriptor3210, input: previewInput3210, compile: compileRuntime321},
];
const files = {};
for (const runtime of runtimes) for (const prebid of [false, true]) for (const frequency of [5, 30]) {
  const snapshot = configure(positionFixture(prebid), config => {
    config.runtimeControls.adPositions.Overlay.frequencyMinutes = frequency;
  });
  const input = runtime.input(snapshot, runtime.descriptor, '20261113_000000');
  const result = await finalizeJavaScript(runtime.compile(input).adsJs);
  for (const [extension, source] of [['.js', result.adsJs], ['.min.js', result.adsMinJs]]) {
    if (!source.includes(`"tessera-${runtime.version}"`)) throw Error(`Expected a ${runtime.version} generated program`);
    if (source.includes('tesseraBootRelease') !== (runtime.version === '3.21.2')) throw Error(`Unexpected boot code in ${runtime.version}`);
    const name = `${runtime.version}-${prebid ? 'prebid' : 'gam'}-${frequency}${extension}`;
    await writeFile(new URL(name, output), source);
    files[name] = createHash('sha256').update(source).digest('hex');
  }
}
await writeFile(new URL('manifest.json', output), JSON.stringify({descriptors: runtimes.map(runtime => runtime.descriptor), files}, null, 2) + '\n');
console.log(`Prepared ${Object.keys(files).length} generated programs (3.21.2 and the 3.21.0 reference) for the 3.21.2 boot browser check.`);
