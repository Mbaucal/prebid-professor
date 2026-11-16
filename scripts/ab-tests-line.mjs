/** TEST line adapter for scripts/verify-ab-tests-workerd.mjs (MBA-416). The verifier is shared by both lines;
 * this file holds what only the TEST line has: the sealed TEST Worker and its seal, the TEST login form, the
 * A/B route, the TEST Generate flow that seeds the saved versions, and how Node reads a saved TEST version.
 * Local only: Miniflare with local D1 and R2, synthetic accounts and a synthetic Prebid file. */
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {readPackage} from '../worker/site-runtime/releases.mjs';

export const LINE = 'test';
export const SITE = 'test-site';
export const AB_BASE = '/test-api/ab-tests';
export const COMPILED = '.generated/test-workspace-active-dry-run/index.js';
// Synthetic Prebid file, as in scripts/verify-workerd-generation-parity.mjs: the header is real, the code is inert.
export const PREBID_FILE = '/* prebid.js v11.11.0\nModules: adfBidAdapter, adformBidAdapter, pubmaticBidAdapter, consentManagementTcf, tcfControl, currency, gptPreAuction, priceFloors, userId, sharedIdSystem, schain */\nwindow.fixtureOnly=true;';
// Every object the TEST Worker may write in this flow: the saved versions and Prebid files of the TEST site, and its A/B tests.
export const OWN_PREFIXES = ['publishers/test-site/', 'site-experiments/v1/test-site/'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** The sealed TEST Worker text, exactly as test-deploy uploads it; refuses anything test-build did not seal. */
export async function sealedWorker(root) {
  const script = await readFile(resolve(root, COMPILED), 'utf8');
  const seal = JSON.parse(await readFile(resolve(root, '.generated/toolchain-evidence/test-build.json'), 'utf8'));
  assert.equal(sha(script), seal.compiled['.generated/test-workspace-active-dry-run'], 'Run test-build first: this is not the sealed TEST Worker.');
  return script;
}

/** Miniflare options of the active TEST configuration with a fresh synthetic login. */
export async function workerConfig(root) {
  const config = JSON.parse(await readFile(resolve(root, 'ops/runtime-test/wrangler.active.jsonc'), 'utf8'));
  const password = randomBytes(24).toString('hex');
  return {origin: config.vars.TEST_PUBLIC_ORIGIN, compatibilityDate: config.compatibility_date, compatibilityFlags: config.compatibility_flags ?? [],
    email: 'tester@example.invalid', password,
    bindings: {...config.vars, TEST_ADMIN_EMAIL: 'tester@example.invalid', TEST_ADMIN_PASSWORD: password, TEST_SESSION_SECRET: randomBytes(48).toString('hex')}};
}

/** Signs in through the TEST login form and returns the session cookie. */
export async function signIn(mf, {origin, email, password}) {
  const login = await mf.dispatchFetch(origin + '/api/auth/login', {method: 'POST', redirect: 'manual', headers: {origin, 'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({email, password}).toString()});
  assert.equal(login.status, 303, 'TEST sign-in failed');
  return login.headers.get('set-cookie').split(';')[0];
}

/** Prepares TEST data and saves three 3.23.0 versions through the TEST Generate flow, all over HTTP:
 * GAM only, Prebid with bid caching off (A) and Prebid with bid caching on (B). Returns their ids. */
export async function seedVersions(s) {
  await s.json('/test-api/setup', {confirm: 'prepare-empty-test-database'});
  const select = async enablePrebid => {
    const state = await s.json('/test-api/site-runtime');
    const runtime = state.runtimes.find(r => r.version === '3.23.0');
    assert(runtime, '3.23.0 must be selectable');
    const body = {action: state.selected ? 'version' : 'setup', revision: state.revision, runtime: runtime.pin, allowPreview: true};
    if (!state.selected) body.enablePrebid = enablePrebid;
    await s.json('/test-api/site-runtime', body);
  };
  const generate = async notes => {
    const state = await s.json('/test-api/site-packages');
    assert.equal(state.ready, true, state.error);
    return (await s.json('/test-api/site-packages', {action: 'generate', notes, revision: state.revision}, 201)).release.id;
  };
  await select(false);
  const gam = await generate('GAM only');
  const upload = await s.call('/test-api/prebid/upload', PREBID_FILE, 'POST', {'content-type': 'application/javascript', 'x-tessera-upload': 'prebid-test-file'});
  const file = await upload.json();
  assert.equal(upload.status, 200, file.error);
  const before = await s.json('/test-api/prebid-settings');
  await s.json('/test-api/prebid-settings', {expectedRevision: before.revision, acknowledge: true,
    draft: {...before.draft, enablePrebid: true, buildId: file.file.id, bidders: [{bidder: 'adform', params: {mid: 123}, enabled: true}]}});
  await select(true);
  const A = await generate('Bid cache off');
  const mode = await s.json('/api/publishers/test-site/prebid-mode');
  await s.json('/api/publishers/test-site/prebid-mode', {enabled: true, revision: mode.revision, bidCache: {enabled: true, maxBidAgeSeconds: 45}}, 200, 'PUT');
  const B = await generate('Bid cache on');
  return {gam, A, B};
}

/** A saved TEST version read in Node from the same local D1 and R2 the Worker uses ({files, release}). */
export function versionReader(storage) {
  return id => readPackage(storage, SITE, id, {testOnly: true});
}
