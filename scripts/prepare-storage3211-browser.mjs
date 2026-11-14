import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {previewInput} from '../worker/runtime-3211/snapshot.mjs';
import {compileRuntime3211} from '../worker/runtime-3211/compiler.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {descriptor} from '../.generated/runtime-3211-manifest.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {configure} from '../tests/runtime/artifact-fixture.mjs';

const output = new URL('../.generated/storage3211-browser/', import.meta.url);
await mkdir(output, {recursive: true});
const files = {};
for (const prebid of [false, true]) for (const frequency of [0, 5]) {
  const snapshot = configure(positionFixture(prebid), config => {
    config.runtimeControls.adPositions.Overlay.frequencyMinutes = frequency;
  });
  const input = previewInput(snapshot, descriptor, '20261113_000000');
  const result = await finalizeJavaScript(compileRuntime3211(input).adsJs);
  for (const [extension, source] of [['.js', result.adsJs], ['.min.js', result.adsMinJs]]) {
    const name = (prebid ? 'prebid' : 'gam') + '-' + frequency + extension;
    await writeFile(new URL(name, output), source);
    files[name] = createHash('sha256').update(source).digest('hex');
  }
}
await writeFile(new URL('manifest.json', output), JSON.stringify({descriptor, files}, null, 2) + '\n');
console.log('Prepared eight 3.21.1 generated programs for the storage/CMP browser lab.');
