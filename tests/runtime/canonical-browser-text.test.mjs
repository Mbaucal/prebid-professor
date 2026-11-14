/** Every function that Worker code turns into source text must be covered by a
 * canonical-text installer that its Worker entry imports first. A bundler may
 * rename the function or its locals, and generated code calls it by its source
 * name (see worker/runtime-canonical/functions.mjs).
 * Run after scripts/prepare-builtin-runtime.mjs (it writes the canonical text).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parse} from 'acorn';
import {build, transformSync} from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const nativeText = Function.prototype.toString;
// Recorded before any Worker module loads: a Worker or shared module that
// serializes a function without an installed canonical toString lands here.
const uncovered = new Map();
Function.prototype.toString = function toString() {
  const text = nativeText.call(this);
  if (!/\{\s*\[native code\]\s*\}$/.test(text)) {
    const site = new Error().stack.split('\n').slice(2).map(line => line.trim()).find(line => /\/(worker|shared)\//.test(line) && !line.includes('/node_modules/'));
    if (site) uncovered.set(`${this.name || '(anonymous)'} at ${site.replace(pathToFileURL(root).href + '/', '').replace(/^at /, '')}`, true);
  }
  return text;
};
const {runtimeFunctions, appFunctions, testWorkspaceFunctions} = await import('../../worker/runtime-canonical/functions.mjs');
const groups = {'worker/runtime-canonical/install.mjs': runtimeFunctions, 'worker/runtime-canonical/install-app.mjs': appFunctions,
  'worker/runtime-canonical/install-test-workspace.mjs': testWorkspaceFunctions};
const installerOf = new Map(Object.entries(groups).flatMap(([installer, listed]) =>
  Object.entries(listed).flatMap(([path, names]) => names.map(name => [`${path}#${name}`, installer]))));

// ---------------------------------------------------------------- static scan
function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(resolve(root, directory), {withFileTypes: true})) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') files.push(...sourceFiles(path)); }
    else if (/\.(?:mjs|js|ts)$/.test(entry.name) && !/\.d\.m?ts$/.test(entry.name)) files.push(path);
  }
  return files;
}
const modules = new Map();
/** Lexical scopes, enough to tell a function binding from a parameter or value of the same name. */
function scopes(ast) {
  const scopeOf = new WeakMap(), program = {parent: null, function: true, bindings: new Map()};
  const declare = (scope, pattern, binding) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') scope.bindings.set(pattern.name, binding);
    else if (pattern.type === 'ObjectPattern') for (const p of pattern.properties) declare(scope, p.type === 'RestElement' ? p.argument : p.value, {kind: 'value'});
    else if (pattern.type === 'ArrayPattern') for (const e of pattern.elements) declare(scope, e, {kind: 'value'});
    else if (pattern.type === 'AssignmentPattern') declare(scope, pattern.left, {kind: 'value'});
    else if (pattern.type === 'RestElement') declare(scope, pattern.argument, {kind: 'value'});
  };
  const children = node => Object.values(node).flatMap(value => Array.isArray(value) ? value : [value]).filter(value => value && typeof value.type === 'string');
  function visit(node, scope) {
    if (!node || typeof node.type !== 'string') return;
    scopeOf.set(node, scope);
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      if (node.type === 'FunctionDeclaration' && node.id) scope.bindings.set(node.id.name, {kind: 'function', node});
      const inner = {parent: scope, function: true, bindings: new Map()};
      if (node.type === 'FunctionExpression' && node.id) inner.bindings.set(node.id.name, {kind: 'function', node});
      for (const param of node.params) { declare(inner, param, {kind: 'value'}); visit(param, inner); }
      if (node.body.type === 'BlockStatement') { scopeOf.set(node.body, inner); for (const statement of node.body.body) visit(statement, inner); }
      else visit(node.body, inner);
      return;
    }
    let inner = scope;
    if (['BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'CatchClause', 'SwitchStatement', 'StaticBlock'].includes(node.type)) inner = {parent: scope, bindings: new Map()};
    if (node.type === 'CatchClause') declare(inner, node.param, {kind: 'value'});
    if (node.type === 'ClassDeclaration' && node.id) scope.bindings.set(node.id.name, {kind: 'value'});
    if (node.type === 'ImportDeclaration') for (const s of node.specifiers) scope.bindings.set(s.local.name, {kind: 'import'});
    if (node.type === 'VariableDeclaration') {
      let target = inner;
      if (node.kind === 'var') while (!target.function) target = target.parent;
      for (const d of node.declarations) {
        const kind = ['FunctionExpression', 'ArrowFunctionExpression'].includes(d.init?.type) ? 'function'
          : ['Identifier', 'MemberExpression'].includes(d.init?.type) ? 'alias' : 'value';
        declare(target, d.id, {kind, node: d.init});
      }
    }
    for (const child of children(node)) visit(child, inner);
  }
  visit(ast, program);
  return {program, scopeOf, lookup(node, name) {
    for (let scope = scopeOf.get(node); scope; scope = scope.parent) if (scope.bindings.has(name)) return {scope, ...scope.bindings.get(name)};
    return null;
  }};
}
function moduleInfo(path) {
  if (modules.has(path)) return modules.get(path);
  let text = readFileSync(resolve(root, path), 'utf8');
  if (path.endsWith('.ts')) text = transformSync(text, {loader: 'ts', format: 'esm', target: 'es2022'}).code;
  const ast = parse(text, {ecmaVersion: 'latest', sourceType: 'module', locations: true});
  const info = {path, ast, ...scopes(ast), imports: new Map(), exports: new Map(), reexports: new Map(), star: []};
  modules.set(path, info);
  const specifier = value => {
    if (!value.startsWith('.')) return null;
    const base = relative(root, resolve(root, dirname(path), value)).replaceAll('\\', '/');
    return [base, base + '.ts', base + '.mjs', base + '.js'].find(candidate => existsSync(resolve(root, candidate)) && /\.(?:mjs|js|ts)$/.test(candidate)) ?? null;
  };
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const from = specifier(node.source.value);
      for (const s of node.specifiers) info.imports.set(s.local.name, {from, name: s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : s.imported.name});
    } else if (node.type === 'ExportNamedDeclaration') {
      const from = node.source ? specifier(node.source.value) : null;
      if (node.declaration?.type === 'FunctionDeclaration') info.exports.set(node.declaration.id.name, node.declaration.id.name);
      if (node.declaration?.type === 'VariableDeclaration') for (const d of node.declaration.declarations) if (d.id.type === 'Identifier') info.exports.set(d.id.name, d.id.name);
      for (const s of node.specifiers) {
        if (from) info.reexports.set(s.exported.name, {from, name: s.local.name});
        else info.exports.set(s.exported.name, s.local.name);
      }
    } else if (node.type === 'ExportAllDeclaration' && node.source) info.star.push(specifier(node.source.value));
    else if (node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'FunctionDeclaration' && node.declaration.id) info.exports.set('default', node.declaration.id.name);
  }
  return info;
}
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}
/** {path, name} of the exported function, or null when the export is not a function. */
function exportedFunction(path, name, depth = 0) {
  if (!path || depth > 8) return null;
  const info = moduleInfo(path);
  if (info.exports.has(name)) {
    const local = info.exports.get(name), binding = info.program.bindings.get(local);
    if (binding?.kind === 'function') return {path, name, local};
    const imported = info.imports.get(local);
    return imported && imported.name !== '*' ? exportedFunction(imported.from, imported.name, depth + 1) : null;
  }
  if (info.reexports.has(name)) { const r = info.reexports.get(name); return exportedFunction(r.from, r.name, depth + 1); }
  for (const from of info.star) { const found = exportedFunction(from, name, depth + 1); if (found) return found; }
  return null;
}
function functionExports(path) {
  const info = moduleInfo(path);
  return [...info.exports.keys(), ...info.reexports.keys()].map(name => exportedFunction(path, name)).filter(Boolean);
}
/** What a serialized expression refers to: a function, every function of a namespace, or null. */
function resolveFunction(info, node, depth = 0) {
  if (depth > 4) return null;
  if (node.type === 'Identifier') {
    const binding = info.lookup(node, node.name);
    if (!binding) return null;
    if (binding.kind === 'import') {
      const imported = info.imports.get(node.name), fn = imported.name === '*' ? null : exportedFunction(imported.from, imported.name);
      return fn ? [fn] : null;
    }
    if (binding.kind === 'function') {
      const exported = binding.scope === info.program && [...info.exports].find(([, local]) => local === node.name);
      return [{path: info.path, name: exported ? exported[0] : null, local: node.name}];
    }
    if (binding.kind === 'alias') return resolveFunction(info, binding.node, depth + 1);
    return null;
  }
  if (node.type === 'MemberExpression' && node.object.type === 'Identifier' && info.lookup(node, node.object.name)?.kind === 'import' && info.imports.get(node.object.name).name === '*') {
    const from = info.imports.get(node.object.name).from;
    if (!node.computed) { const fn = exportedFunction(from, node.property.name); return fn ? [fn] : null; }
    if (node.property.type === 'Literal') { const fn = exportedFunction(from, String(node.property.value)); return fn ? [fn] : null; }
    return functionExports(from); // a computed member may be any function of the namespace
  }
  return null;
}
const memberName = node => node.type === 'MemberExpression' && (node.computed ? node.property.type === 'Literal' && node.property.value : node.property.name);
function serializationSites() {
  const sites = [], forbidden = [];
  for (const path of [...sourceFiles('worker'), ...sourceFiles('shared')]) {
    const info = moduleInfo(path);
    const add = (node, how) => {
      for (const fn of resolveFunction(info, node) ?? []) sites.push({file: `${path}:${node.loc.start.line}`, how, fn});
    };
    walk(info.ast, (node, parent) => {
      if (memberName(node) === 'toString') {
        add(node.object, '.toString');
        if (memberName(node.object) === 'prototype' && node.object.object.type === 'Identifier' && node.object.object.name === 'Function') forbidden.push(`${path}:${node.loc.start.line}`);
      }
      if (node.type === 'TemplateLiteral') for (const expression of node.expressions) add(expression, 'template');
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'String') for (const argument of node.arguments) add(argument, 'String()');
      if (node.type === 'BinaryExpression' && node.operator === '+') { add(node.left, '+'); add(node.right, '+'); }
      if (node.type === 'AssignmentExpression' && node.operator === '+=') add(node.right, '+=');
      if (memberName(node) === 'concat') for (const argument of parent?.type === 'CallExpression' && parent.callee === node ? parent.arguments : []) add(argument, '.concat()');
    });
  }
  return {sites, forbidden};
}

