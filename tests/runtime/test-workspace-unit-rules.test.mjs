import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import { workspaceStore, ORIGIN, TEST_EMAIL, TEST_PASSWORD } from '../support/test-workspace-store.mjs';

const base = '/api/publishers/test-site';
const fixtures = [];
test.afterEach(() => { while (fixtures.length) fixtures.pop().close(); });
async function fixture({ setup = true } = {}) {
  const f = workspaceStore(); fixtures.push(f);
  const login = await worker.fetch(new Request(ORIGIN + '/api/auth/login', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: TEST_EMAIL, password: TEST_PASSWORD }) }), f.env);
  assert.equal(login.status, 303); f.cookie = login.headers.get('set-cookie').split(';')[0];
  f.req = (path, method = 'GET', body, extra = {}) => worker.fetch(new Request(ORIGIN + path, { method, headers: { cookie: f.cookie, origin: ORIGIN, 'content-type': 'application/json', ...extra }, body: body === undefined ? undefined : JSON.stringify(body) }), f.env);
  if (setup) {
    assert.equal((await f.req('/test-api/setup', 'POST', { confirm: 'prepare-empty-test-database' })).status, 200);
    const settings = await (await f.req('/test-api/site-runtime')).json();
    const saved = await f.req('/test-api/site-runtime', 'POST', { action: 'setup', revision: settings.revision, runtime: settings.currentRuntime.pin, allowPreview: false, enablePrebid: false });
    assert.equal(saved.status, 200, await saved.clone().text());
  }
  return f;
}
const countryRule = (country = 'rs') => ({ conditionalMappings: [{ id: 'country', name: 'Only selected country', enabled: true, priority: 10000, match: 'any', sizeMapKey: null, slotAction: 'disable', conditions: [
  { id: 'outside', key: 'geo_country', operator: 'notEquals', value: country },
  { id: 'unknown', key: 'geo_country', operator: 'notExists', value: '' },
] }] });
const state = f => JSON.stringify({ config: f.sqlite.prepare('SELECT * FROM publisher_configs').all(), rules: f.sqlite.prepare('SELECT * FROM unit_rules ORDER BY id').all(), audit: f.sqlite.prepare('SELECT * FROM audit_log ORDER BY id').all() });

test('TEST unit rule routes require session, same origin and exact site/resource scope', async () => {
  const f = await fixture(), before = state(f);
  for (const [path, method, body, headers, status] of [
    [base + '/unit-rules', 'GET', undefined, { cookie: '' }, 401],
    [base + '/unit-rules', 'POST', { ruleKey: 'Billboard', rule: {} }, { cookie: '' }, 401],
    [base + '/unit-rules/test-default-rule', 'PATCH', { rule: {} }, { cookie: '' }, 401],
    [base + '/unit-rules/test-default-rule', 'DELETE', undefined, { cookie: '' }, 401],
    [base + '/unit-rules', 'POST', { ruleKey: 'Billboard', rule: {} }, { origin: 'https://foreign.invalid' }, 403],
    [base + '/unit-rules/test-default-rule', 'PATCH', { rule: {} }, { origin: 'null' }, 403],
    [base + '/unit-rules/test-default-rule', 'DELETE', undefined, { 'sec-fetch-site': 'cross-site' }, 403],
    ['/api/publishers/politika/unit-rules', 'GET', undefined, {}, 404],
    ['/api/publishers/politika/unit-rules', 'POST', {}, {}, 404],
    ['/api/publishers/politika/unit-rules/id', 'PATCH', {}, {}, 405],
    [base + '/ad-units', 'POST', {}, {}, 405],
    [base + '/size-maps', 'POST', {}, {}, 405],
    [base + '/ad-units/test-billboard', 'PATCH', {}, {}, 405],
    [base + '/builtin-site-settings', 'POST', {}, {}, 405],
    [base + '/unit-rules', 'DELETE', undefined, {}, 405],
    [base + '/unit-rules/test-default-rule/duplicate', 'DELETE', undefined, {}, 405],
    [base + '/unit-rules/test-default-rule%2Fextra', 'PATCH', {}, {}, 405],
    [base + '/unit-rules?site=politika', 'GET', undefined, {}, 404],
    [base + '/unit-rules/test-default-rule?site=politika', 'PATCH', {}, {}, 404],
    [base + '/unit-rules/test-default-rule', 'PUT', {}, {}, 405],
  ]) {
    const response = await f.req(path, method, body, headers);
    assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  }
  const wrongHost = await worker.fetch(new Request('https://prebid-professor.mbaucal.workers.dev' + base + '/unit-rules', { headers: { cookie: f.cookie } }), f.env);
  assert.equal(wrongHost.status, 404);
  assert.equal(state(f), before);
});

