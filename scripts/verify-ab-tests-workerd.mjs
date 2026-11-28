/** A/B tests from the sealed Worker on LOCAL workerd equal a direct compose (MBA-416). Shared by both lines;
 * the line adapter (scripts/ab-tests-line.mjs) holds the Worker, sign-in, route and seeding.
 *
 * Runs the sealed Worker bundle in Miniflare with local D1 and R2, behind scripts/canonical-text-guard.mjs, with
 * every outbound request refused. It saves versions through the line's own Generate flow, creates an A/B test
 * (Prebid, bid caching off against on) and an A/A test (GAM only) through the A/B route, and checks:
 *  - loader-bytes parity: the downloaded ZIP equals composeAbBundle over the same saved versions, read in Node from
 *    the same D1 and R2: the id, the ZIP sha256, ads.js, _headers and every other file, and the record;
 *  - the loader template inside the served ads.js hashes to the ab-loader-registry.json entry of its version;
 *  - no function was serialized without canonical text (guard calls);
 *  - after a restart on the same storage, the same tests list and download the same bytes, and saving again
 *    returns the saved test without a write;
 *  - every stored object is inside the line's own prefixes, and every A/B object inside the site's A/B prefix;
 *  - the sealed bundle text contains no api.cloudflare.com (the Pages release script stays out of the Worker).
 * Writes .generated/ab-tests-workerd/report.json with the time of each create. LOCAL only; NOT hosted.
 * Run after test-build: node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs
 *   scripts/verify-ab-tests-workerd.mjs */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync} from 'fflate';
import {Miniflare} from './local-miniflare.mjs';
import {guardedModules, guardCalls, describeCalls} from './canonical-text-guard.mjs';
import * as line from './ab-tests-line.mjs';
import {composeAbBundle} from '../worker/experiments/ab-bundle.mjs';
import {abPrefix} from '../worker/experiments/ab-store.mjs';
import {AB_LOADER_PLACEHOLDER, AB_LOADER_TEMPLATE, AB_LOADER_VERSION} from '../worker/experiments/ab-loader-1.0.1.mjs';
import registry from '../worker/experiments/ab-loader-registry.json' with {type: 'json'};

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, '.generated/ab-tests-workerd');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const text = bytes => new TextDecoder().decode(bytes);
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v !== null && typeof v === 'object'
  ? `{${Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',')}}` : JSON.stringify(v ?? null);
// No request leaves this process: the Worker's outbound is refused below, and Node itself has no fetch.
let externalFetches = 0;
globalThis.fetch = () => { externalFetches++; throw Error('No external request in the A/B tests verifier'); };

const checks = [], failures = [], creates = [];
const check = (name, ok, detail = '') => { (ok ? checks : failures).push(ok ? name : `${name}${detail ? ': ' + detail : ''}`); console.log(`${ok ? 'ok    ' : 'FAILED'} ${name}${ok || !detail ? '' : ': ' + detail}`); };
let outbound = 0;

const script = await line.sealedWorker(root);
const config = await line.workerConfig(root);
const {origin} = config;
const directory = await mkdtemp(join(tmpdir(), 'tessera-ab-tests-workerd-'));

