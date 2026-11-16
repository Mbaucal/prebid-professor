/** Build pinned upstream Prebid + the canonical contextual RTD bridge. No ad traffic. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.CONTEXTUAL_PREBID_ROOT || resolve(root, '.generated/contextual-prebid'));
const runtimeRoot = resolve(process.env.CONTEXTUAL_RUNTIME_ROOT || root);
const pins = {
  '11.11.0': {commit: '0f6ba177203d5f63e0a11453ed0c887fcf5efe33', lockSha256: '8207a5e5551ec1d02125276b412e1cb18db5ff305c2babbb8c68fc361b109b7b'},
  '11.34.0': {commit: '195e0c6069928ed906bde550cb4e4183d1dc8474', lockSha256: '077338389169c8834d5bd1dedacd92094fb3b0e05a1c54fb4de7ffaa4b7d02d9'},
};
const modules = ['rtdModule', 'contextualSignalsRtdProvider', 'contextualAuditRtdProvider', 'consentManagementTcf', 'allowActivities', 'connectadBidAdapter', 'openxBidAdapter',
  'pubmaticBidAdapter', 'ixBidAdapter', 'rubiconBidAdapter', 'teadsBidAdapter', 'richaudienceBidAdapter'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
assert(args.length === 0 || args.length === 2 && args[0] === '--version', 'Usage: node scripts/verify-contextual-prebid-build.mjs [--version 11.11.0|11.34.0]');
const versions = args.length ? [args[1]] : Object.keys(pins);
versions.forEach(version => assert(pins[version], `Unpinned version: ${version}`));
function run(command, argv, cwd, capture = false) {
  const result = spawnSync(command, argv, {cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    env: {...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true'}});
  assert.equal(result.status, 0, `${command} ${argv.join(' ')} failed: ${result.stderr || result.error || ''}`);
  return (result.stdout || '').trim();
}
const modulePath = resolve(runtimeRoot, 'worker/runtime-321/prebid-module.mjs');
const runtimePath = resolve(runtimeRoot, 'worker/runtime-3211/browser-contextual.mjs');
const auditModule = await readFile(resolve(root, 'tests/contextual-native/audit-rtd-provider.js'), 'utf8');
const moduleSourceHash = sha256(await readFile(modulePath));
const runtimeSourceHash = sha256(await readFile(runtimePath));
const {PREBID_CONTEXTUAL_MODULE_SOURCE: moduleSource} = await import(pathToFileURL(modulePath));
const {createContextualSignals} = await import(pathToFileURL(runtimePath));
assert.equal(typeof moduleSource, 'string');
assert.equal(typeof createContextualSignals, 'function');
await mkdir(output, {recursive: true});
for (const version of versions) {
  const pin = pins[version], upstream = resolve(output, `upstream-${version}`);
  if (!existsSync(resolve(upstream, '.git'))) {
    await mkdir(upstream, {recursive: true});
    run('git', ['init'], upstream);
    run('git', ['remote', 'add', 'origin', 'https://github.com/prebid/Prebid.js.git'], upstream);
    run('git', ['fetch', '--depth=1', 'origin', pin.commit], upstream);
    run('git', ['checkout', '--detach', 'FETCH_HEAD'], upstream);
  }
  assert.equal(run('git', ['rev-parse', 'HEAD'], upstream, true), pin.commit, 'Wrong upstream checkout; use an empty output directory or the pinned checkout');
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], upstream, true), '', 'Upstream tracked files were modified');
  const lockPath = resolve(upstream, 'package-lock.json');
  assert.equal(sha256(await readFile(lockPath)), pin.lockSha256, 'Upstream lockfile differs from the pinned source');
  assert.equal(JSON.parse(await readFile(resolve(upstream, 'package.json'), 'utf8')).version, version);
  const customModule = resolve(upstream, 'modules/contextualSignalsRtdProvider.js');
  assert.equal(run('git', ['ls-files', 'modules/contextualSignalsRtdProvider.js'], upstream, true), '', 'Refusing to overwrite an upstream module');
  await writeFile(customModule, moduleSource);
  assert.equal(run('git', ['ls-files', 'modules/contextualAuditRtdProvider.js'], upstream, true), '', 'Refusing to overwrite an upstream audit module');
  await writeFile(resolve(upstream, 'modules/contextualAuditRtdProvider.js'), auditModule);
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], upstream);
  run('npx', ['--no-install', 'gulp', 'build', `--modules=${modules.join(',')}`], upstream);
  assert.equal(sha256(await readFile(lockPath)), pin.lockSha256, 'Build changed the locked dependencies');
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], upstream, true), '', 'Build changed upstream tracked sources');
  const build = await readFile(resolve(upstream, 'build/dist/prebid.js'));
  assert(build.includes(Buffer.from('contextualSignals')), 'Custom provider missing from the build');
  const destination = resolve(output, version);
  await mkdir(destination, {recursive: true});
  const buildPath = resolve(destination, 'prebid.js');
  await writeFile(buildPath, build);
  const missingProviderModules = modules.filter(name => name !== 'contextualSignalsRtdProvider');
  run('npx', ['--no-install', 'gulp', 'build', `--modules=${missingProviderModules.join(',')}`], upstream);
  assert.equal(sha256(await readFile(lockPath)), pin.lockSha256, 'Missing-provider build changed the locked dependencies');
  assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], upstream, true), '', 'Missing-provider build changed upstream tracked sources');
  const missingProviderPath = resolve(destination, 'prebid-without-contextual.js');
  const missingProviderBuild = await readFile(resolve(upstream, 'build/dist/prebid.js'));
  await writeFile(missingProviderPath, missingProviderBuild);
  const browserRuntime = `window.createContextualSignals = ${createContextualSignals.toString()};\n`;
  const browserRuntimePath = resolve(destination, 'browser-contextual.js');
  await writeFile(browserRuntimePath, browserRuntime);
  assert.equal(sha256(await readFile(modulePath)), moduleSourceHash, 'Provider source changed during build; rerun against stable sources');
  assert.equal(sha256(await readFile(runtimePath)), runtimeSourceHash, 'Runtime source changed during build; rerun against stable sources');
  const manifest = {schemaVersion: 1, prebidVersion: version, sourceRepository: 'https://github.com/prebid/Prebid.js',
    sourceCommit: pin.commit, upstreamLockSha256: pin.lockSha256, modules, nodeVersion: process.version,
    npmVersion: run('npm', ['--version'], upstream, true), buildPath, buildSha256: sha256(build),
    moduleSourcePath: modulePath, moduleSourceSha256: moduleSourceHash,
    moduleContentSha256: sha256(moduleSource), runtimeSourcePath: runtimePath,
    runtimeVersion: '3.21.1', auditModuleSha256: sha256(auditModule),
    missingProviderPath, missingProviderSha256: sha256(missingProviderBuild),
    runtimeSourceSha256: runtimeSourceHash, browserRuntimePath, browserRuntimeSha256: sha256(browserRuntime),
    scope: 'Pinned upstream build with unchanged adapters and the canonical contextual RTD module. Build success is not wire or SSP acceptance evidence.'};
  await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`BUILT Prebid ${version}: ${manifest.buildSha256}`);
}