test('every function serialized in worker/** or shared/** is listed for a canonical-text installer', () => {
  const {sites, forbidden} = serializationSites();
  assert.deepEqual(forbidden, [], 'Function.prototype.toString bypasses the installed canonical text; call fn.toString() on a listed function instead.');
  const problems = [];
  for (const {file, how, fn} of sites) {
    if (!fn.name) problems.push(`${file} ${how} ${fn.local}: not exported from ${fn.path}, so no installer can reach it; export it and list it in worker/runtime-canonical/functions.mjs`);
    else if (!installerOf.has(`${fn.path}#${fn.name}`)) problems.push(`${file} ${how} ${fn.path} ${fn.name}: missing from worker/runtime-canonical/functions.mjs`);
  }
  assert.deepEqual(problems, [], 'Generated code would embed bundler-renamed source.');
  // Sanity: the scan finds the known compiler sites, so it cannot silently pass.
  const found = new Set(sites.map(site => `${site.fn.path}#${site.fn.name}`));
  for (const key of installerOf.keys()) assert(found.has(key), `${key} is listed but nothing serializes it; remove it from the list`);
  assert(sites.some(site => site.file.startsWith('worker/runtime-next/compiler.mjs:')), 'runtime-next compiler site not found');
  assert(sites.some(site => site.file.startsWith('worker/runtime-3211/storage-compiler.mjs:')), '3.21.1 storage compiler site not found');
});