async function start(name) {
  const mf = new Miniflare({name: 'ab-tests-' + name, modules: guardedModules(script), compatibilityDate: config.compatibilityDate,
    compatibilityFlags: config.compatibilityFlags, host: '127.0.0.1', port: 0, cf: false, bindings: config.bindings, resourcePersistencePath: directory,
    d1Databases: {DB: 'ab-tests-d1'}, r2Buckets: {BUILDS: 'ab-tests-r2'},
    outboundService: () => { outbound++; return new Response('External requests disabled', {status: 503}); }});
  await mf.ready;
  const s = {mf, cookie: ''};
  s.call = (path, body, method = body === undefined ? 'GET' : 'POST', headers = {}) => mf.dispatchFetch(origin + path, {method, redirect: 'manual',
    headers: {cookie: s.cookie, ...(method === 'GET' ? {} : {origin, 'content-type': 'application/json'}), ...headers},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)});
  s.json = async (path, body, status = 200, method) => {
    const response = await s.call(path, body, method), data = await response.json();
    if (response.status !== status) throw Object.assign(Error(`${method ?? (body === undefined ? 'GET' : 'POST')} ${path} ${response.status}: ${data.error ?? ''}`), {data});
    return data;
  };
  s.bytes = async path => {
    const response = await s.call(path);
    assert.equal(response.status, 200, `${path} ${response.status}`);
    return {bytes: new Uint8Array(await response.arrayBuffer()), headers: response.headers};
  };
  s.cookie = await line.signIn(mf, config);
  const db = await mf.getD1Database('DB'), bucket = await mf.getR2Bucket('BUILDS');
  // The same storage objects the Worker reads, for the direct compose in Node.
  s.storage = {DB: {withSession: () => db}, BUILDS: bucket};
  return s;
}
async function allKeys(bucket) {
  const keys = [];let cursor;
  do { const page = await bucket.list({limit: 1000, ...(cursor ? {cursor} : {})}); keys.push(...page.objects.map(o => o.key)); cursor = page.truncated ? page.cursor : undefined; } while (cursor);
  return keys;
}
/** The loader template inside a served ads.js: the served text with the direct configuration put back as the placeholder. */
function servedTemplate(served, direct) {
  const [head, tail] = AB_LOADER_TEMPLATE.split(AB_LOADER_PLACEHOLDER);
  const configText = direct.slice(head.length, direct.length - tail.length);
  const parts = served.split(configText);
  return parts.length === 2 ? parts.join(AB_LOADER_PLACEHOLDER) : null;
}