test('TEST country rule CRUD and copying preserve pins, canonical codes, conflicts and authenticated audit actor', async () => {
  const f = await fixture();
  const config = () => JSON.parse(f.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
  const pin = config().builtinRuntimeSelection;
  for (const resource of ['unit-rules', 'ad-units', 'size-maps', 'builtin-site-settings']) {
    const response = await f.req(`${base}/${resource}`); assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
  }
  const spoof = { 'x-user-email': 'spoof@example.invalid', 'cf-access-authenticated-user-email': 'spoof2@example.invalid' };
  const created = await f.req(base + '/unit-rules', 'POST', { ruleKey: 'Billboard', rule: countryRule() }, spoof);
  assert.equal(created.status, 201, await created.clone().text()); const source = (await created.json()).unitRule;
  assert.equal(source.rule.conditionalMappings[0].conditions[0].value, 'RS');
  const copied = await f.req(`${base}/unit-rules/${source.id}/duplicate`, 'POST', { ruleKey: '__INTERSTITIAL__' }, spoof);
  assert.equal(copied.status, 201, await copied.clone().text()); const fallback = (await copied.json()).unitRule;
  assert.deepEqual(fallback.rule, source.rule);
  const changed = await f.req(`${base}/unit-rules/${fallback.id}`, 'PATCH', { rule: countryRule('de'), expectedUpdatedAt: fallback.updatedAt }, spoof);
  assert.equal(changed.status, 200, await changed.clone().text());
  const beforeStale = state(f);
  assert.equal((await f.req(`${base}/unit-rules/${fallback.id}`, 'PATCH', { rule: countryRule('rs'), expectedUpdatedAt: fallback.updatedAt })).status, 409);
  assert.equal(state(f), beforeStale);
  assert.equal(config().unitRules.__INTERSTITIAL__.conditionalMappings[0].conditions[0].value, 'DE');
  assert.equal((await f.req(`${base}/unit-rules/${fallback.id}`, 'DELETE', undefined, spoof)).status, 200);
  assert.equal(config().unitRules.__INTERSTITIAL__, undefined);
  assert.deepEqual(config().builtinRuntimeSelection, pin);
  const audits = f.sqlite.prepare("SELECT actor,action FROM audit_log WHERE action LIKE 'unit_rule.%'").all();
  assert.deepEqual(audits.map(row => row.action).sort(), ['unit_rule.created', 'unit_rule.deleted', 'unit_rule.duplicated', 'unit_rule.updated']);
  assert(audits.every(row => row.actor === TEST_EMAIL));
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM ad_units WHERE code='__INTERSTITIAL__'").get().n, 0);
});

test('TEST rule mutations reject oversized, foreign and invalid fields before writes', async () => {
  const f = await fixture(), before = state(f);
  for (const body of [
    { ruleKey: 'Billboard', rule: {}, publisherId: 'politika' },
    { ruleKey: 'Billboard', rule: {}, testOnly: false },
    { ruleKey: '__INTERSTITIAL__', rule: { ...countryRule(), timeout: 1500 } },
    { ruleKey: 'Billboard', rule: countryRule('XX') },
  ]) assert.equal((await f.req(base + '/unit-rules', 'POST', body)).status, 422);
  assert.equal((await f.req(base + '/unit-rules', 'POST', { ruleKey: 'Billboard', rule: {}, padding: 'x'.repeat(262144) })).status, 413);
  assert.equal((await f.req(base + '/unit-rules', 'POST', {} , { 'content-type': 'text/plain' })).status, 415);
  assert.equal(state(f), before);
});

test('TEST routes refuse unprepared or mismatched schema and out-of-scope saved identity', async () => {
  const empty = await fixture({ setup: false });
  assert.equal((await empty.req(base + '/unit-rules')).status, 409);
  const f = await fixture();
  f.sqlite.prepare("UPDATE tessera_test_environment SET bucket_name='wrong-bucket'").run();
  assert.equal((await f.req(base + '/unit-rules')).status, 409);
  const other = await fixture();
  const config = JSON.parse(other.sqlite.prepare('SELECT config_json FROM publisher_configs').get().config_json);
  config.enablePrebid = true;
  other.sqlite.prepare('UPDATE publisher_configs SET config_json=?').run(JSON.stringify(config));
  const before = state(other);
  const blocked = await other.req(base + '/unit-rules', 'POST', { ruleKey: 'Billboard', rule: {} });
  assert.equal(blocked.status, 409); assert.match(await blocked.text(), /TEST editor/); assert.equal(state(other), before);
});
