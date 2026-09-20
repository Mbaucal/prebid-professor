import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {buildConfigurableABPackage} from './configurable-ab-package.mjs';
import {DEFAULT_PACKAGE_SETTINGS} from '../worker/experiments/package-settings-v1.mjs';

const settings = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : DEFAULT_PACKAGE_SETTINGS;
const result = await buildConfigurableABPackage({
  base: readFileSync('.generated/tanjug-pilot/ads.js'),
  previousArchive: readFileSync('.generated/tanjug-cmp/tanjug-aa-1.0.2.zip'), settings,
});
const root = `.generated/configurable-ab/${result.release}/`;
function put(path, bytes) {
  const target = root + path;
  mkdirSync(target.slice(0, target.lastIndexOf('/')), {recursive: true});
  const content = Buffer.from(bytes);
  if (existsSync(target)) assert.deepEqual(readFileSync(target), content, 'Refusing to replace an existing release.');
  else writeFileSync(target, content, {flag: 'wx'});
}
for (const [name, bytes] of Object.entries(result.files)) put('deploy/' + name, bytes);
put(result.release + '.zip', result.archive);
put('release.json', JSON.stringify(result.manifest, null, 2) + '\n');
console.log(JSON.stringify({release: result.release, directory: root, sha256: result.archiveSha256,
  bytes: result.archive.length, settings: result.manifest.settings}));