const tests = [];
try {
  // 1. The sealed bundle never carries the Pages release script.
  check('The sealed Worker bundle contains no api.cloudflare.com', !script.includes('api.cloudflare.com'),
    `${script.split('api.cloudflare.com').length - 1} matches`);
  check('The registry hash of the loader equals its template', registry[AB_LOADER_VERSION]?.sha256 === sha(AB_LOADER_TEMPLATE));
  let s = await start('first');
  const ids = await line.seedVersions(s);
  const readVersion = line.versionReader(s.storage);
  for (const [label, body] of [
    ['prebid-bid-cache', {name: 'Bid cache on or off', testId: 'ab_parity_1', a: ids.A, b: ids.B, trafficBPercent: 30}],
    ['gam-only-aa', {name: 'GAM only A/A', testId: 'ab_parity_2', a: ids.gam, b: ids.gam, trafficBPercent: 50}],
  ]) {
    const checked = await s.json(line.AB_BASE + '/check', body);
    check(`${label}: the dry run finds the versions compatible`, checked.compatible === true, JSON.stringify(checked.refusal));
    const started = performance.now();
    const created = await s.json(line.AB_BASE, body, 201);
    const milliseconds = Math.round(performance.now() - started);
    creates.push({label, id: created.record.id, milliseconds});
    const {bytes: zip, headers} = await s.bytes(`${line.AB_BASE}/${created.record.id}/download`);
    const direct = await composeAbBundle({site: line.SITE, a: await readVersion(body.a), b: await readVersion(body.b), trafficBPercent: body.trafficBPercent, testId: body.testId, name: body.name});
    const served = unzipSync(zip);
    check(`${label}: the id equals the direct compose`, created.record.id === direct.id, `${created.record.id} vs ${direct.id}`);
    check(`${label}: the ZIP sha256 equals the direct compose and its header`, sha(zip) === direct.zipSha256 && headers.get('x-package-sha256') === direct.zipSha256 && created.record.bundle.zipSha256 === direct.zipSha256);
    check(`${label}: ads.js is byte-identical to the direct compose`, Buffer.from(served['ads.js'] ?? []).equals(Buffer.from(direct.files['ads.js'])));
    check(`${label}: _headers is byte-identical to the direct compose`, Buffer.from(served._headers ?? []).equals(Buffer.from(direct.files._headers)));
    const names = [...new Set([...Object.keys(served), ...Object.keys(direct.files)])].sort();
    const differing = names.filter(name => !served[name] || !direct.files[name] || !Buffer.from(served[name]).equals(Buffer.from(direct.files[name])));
    check(`${label}: every bundle file is byte-identical`, differing.length === 0, differing.join(', '));
    check(`${label}: the record equals the direct compose apart from who saved it and when`,
      canonical({...created.record, createdBy: null, createdAt: null}) === canonical(direct.record) && created.record.createdBy === config.email);
    const template = servedTemplate(text(served['ads.js'] ?? new Uint8Array()), text(direct.files['ads.js']));
    check(`${label}: the loader template in the served ads.js has the registry sha256 of ${AB_LOADER_VERSION}`,
      template !== null && sha(template) === registry[AB_LOADER_VERSION].sha256 && created.record.loader.sha256 === registry[AB_LOADER_VERSION].sha256);
    tests.push({label, body, id: created.record.id, zipSha256: sha(zip), recordSha256: created.recordSha256});
  }
  const calls = await guardCalls(s.mf, origin);
  check('No function was serialized without canonical text', calls.length === 0, describeCalls(calls).join('; '));
  await s.mf.dispose();

  // 2. A restart on the same local storage serves the same tests and bytes.
  s = await start('restart');
  const list = await s.json(line.AB_BASE);
  check('After a restart the same tests are listed', canonical(list.tests.map(t => t.id).sort()) === canonical(tests.map(t => t.id).sort()));
  for (const saved of tests) {
    const {bytes} = await s.bytes(`${line.AB_BASE}/${saved.id}/download`);
    check(`${saved.label}: after a restart the ZIP has the same bytes`, sha(bytes) === saved.zipSha256);
    const again = await s.json(line.AB_BASE, saved.body, 200);
    check(`${saved.label}: after a restart saving again returns the saved test`, again.created === false && again.record.id === saved.id && again.recordSha256 === saved.recordSha256);
  }
  const restartCalls = await guardCalls(s.mf, origin);
  check('No function was serialized without canonical text after the restart', restartCalls.length === 0, describeCalls(restartCalls).join('; '));

  // 3. Every object stays inside the line's own prefixes; the A/B objects inside the site's A/B prefix.
  const keys = await allKeys(s.storage.BUILDS), P = abPrefix(line.SITE);
  const outside = keys.filter(key => !line.OWN_PREFIXES.some(prefix => key.startsWith(prefix)));
  check('Every stored object is inside the line\'s own prefixes', outside.length === 0, outside.join(', '));
  const ab = keys.filter(key => key.startsWith('site-experiments/'));
  check('Every A/B object is inside the site\'s A/B prefix', ab.length > 0 && ab.every(key => key.startsWith(P)), ab.filter(key => !key.startsWith(P)).join(', '));
  for (const kind of ['records/', 'files/', 'zips/', 'test-ids/']) check(`The A/B prefix holds ${kind}`, ab.some(key => key.startsWith(P + kind)));
  await s.mf.dispose();
  check('The Worker made no outbound request', outbound === 0, `${outbound} requests`);
  check('Node made no external request', externalFetches === 0, `${externalFetches} requests`);
} catch (error) {
  failures.push(`Unexpected failure: ${error.message}`);
  console.log(error);
} finally {
  await rm(directory, {recursive: true, force: true});
}
const report = {scope: 'LOCAL Miniflare/workerd with local D1/R2; sealed Worker vs direct composeAbBundle in Node; NOT hosted', line: line.LINE,
  compiledSha256: sha(script), loader: {version: AB_LOADER_VERSION, sha256: registry[AB_LOADER_VERSION]?.sha256}, outbound, externalFetches, creates, tests: tests.map(({body, ...t}) => t),
  checks, failures, passed: failures.length === 0};
await mkdir(output, {recursive: true});
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({passed: checks.length, failed: failures.length, outbound, creates}));
assert.deepEqual(failures, [], `${failures.length} A/B checks failed`);