// ---------------------------------------------------------------- Worker entries
const entries = ['wrangler.jsonc', 'ops/runtime-test/wrangler.jsonc', 'ops/runtime-test/wrangler.active.jsonc'].map(config =>
  relative(root, resolve(root, dirname(config), JSON.parse(readFileSync(resolve(root, config), 'utf8')).main)).replaceAll('\\', '/'));

test('each Worker entry imports first the installer for every serialized function it bundles', async () => {
  const {sites} = serializationSites();
  for (const entry of [...new Set(entries)]) {
    const first = moduleInfo(entry).ast.body.find(node => node.type === 'ImportDeclaration');
    const installer = relative(root, resolve(root, dirname(entry), first.source.value)).replaceAll('\\', '/');
    assert(installer in groups, `${entry} must import a canonical-text installer before any other module, not ${installer}`);
    const result = await build({absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral',
      mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], logLevel: 'silent'});
    const graph = new Set(Object.keys(result.metafile.inputs));
    for (const {file, fn} of sites) {
      if (!graph.has(file.replace(/:\d+$/, ''))) continue;
      const needed = installerOf.get(`${fn.path}#${fn.name}`);
      if (!needed) continue; // reported by the coverage test above
      assert(graph.has(needed), `${entry} bundles ${file}, which serializes ${fn.name}, but not ${needed}`);
    }
    if (installer !== 'worker/runtime-canonical/install.mjs') assert(graph.has('worker/runtime-canonical/install.mjs'));
  }
});

