/** Build pinned upstream Prebid.js with the vendored Tanjug 11.34.0 module list, for the
 * 3.23.0 bid cache browser check on other Prebid versions. No ad traffic; nothing deployed.
 *
 * node scripts/build-bidcache-prebid.mjs --version 11.11.0
 * Writes .generated/bidcache-prebid/<version>/{prebid.js,prebid-config.json,manifest.json}
 * (BIDCACHE_PREBID_ROOT overrides the folder). prebid.js and prebid-config.json have the
 * layout scripts/prepare-bidcache323-browser.mjs --prebid expects. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.BIDCACHE_PREBID_ROOT || resolve(root, '.generated/bidcache-prebid'));
// The same pinned upstream sources as scripts/verify-contextual-prebid-build.mjs.
const pins = {
  '11.11.0': {commit: '0f6ba177203d5f63e0a11453ed0c887fcf5efe33', lockSha256: '8207a5e5551ec1d02125276b412e1cb18db5ff305c2babbb8c68fc361b109b7b'},
  '11.34.0': {commit: '195e0c6069928ed906bde550cb4e4183d1dc8474', lockSha256: '077338389169c8834d5bd1dedacd92094fb3b0e05a1c54fb4de7ffaa4b7d02d9'},
};
const args = process.argv.slice(2);
assert(args.length === 2 && args[0] === '--version' && pins[args[1]], `Usage: node scripts/build-bidcache-prebid.mjs --version ${Object.keys(pins).join('|')}`);
const version = args[1], pin = pins[version];
const {modules} = JSON.parse(await readFile(resolve(root, 'vendor/prebid/tanjug-11.34.0/prebid-config.json'), 'utf8'));
assert(Array.isArray(modules) && modules.includes('consentManagementTcf') && modules.includes('tcfControl'), 'Vendored module list expected');
const sha256 = value => createHash('sha256').update(value).digest('hex');
function run(command, argv, cwd, capture = false) {
  const result = spawnSync(command, argv, {cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit',
    env: {...process.env, PUPPETEER_SKIP_DOWNLOAD: 'true'}});
  assert.equal(result.status, 0, `${command} ${argv.join(' ')} failed: ${result.stderr || result.error || ''}`);
  return (result.stdout || '').trim();
}
const upstream = resolve(output, `upstream-${version}`);
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
run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], upstream);
run('npx', ['--no-install', 'gulp', 'build', `--modules=${modules.join(',')}`], upstream);
assert.equal(sha256(await readFile(lockPath)), pin.lockSha256, 'Build changed the locked dependencies');
assert.equal(run('git', ['status', '--porcelain', '--untracked-files=no'], upstream, true), '', 'Build changed upstream tracked sources');
const build = await readFile(resolve(upstream, 'build/dist/prebid.js'));
assert(build.includes(Buffer.from(`"v${version}"`)), `Built file is not Prebid.js ${version}`);
const destination = resolve(output, version);
await mkdir(destination, {recursive: true});
await writeFile(resolve(destination, 'prebid.js'), build);
await writeFile(resolve(destination, 'prebid-config.json'), JSON.stringify({version, modules}, null, 2) + '\n');
const manifest = {schemaVersion: 1, prebidVersion: version, sourceRepository: 'https://github.com/prebid/Prebid.js',
  sourceCommit: pin.commit, upstreamLockSha256: pin.lockSha256, modules, nodeVersion: process.version,
  npmVersion: run('npm', ['--version'], upstream, true), buildSha256: sha256(build),
  scope: 'Pinned upstream build with the vendored Tanjug 11.34.0 module list, for the 3.23.0 bid cache browser check only.'};
await writeFile(resolve(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`BUILT Prebid ${version} for the bid cache check: ${manifest.buildSha256}`);
