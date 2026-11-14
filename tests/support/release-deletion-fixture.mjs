import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import worker from '../../worker/app-builtin-runtime-preview.ts';
import {handleLogin} from '../../worker/auth.ts';
import {workspaceStore, TEST_EMAIL, TEST_PASSWORD, TEST_SECRET} from './test-workspace-store.mjs';

export const origin = 'https://dashboard.invalid';
export const id = 'builtin-release-' + 'a'.repeat(64);
export const otherId = 'builtin-release-' + 'b'.repeat(64);
export async function releaseDeletionFixture({releaseId = id, status = 'draft', deployments = true} = {}) {
  const f = workspaceStore();
  f.sqlite.exec(readFileSync('migrations/0001_initial.sql', 'utf8').split('INSERT OR IGNORE INTO publishers')[0]);
  if (deployments) f.sqlite.exec(readFileSync('migrations/0003_external_deployments.sql', 'utf8'));
  for (const site of ['first', 'second']) {
    f.sqlite.prepare('INSERT INTO publishers(id,name,domain,gam_path) VALUES(?,?,?,?)').run(site, site, site + '.invalid', '/123/' + site + '/');
  }
  for (const [key, site, state] of [[releaseId, 'first', status], [otherId, 'second', 'draft']]) {
    f.sqlite.prepare('INSERT INTO releases(id,publisher_id,version,status) VALUES(?,?,?,?)').run(key, site, key, state);
    f.objects.set(`publishers/${site}/releases/${key}/ads.js`, new Uint8Array([1, 2, 3]));
    f.objects.set(`publishers/${site}/releases/${key}/package.zip`, new Uint8Array([4, 5]));
  }
  // Include a similarly named neighbouring prefix: deleting one package must
  // not delete its neighbour, another site's package or configuration.
  f.objects.set(`publishers/first/releases/${releaseId}-other/ads.js`, new Uint8Array([6]));
  f.objects.set('publishers/first/prebid-builds/current/prebid.js', new Uint8Array([7]));
  f.listed = []; f.deleted = []; f.failStorage = false;
  f.env.BUILDS = {
    async list({prefix, cursor}) {
      f.listed.push(prefix);
      const keys = [...f.objects.keys()].filter(key => key.startsWith(prefix)).sort();
      const offset = Number(cursor || 0), slice = keys.slice(offset, offset + 1);
      return {objects: slice.map(key => ({key, size: f.objects.get(key).length})), truncated: offset + 1 < keys.length, cursor: String(offset + 1)};
    },
    async delete(keys) {
      if (f.failStorage) throw Error('Injected storage failure');
      for (const key of keys) { f.deleted.push(key); f.objects.delete(key); }
    },
    async get() { assert.fail('Deletion does not need to rewrite or recompile a package'); },
    async put() { assert.fail('No storage writes during deletion'); },
  };
  Object.assign(f.env, {ADMIN_EMAIL: TEST_EMAIL, ADMIN_PASSWORD: TEST_PASSWORD, SESSION_SECRET: TEST_SECRET});
  const login = await handleLogin(new Request(origin + '/api/auth/login', {method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify({email: TEST_EMAIL, password: TEST_PASSWORD})}), f.env);
  assert.equal(login.status, 303);
  f.cookie = login.headers.get('set-cookie').split(';')[0];
  f.releaseId = releaseId;
  f.request = async ({site = 'first', key = releaseId, method = 'DELETE', suffix = '', cookie = f.cookie, requestOrigin = origin, confirmation = key} = {}) => {
    const response = await worker.fetch(new Request(`${origin}/api/publishers/${site}/releases/${key}${suffix}`, {method, headers: {...(cookie ? {cookie} : {}), origin: requestOrigin, 'x-confirm-delete': confirmation}}), f.env, {});
    return {status: response.status, data: await response.json()};
  };
  f.addDeployment = (state = 'success') => {
    f.sqlite.prepare("INSERT OR IGNORE INTO deployment_targets(id,publisher_id,name,account_id,project_name,github_environment) VALUES('target','first','Fixture target','fixture','fixture','fixture')").run();
    f.sqlite.prepare("INSERT INTO external_deployments(id,publisher_id,target_id,release_id,release_version,channel,status,correlation_id) VALUES('dispatch','first','target',?,?,'staging',?,'fixture')").run(releaseId, releaseId, state);
  };
  f.exists = () => Boolean(f.sqlite.prepare('SELECT id FROM releases WHERE id=?').get(releaseId));
  return f;
}
