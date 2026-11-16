import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { assertGeneratedBundleStandalone } from '../../worker/test-workspace/bundle-syntax-guard.mjs';

const encode = source => new TextEncoder().encode(source);
const candidate = source => ({ files: { 'ads.js': encode(source), 'ads.min.js': encode(source) } });

test('Worker function-name preservation introduces the reported dependency inside serialized functions', async () => {
  const compile = async keepNames => {
    const result = await build({ entryPoints: [new URL('../../worker/runtime-next/browser-functions.mjs', import.meta.url).pathname], bundle: true, write: false, keepNames, platform: 'neutral', format: 'cjs' });
    const target = { exports: {} };
    Function('module', 'exports', result.outputFiles[0].text)(target, target.exports);
    return ['tesseraWireConfiguredLazy', 'tesseraRequestOverlay'].map(name => target.exports[name].toString()).join('\n');
  };
  const broken = await compile(true), valid = await compile(false);
  assert.match(broken, /__name\(/);
  assert.throws(() => assertGeneratedBundleStandalone(candidate(broken)), /standalone file/);
  const artifact = candidate(valid);
  assert.strictEqual(assertGeneratedBundleStandalone(artifact), artifact);
});

test('the guard checks both outputs and does not reject text in settings or comments', () => {
  const artifact = candidate('/* __name(fake) */ var partner = "__name(value)";');
  const before = artifact.files['ads.js'].slice();
  assert.strictEqual(assertGeneratedBundleStandalone(artifact), artifact);
  assert.deepEqual(artifact.files['ads.js'], before);
  artifact.files['ads.min.js'] = encode('function lazy(){__name(render,"render");}');
  assert.throws(() => assertGeneratedBundleStandalone(artifact), /3\.13\.0 or newer/);
});

test('an incomplete artifact is rejected before storage', () => {
  assert.throws(() => assertGeneratedBundleStandalone({files: { 'ads.js': encode('void 0;') }}), /missing/);
});
