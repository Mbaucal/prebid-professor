import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parse} from 'acorn';
import {createHash} from 'node:crypto';
import {runtimeReleaseHistory, assertRuntimeReleaseSource} from '../worker/runtime/runtime-release-history.mjs';
import {MODULE_SHA256, sourceFiles as previousSourceFiles} from './prepare-runtime319.mjs';
export {MODULE_SHA256};
export const sourceFiles = [...previousSourceFiles,
  'worker/runtime-320/size-maps.mjs', 'worker/runtime-320/snapshot.mjs',
  'worker/runtime-320/browser-functions.mjs', 'worker/runtime-320/compiler.mjs',
  'worker/runtime-320/artifact-candidate.mjs', 'worker/runtime-320/settings-guard.mjs',
  'scripts/prepare-runtime320.mjs'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function runtime320Source(root) {
  const components = [{path: 'reference391.mjs', sha256: MODULE_SHA256}];
  for (const path of sourceFiles) components.push({path, sha256: hash(await readFile(resolve(root, path)))});
  components.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return {codeSha256: hash(JSON.stringify(components)), components};
}
export async function prepareRuntime320(root) {
  const {codeSha256, components} = await runtime320Source(root);
  const release = runtimeReleaseHistory.find(row => row.id === 'tessera-3.20.0' && row.version === '3.20.0');
  if (!release) throw Error('Register Tessera 3.20.0 before building.');
  assertRuntimeReleaseSource(codeSha256, release);
  const {id, version, configSchemaVersion, channel, capabilities} = release;
  const source = await readFile(resolve(root, 'worker/runtime-320/browser-functions.mjs'), 'utf8'), browserSources = {};
  for (const node of parse(source, {ecmaVersion: 'latest', sourceType: 'module'}).body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'FunctionDeclaration') {
      const fn = node.declaration; browserSources[fn.id.name] = source.slice(fn.start, fn.end);
    }
  }
  await writeFile(resolve(root, '.generated/runtime-320-browser-source.mjs'), `export const browserSources=${JSON.stringify(browserSources)};\n`);
  await writeFile(resolve(root, '.generated/runtime-320-manifest.mjs'),
    `// Generated from verified versioned sources.\nexport const descriptor=${JSON.stringify({id, version, configSchemaVersion, channel, capabilities, codeSha256})};\nexport const sourceComponents=${JSON.stringify(components)};\n`);
}
