import {mkdir, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {previewInput} from '../worker/runtime-3212/snapshot.mjs';
import {compileRuntime3212} from '../worker/runtime-3212/compiler.mjs';
import {finalizeJavaScript} from '../worker/runtime/artifact-minifier.mjs';
import {descriptor} from '../.generated/runtime-3212-manifest.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';
import {configure} from '../tests/runtime/artifact-fixture.mjs';

// Same eight programs as prepare-storage3211-browser.mjs, from the registered 3.21.2
// source, for scripts/verify-storage3211-browser.py .generated/storage3212-browser.
const output = new URL('../.generated/storage3212-browser/', import.meta.url);
await mkdir(output, {recursive: true});
const files = {};
for (const prebid of [false, true]) for (const frequency of [0, 5]) {
  const snapshot = configure(positionFixture(prebid), config => {
    config.runtimeControls.adPositions.Overlay.frequencyMinutes = frequency;
  });
  const input = previewInput(snapshot, descriptor, '20261113_000000');
  const result = await finalizeJavaScript(compileRuntime3212(input).adsJs);
  for (const [extension, source] of [['.js', result.adsJs], ['.min.js', result.adsMinJs]]) {
    if (!source.includes('"tessera-3.21.2"')) throw Error('Expected a 3.21.2 generated program: ' + extension);
    if (frequency > 0 && !source.includes('tesseraBootRelease')) throw Error('Expected the 3.21.2 interval boot: ' + extension);
    const name = (prebid ? 'prebid' : 'gam') + '-' + frequency + extension;
    await writeFile(new URL(name, output), source);
    files[name] = createHash('sha256').update(source).digest('hex');
  }
}
await writeFile(new URL('manifest.json', output), JSON.stringify({descriptor, files}, null, 2) + '\n');
console.log('Prepared eight 3.21.2 generated programs for the storage/CMP browser lab.');