// ---------------------------------------------------------------- installed text
test('installed text is the unbundled source and no Worker code serializes an uncovered function', async () => {
  await import('../../worker/test-workspace/index.mjs');
  await import('../../worker/app-builtin-runtime-preview.ts');
  const {canonicalSources} = await import('../../.generated/browser-canonical-source.mjs');
  for (const [path, listed] of Object.entries({...runtimeFunctions, ...appFunctions, ...testWorkspaceFunctions})) {
    const namespace = await import(pathToFileURL(resolve(root, path)).href);
    for (const name of listed) {
      const fn = namespace[name], text = canonicalSources[path][name];
      const descriptor = Object.getOwnPropertyDescriptor(fn, 'toString');
      assert(descriptor, `${path} ${name}: no installed toString`);
      assert.deepEqual([descriptor.enumerable, descriptor.writable, descriptor.configurable], [false, false, false]);
      assert.equal(text, nativeText.call(fn), `${path} ${name}: prepared text differs from the unbundled source`);
      for (const serialized of [fn.toString(), `${fn}`, String(fn), fn + '']) assert.equal(serialized, text);
      assert.equal(Object.keys(fn).includes('toString'), false);
    }
  }
  // Exercise generation of every runtime, the country script and the TEST-only
  // serializers. Any uncovered serialization reaches the recording prototype.
  const catalog = await import('../../worker/test-workspace/runtime-catalog.mjs');
  const {pinRuntime} = await import('../../worker/runtime/version-pin.mjs');
  const {positionFixture} = await import('../support/position-runtime-fixture.mjs');
  const {configure} = await import('./artifact-fixture.mjs');
  const refused = [];
  for (const descriptor of catalog.runtimeCatalog) {
    for (const frequency of [5, null]) {
      const snapshot = configure(positionFixture(false), config => {
        if (frequency === null) config.runtimeControls.adPositions = {};
        else config.runtimeControls.adPositions.Overlay.frequencyMinutes = frequency;
      });
      if (frequency === null) snapshot.units = snapshot.units.filter(unit => unit.code !== 'Overlay');
      try { await catalog.buildArtifactCandidate({snapshot, pin: pinRuntime(descriptor, {allowPreview: true}), buildTimestamp: '20261114_000000', prebid: null}); }
      catch (error) { refused.push(`${descriptor.version} TakeOver ${frequency ?? 'off'}: ${error.message}`); }
    }
  }
  // Only the 3.9.1 reference takes neither fixture. Every other runtime must
  // build both, so its TakeOver helpers really are serialized above.
  assert.deepEqual(refused.filter(line => !line.startsWith('3.9.1-')), []);
  const {countryClientSource} = await import('../../shared/geo-country.mjs');
  countryClientSource('https://example.invalid/geo');
  const {baseReadable} = await import('../../.generated/site-ab-baseline.mjs');
  const {preparePackageTemplates} = await import('../../worker/experiments/configurable-cache-v1.mjs');
  const {preparePositionCacheTemplate} = await import('../../worker/experiments/position-cache-v2.mjs');
  const {staticAALoader, AA_RELEASE} = await import('../../worker/experiments/static-aa-v1.mjs');
  const {cmpLoader, CMP_RELEASE} = await import('../../worker/experiments/cmp-aa-v1.mjs');
  preparePackageTemplates(baseReadable);
  preparePositionCacheTemplate(baseReadable);
  staticAALoader({release: AA_RELEASE, arms: {A: {integrity: 'sha384-x'}, B: {integrity: 'sha384-x'}}});
  cmpLoader({release: CMP_RELEASE});
  const {prebidScript} = await import('../../worker/test-workspace/prebid-page.mjs');
  assert(prebidScript.includes(canonicalSources['worker/test-workspace/prebid-versions.mjs'].fetchPrebidVersions));
  assert.deepEqual([...uncovered.keys()], [], 'Worker code serialized a function without canonical text');
});
