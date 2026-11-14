import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {parse} from 'acorn';
import {runtimeReleaseHistory} from '../../worker/runtime/runtime-release-history.mjs';

// Admin code keeps explicit runtime allow-lists (deals plan, stable package path,
// Outstream, Deals panel, refresh summary, catalog sizing review). A runtime that
// is registered without being added to them saves no package or loses features.
const root = new URL('../../', import.meta.url);
const AUDITED = 'tessera-3.21.1';
const LISTS = {
  'worker/runtime/draft-release-store.mjs': ['hasDealsPlan'],
  'worker/site-runtime/releases.mjs': ['hasDealsPlan', 'stable316'],
  'worker/site-runtime/deal-settings.mjs': ['servingAvailable'],
  'worker/site-runtime/outstream-settings.mjs': ['runtimeEligible'],
  'worker/site-runtime/refresh-summary.mjs': ['inheritedViewPct'],
  'shared/outstream/selected-settings.mjs': ['outstreamContext'],
  'worker/test-workspace/runtime-catalog.mjs': ['readPinnedSiteRuntime'],
};
const DEAL_LISTS = ['worker/runtime/draft-release-store.mjs:hasDealsPlan', 'worker/site-runtime/releases.mjs:hasDealsPlan', 'worker/site-runtime/deal-settings.mjs:servingAvailable'];
// Version-owned sources and the registry itself are not admin allow-lists.
const frozen = path => /^worker\/runtime-[^/]+\//.test(path) || path === 'worker/runtime/runtime-releases.json';
const versionLiteral = /^(?:tessera-)?3\.21\.1$/;

const CLIMB = new Set(['ArrayExpression', 'LogicalExpression', 'BinaryExpression', 'CallExpression', 'MemberExpression', 'ChainExpression', 'UnaryExpression']);
function owner(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type === 'VariableDeclarator') return node.id.name;
    if (node.type === 'Property') return node.key.name ?? node.key.value;
    if (node.type === 'FunctionDeclaration') return node.id.name;
  }
  return '(module)';
}
/** Each allow-list is the largest literal/comparison expression around a 3.21.1 literal. */
async function allowLists(path) {
  const source = await readFile(new URL(path, root), 'utf8'), contexts = new Map();
  (function visit(node, ancestors) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Literal' && typeof node.value === 'string' && versionLiteral.test(node.value)) {
      let top = node;
      for (let i = ancestors.length - 1; i >= 0 && CLIMB.has(ancestors[i].type); i--) top = ancestors[i];
      const key = `${path}:${owner(ancestors)}`, strings = new Set();
      (function collect(inner) {
        if (!inner || typeof inner !== 'object') return;
        if (inner.type === 'Literal' && typeof inner.value === 'string') strings.add(inner.value);
        for (const value of Object.values(inner)) if (Array.isArray(value)) value.forEach(collect); else if (value && typeof value === 'object') collect(value);
      })(top);
      const previous = contexts.get(key);
      assert(!previous || previous.start === top.start, `${key} has one runtime allow-list`);
      contexts.set(key, {start: top.start, strings});
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, [...ancestors, node]));
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value, [...ancestors, node]);
    }
  })(parse(source, {ecmaVersion: 'latest', sourceType: 'module'}), []);
  return contexts;
}
async function everyList() {
  const all = new Map();
  for (const path of Object.keys(LISTS)) for (const [key, value] of await allowLists(path)) all.set(key, value);
  return all;
}
const featured = release => release.capabilities.includes('prebid-deals') || release.capabilities.includes('outstream-pilot');
/** Throws when a Deals or Outstream runtime registered since 3.21.1 (inclusive) is missing from an allow-list. */
function assertAllowListParity(history, lists) {
  const index = history.findIndex(release => release.id === AUDITED);
  assert(index >= 0, 'The audited 3.21.1 record must stay registered.');
  const required = history.slice(0, index + 1).filter(featured);
  assert(required.some(release => release.id === AUDITED));
  for (const [key, {strings}] of lists) {
    const usesIds = strings.has(AUDITED), usesVersions = strings.has('3.21.1');
    assert(usesIds || usesVersions, `${key} names neither ${AUDITED} nor 3.21.1`);
    for (const release of required) {
      if (key.endsWith(':stable316') && release.channel !== 'stable') continue;
      if (usesIds) assert(strings.has(release.id), `${key} is missing ${release.id}`);
      if (usesVersions) assert(strings.has(release.version), `${key} is missing ${release.version}`);
    }
  }
}
const withRuntime = (list, release) => ({...list, strings: new Set([...list.strings, release.id, release.version])});

test('every admin file that names a runtime version literal is a checked allow-list', () => {
  const found = execFileSync('git', ['grep', '-l', '-E', "['\"](tessera-)?3\\.21\\.1['\"]", '--', 'worker', 'shared', 'src'], {cwd: root, encoding: 'utf8'})
    .split('\n').filter(Boolean).filter(path => !frozen(path)).sort();
  assert.deepEqual(found, Object.keys(LISTS).sort(), 'Add a new runtime allow-list to this parity test');
});

test('allow-lists are located where expected', async () => {
  const lists = await everyList();
  assert.deepEqual([...lists.keys()].sort(), Object.entries(LISTS).flatMap(([path, names]) => names.map(name => `${path}:${name}`)).sort());
});

test('every runtime registered since 3.21.1 with Deals or Outstream is in every allow-list', async () => {
  assertAllowListParity(runtimeReleaseHistory, await everyList());
});

test('deals-plan and Deals serving lists match the prebid-deals capability for the whole registry', async () => {
  const lists = await everyList();
  const deals = runtimeReleaseHistory.filter(release => release.capabilities.includes('prebid-deals'));
  const others = runtimeReleaseHistory.filter(release => !release.capabilities.includes('prebid-deals'));
  for (const key of DEAL_LISTS) {
    const {strings} = lists.get(key);
    for (const release of deals) assert(strings.has(release.id), `${key} is missing ${release.id}`);
    for (const release of others) assert(!strings.has(release.id), `${key} must not list ${release.id}`);
  }
});

test('a registry record missing from an allow-list fails the parity check', async () => {
  const lists = await everyList(), forged = {...runtimeReleaseHistory[0], id: 'tessera-9.9.9', version: '9.9.9'};
  assert(featured(forged) && forged.channel === 'stable');
  const history = [forged, ...runtimeReleaseHistory];
  assert.throws(() => assertAllowListParity(history, lists), /is missing (?:tessera-)?9\.9\.9$/);
  // Each list is checked on its own: the forged runtime added everywhere except one list still fails on that list.
  for (const key of lists.keys()) {
    const others = new Map([...lists].map(([name, list]) => [name, name === key ? list : withRuntime(list, forged)]));
    assert.throws(() => assertAllowListParity(history, others), error => error.message.startsWith(`${key} is missing `), key);
  }
  // Controls: the same history passes once every list names it, and a runtime without Deals or Outstream is not required.
  assert.doesNotThrow(() => assertAllowListParity(history, new Map([...lists].map(([name, list]) => [name, withRuntime(list, forged)]))));
  const plain = {...forged, capabilities: forged.capabilities.filter(capability => !['prebid-deals', 'outstream-pilot'].includes(capability))};
  assert.doesNotThrow(() => assertAllowListParity([plain, ...runtimeReleaseHistory], lists));
});
