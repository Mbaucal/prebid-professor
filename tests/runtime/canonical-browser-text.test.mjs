/** Every function that Worker code turns into source text must be covered by a
 * canonical-text installer that its Worker entry imports first. A bundler may
 * rename the function or its locals, and generated code calls it by its source
 * name (see worker/runtime-canonical/functions.mjs).
 *
 * The scan reads every repository file that esbuild bundles into a Worker entry
 * (worker/**, shared/**, scripts/**, src/**, vendor/** and .generated modules).
 * It resolves serialized expressions to function declarations and is strict
 * where it cannot resolve them:
 * - toString may only be called directly (x.toString(...)), on a listed function
 *   or on a value the scan proves is not a function; reviewedToString below
 *   lists the few remaining calls by hand. toString.call/apply/bind, any other
 *   use of a toString member and destructuring toString are refused.
 * - a function in an array literal must be listed: join, map(String) and
 *   String(array) serialize it.
 * - templates, String(), + and concat() of a resolved function must be listed.
 * A static scan cannot follow a function through other data (an object property
 * read back with Object.values, a computed member). Executed paths are covered
 * by the recording Function.prototype.toString in the third test and by the
 * guard that scripts/verify-workerd-generation-parity.mjs installs in the sealed
 * Worker.
 * Run after scripts/prepare-builtin-runtime.mjs (it writes the canonical text).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parse} from 'acorn';
import {build, transformSync} from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const repoPath = file => relative(root, file).replaceAll('\\', '/');

// ---------------------------------------------------------------- Worker graph
const entries = [...new Set(['wrangler.jsonc', 'ops/runtime-test/wrangler.jsonc', 'ops/runtime-test/wrangler.active.jsonc'].map(config =>
  repoPath(resolve(root, dirname(config), JSON.parse(readFileSync(resolve(root, config), 'utf8')).main))))];
const graphs = new Map();
for (const entry of entries) {
  const result = await build({absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, metafile: true, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['node:*', 'cloudflare:*'], logLevel: 'silent'});
  graphs.set(entry, new Set(Object.keys(result.metafile.inputs)));
}
/** Repository source files bundled into a Worker entry (dependencies excluded). */
const workerFiles = [...new Set([...graphs.values()].flatMap(graph => [...graph]))]
  .filter(path => !path.split('/').includes('node_modules') && /\.(?:[cm]?js|jsx|tsx?)$/.test(path)).sort();
const inWorker = new Set(workerFiles);

const nativeText = Function.prototype.toString;
// Recorded before any Worker module loads: a bundled module that serializes a
// function without an installed canonical toString lands here.
const uncovered = new Map();
const frameFile = line => {
  const match = /(file:\/\/\/[^\s()]+?)(?::\d+){1,2}\)?$/.exec(line);
  return match ? repoPath(fileURLToPath(match[1])) : null;
};
Function.prototype.toString = function toString() {
  const text = nativeText.call(this);
  if (!/\{\s*\[native code\]\s*\}$/.test(text)) {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 64;
    const stack = new Error().stack;
    Error.stackTraceLimit = limit;
    const site = stack.split('\n').slice(2).map(line => line.trim()).find(line => inWorker.has(frameFile(line)));
    if (site) uncovered.set(`${this.name || '(anonymous)'} at ${site.replace(pathToFileURL(root).href + '/', '').replace(/^at /, '')}`, true);
  }
  return text;
};
const {runtimeFunctions, testWorkspaceFunctions} = await import('../../worker/runtime-canonical/functions.mjs');
const groups = {'worker/runtime-canonical/install.mjs': runtimeFunctions, 'worker/runtime-canonical/install-test-workspace.mjs': testWorkspaceFunctions};
const installerOf = new Map(Object.entries(groups).flatMap(([installer, listed]) =>
  Object.entries(listed).flatMap(([path, names]) => names.map(name => [`${path}#${name}`, installer]))));

/** toString uses whose receiver the scan cannot prove is not a function, checked
 * by hand: file -> use (a call ends in "()") -> count. Counts are exact, so a new
 * use fails until someone checks its receiver here. */
const reviewedToString = {
  // escapeCssId: n = value.charCodeAt(i), a number.
  'shared/gam/ad-unit-code.mjs': {'n.toString()': 1},
  // Vendored XML parser: code point numbers, path matcher objects and the XML input
  // (string or bytes; xmlData.toString without a call is a presence test).
  'vendor/gam-xml-parser/parser.mjs': {'cp.toString()': 1, 'this._matcher.toString()': 1, 'jPath.toString()': 4, 'matcher.toString()': 1,
    'readonlyMatcher.toString()': 2, 'xmlData.toString()': 1, 'xmlData.toString': 1},
};

// ---------------------------------------------------------------- static scan
const modules = new Map();
/** Lexical scopes, enough to tell a function binding from a parameter or value of the same name. */
function scopes(ast) {
  const scopeOf = new WeakMap(), loopHeads = new WeakSet(), program = {parent: null, function: true, bindings: new Map()};
  const declare = (scope, pattern, binding) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') scope.bindings.set(pattern.name, {...binding, scope, at: pattern.start});
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
      if (node.type === 'FunctionDeclaration' && node.id) declare(scope, node.id, {kind: 'function', node});
      const inner = {parent: scope, function: true, bindings: new Map()};
      if (node.type === 'FunctionExpression' && node.id) declare(inner, node.id, {kind: 'function', node});
      node.params.forEach((param, index) => {
        declare(inner, param, param.type === 'Identifier' ? {kind: 'param', fn: node, index} : {kind: 'value'});
        visit(param, inner);
      });
      if (node.body.type === 'BlockStatement') { scopeOf.set(node.body, inner); for (const statement of node.body.body) visit(statement, inner); }
      else visit(node.body, inner);
      return;
    }
    let inner = scope;
    if (['BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'CatchClause', 'SwitchStatement', 'StaticBlock'].includes(node.type)) inner = {parent: scope, bindings: new Map()};
    if (node.type === 'CatchClause') declare(inner, node.param, {kind: 'value'});
    if ((node.type === 'ForOfStatement' || node.type === 'ForInStatement') && node.left.type === 'VariableDeclaration') loopHeads.add(node.left);
    if (node.type === 'ClassDeclaration' && node.id) declare(scope, node.id, {kind: 'value'});
    if (node.type === 'ImportDeclaration') for (const s of node.specifiers) declare(scope, s.local, {kind: 'import'});
    if (node.type === 'VariableDeclaration') {
      let target = inner;
      if (node.kind === 'var') while (!target.function) target = target.parent;
      for (const d of node.declarations) {
        const kind = ['FunctionExpression', 'ArrowFunctionExpression'].includes(d.init?.type) ? 'function'
          : ['Identifier', 'MemberExpression'].includes(d.init?.type) ? 'alias' : 'value';
        // A loop head's binding takes each element, not its (missing) initializer.
        declare(target, d.id, {kind, node: d.init, declaration: loopHeads.has(node) ? 'loop' : node.kind});
      }
    }
    for (const child of children(node)) visit(child, inner);
  }
  visit(ast, program);
  return {program, scopeOf, lookup(node, name) {
    for (let scope = scopeOf.get(node); scope; scope = scope.parent) if (scope.bindings.has(name)) return scope.bindings.get(name);
    return null;
  }};
}
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}
function moduleInfo(path) {
  if (modules.has(path)) return modules.get(path);
  let text = readFileSync(resolve(root, path), 'utf8');
  // Erasing types keeps line numbers (Node runs these .ts files the same way); JSX needs a transform.
  if (path.endsWith('.ts')) text = stripTypeScriptTypes(text);
  else if (/\.[jt]sx$/.test(path)) text = transformSync(text, {loader: path.slice(-3), format: 'esm', target: 'es2022'}).code;
  const ast = parse(text, {ecmaVersion: 'latest', sourceType: 'module', locations: true});
  const info = {path, text, ast, ...scopes(ast), parents: new WeakMap(), assignments: new Map(), imports: new Map(), exports: new Map(), reexports: new Map(), star: []};
  modules.set(path, info);
  walk(ast, (node, parent) => {
    info.parents.set(node, parent);
    // Every later value of a let or var binding, for the non-function proof.
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && ['=', '||=', '&&=', '??='].includes(node.operator)) {
      const binding = info.lookup(node, node.left.name);
      if (binding) info.assignments.set(binding, [...(info.assignments.get(binding) ?? []), node.right]);
    }
  });
  const specifier = value => {
    if (!value.startsWith('.')) return null;
    const base = repoPath(resolve(root, dirname(path), value));
    return [base, base + '.ts', base + '.mjs', base + '.js'].find(candidate => existsSync(resolve(root, candidate)) && /\.(?:mjs|js|ts)$/.test(candidate)) ?? null;
  };
  for (const node of ast.body) {
    if (node.type === 'ImportDeclaration') {
      const from = specifier(node.source.value);
      for (const s of node.specifiers) info.imports.set(s.local.name, {from, source: node.source.value, name: s.type === 'ImportNamespaceSpecifier' ? '*' : s.type === 'ImportDefaultSpecifier' ? 'default' : s.imported.name});
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
/** {path, name, local} of the exported function, or null when the export is not a function. */
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
      return [{path: info.path, name: exported ? exported[0] : null, local: node.name, node: binding.node}];
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
const keyName = node => !node.computed && node.key.type === 'Identifier' ? node.key.name : node.key.type === 'Literal' ? node.key.value : null;

// Proof that a toString receiver is not a function, for the common non-function
// receivers: primitives, built-in object instances and bytes of a typed array.
const instances = new Set(['URL', 'URLSearchParams', 'Date', 'Headers', 'Request', 'Response', 'Map', 'Set', 'WeakMap', 'RegExp', 'Error', 'TypeError',
  'RangeError', 'TextEncoder', 'TextDecoder', 'ArrayBuffer', 'DataView', 'Blob', 'FormData']);
const typedArray = /^(?:Big)?(?:Ui|I)nt(?:8|16|32|64)(?:Clamped)?Array$|^Float(?:32|64)Array$/;
const valueCalls = new Set(['String', 'Number', 'BigInt', 'Boolean', 'parseInt', 'parseFloat', 'encodeURIComponent', 'encodeURI', 'decodeURIComponent', 'decodeURI', 'btoa', 'atob']);
const valueStatics = {Buffer: ['from', 'concat', 'alloc'], JSON: ['stringify'], Math: null, Number: null, Date: ['now', 'parse', 'UTC']};
/** A global built-in, or the same built-in imported from node: (import {Buffer} from 'node:buffer'). */
function isGlobal(info, node, names) {
  if (node.type !== 'Identifier' || !(names instanceof RegExp ? names.test(node.name) : names.has(node.name))) return false;
  const binding = info.lookup(node, node.name), imported = binding?.kind === 'import' && info.imports.get(node.name);
  return !binding || Boolean(imported && imported.source.startsWith('node:') && imported.name === node.name);
}
/** Values a function can return (undefined when it has no return value). */
function returnValues(fn) {
  if (fn.body.type !== 'BlockStatement') return [fn.body];
  const values = [];
  (function visit(node) {
    if (!node || typeof node.type !== 'string' || (node !== fn.body && /Function/.test(node.type))) return;
    if (node.type === 'ReturnStatement' && node.argument) values.push(node.argument);
    for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) if (child && typeof child.type === 'string') visit(child);
  })(fn.body);
  return values;
}
function bytes(info, node, depth = 0) {
  if (depth > 6) return false;
  if (node.type === 'NewExpression') return isGlobal(info, node.callee, typedArray);
  if (node.type === 'ArrayExpression') return node.elements.length === 1 && node.elements[0]?.type === 'SpreadElement' && bytes(info, node.elements[0].argument, depth + 1);
  if (node.type === 'CallExpression' && node.arguments.length === 1 && memberName(node.callee) === 'from' && isGlobal(info, node.callee.object, new Set(['Array']))) return bytes(info, node.arguments[0], depth + 1);
  if (node.type === 'Identifier') {
    const binding = info.lookup(node, node.name);
    return binding?.declaration === 'const' && Boolean(binding.node) && bytes(info, binding.node, depth + 1);
  }
  return false;
}
/** A parameter that receives the elements of a typed array (Array.from(bytes, fn), [...bytes].map(fn)). */
function byteParameter(info, binding) {
  if (binding.index !== 0) return false;
  const call = info.parents.get(binding.fn);
  if (call?.type !== 'CallExpression') return false;
  if (call.arguments[1] === binding.fn && memberName(call.callee) === 'from' && isGlobal(info, call.callee.object, new Set(['Array']))) return bytes(info, call.arguments[0]);
  return call.arguments[0] === binding.fn && ['map', 'forEach', 'filter', 'some', 'every', 'find', 'findIndex'].includes(memberName(call.callee)) && bytes(info, call.callee.object);
}
function nonFunction(info, node, depth = 0) {
  if (depth > 6) return false;
  switch (node.type) {
    case 'Literal': case 'TemplateLiteral': case 'BinaryExpression': case 'UnaryExpression': case 'UpdateExpression': case 'ArrayExpression': return true;
    case 'AwaitExpression': return nonFunction(info, node.argument, depth + 1);
    case 'NewExpression': return isGlobal(info, node.callee, instances) || isGlobal(info, node.callee, typedArray);
    case 'CallExpression': {
      const callee = node.callee;
      if (isGlobal(info, callee, valueCalls)) return true;
      if (memberName(callee) && callee.object.type === 'Identifier' && isGlobal(info, callee.object, new Set(Object.keys(valueStatics)))) {
        const methods = valueStatics[callee.object.name];
        return methods === null || methods.includes(memberName(callee));
      }
      // A repository function whose every return value is proven (async: the awaited value).
      const [fn, ...more] = resolveFunction(info, callee) ?? [];
      if (!fn || more.length) return false;
      const fnInfo = moduleInfo(fn.path), declaration = fn.node ?? fnInfo.program.bindings.get(fn.local)?.node;
      return Boolean(declaration) && returnValues(declaration).every(value => nonFunction(fnInfo, value, depth + 1));
    }
    case 'Identifier': {
      const binding = info.lookup(node, node.name);
      if (binding?.kind === 'param') return byteParameter(info, binding);
      // const, let or var: the initializer (undefined when absent) and every later assignment.
      if (!binding || !['const', 'let', 'var'].includes(binding.declaration)) return false;
      return (!binding.node || nonFunction(info, binding.node, depth + 1)) && (info.assignments.get(binding) ?? []).every(value => nonFunction(info, value, depth + 1));
    }
  }
  return false;
}

/** Serializations in the given files: resolved functions, refused forms and unproven toString calls. */
function serializationSites(files, {strict}) {
  const sites = [], refused = [], unproven = new Map();
  for (const path of files) {
    const info = moduleInfo(path);
    const at = node => `${path}:${node.loc.start.line}`;
    const add = (node, how) => {
      for (const fn of resolveFunction(info, node) ?? []) sites.push({file: at(node), how, fn});
    };
    walk(info.ast, (node, parent) => {
      if (memberName(node) === 'toString') {
        const called = parent?.type === 'CallExpression' && parent.callee === node;
        const fns = called ? resolveFunction(info, node.object) : null;
        if (fns) add(node.object, '.toString');
        else if (strict && !(called && nonFunction(info, node.object))) {
          const key = info.text.slice(node.start, node.end).replace(/\s+/g, '') + (called ? '()' : '');
          unproven.set(`${path}\t${key}`, [...(unproven.get(`${path}\t${key}`) ?? []), at(node)]);
        }
      }
      if (strict && node.type === 'ObjectPattern' && node.properties.some(p => p.type === 'Property' && keyName(p) === 'toString')) refused.push(`${at(node)} destructures toString`);
      if (node.type === 'TemplateLiteral') for (const expression of node.expressions) add(expression, 'template');
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'String') for (const argument of node.arguments) add(argument, 'String()');
      if (node.type === 'BinaryExpression' && node.operator === '+') { add(node.left, '+'); add(node.right, '+'); }
      if (node.type === 'AssignmentExpression' && node.operator === '+=') add(node.right, '+=');
      if (memberName(node) === 'concat') for (const argument of parent?.type === 'CallExpression' && parent.callee === node ? parent.arguments : []) add(argument, '.concat()');
      if (strict && node.type === 'ArrayExpression') for (const element of node.elements) if (element) add(element.type === 'SpreadElement' ? element.argument : element, 'array element');
    });
  }
  return {sites, refused, unproven};
}

test('every function serialized by a Worker-bundled file is listed for a canonical-text installer', () => {
  // The scan follows the bundles, not a directory list.
  for (const prefix of ['worker/', 'shared/', 'scripts/', 'src/shared/', 'vendor/', '.generated/']) assert(workerFiles.some(path => path.startsWith(prefix)), `no ${prefix} file in the Worker graph`);
  const {sites, refused, unproven} = serializationSites(workerFiles, {strict: true});
  const problems = [...refused];
  for (const {file, how, fn} of sites) {
    if (!fn.name) problems.push(`${file} ${how} ${fn.local}: not exported from ${fn.path}, so no installer can reach it; export it and list it in worker/runtime-canonical/functions.mjs`);
    else if (!installerOf.has(`${fn.path}#${fn.name}`)) problems.push(`${file} ${how} ${fn.path} ${fn.name}: missing from worker/runtime-canonical/functions.mjs`);
  }
  const counts = {};
  for (const [key, lines] of unproven) {
    const [path, call] = key.split('\t');
    (counts[path] ??= {})[call] = lines.length;
    if (reviewedToString[path]?.[call] !== lines.length) problems.push(`${lines.join(', ')} ${call}: toString on a value the scan cannot prove is not a function. ` +
      (call.endsWith('()') ? 'Serialize only a listed function, or add the call to reviewedToString after checking the receiver.' : 'Call x.toString() directly on a listed function instead.'));
  }
  for (const [path, calls] of Object.entries(reviewedToString)) for (const [call, count] of Object.entries(calls)) {
    if (counts[path]?.[call] !== count) problems.push(`${path} ${call}: reviewedToString expects ${count}, the scan found ${counts[path]?.[call] ?? 0}`);
  }
  assert.deepEqual(problems, [], 'Generated code would embed bundler-renamed source.');
  // Sanity: the scan finds the known compiler sites, so it cannot silently pass.
  const found = new Set(sites.map(site => `${site.fn.path}#${site.fn.name}`));
  for (const key of installerOf.keys()) assert(found.has(key), `${key} is listed but nothing serializes it; remove it from the list`);
  assert(sites.some(site => site.file.startsWith('worker/runtime-next/compiler.mjs:')), 'runtime-next compiler site not found');
  assert(sites.some(site => site.file.startsWith('worker/runtime-3211/storage-compiler.mjs:')), '3.21.1 storage compiler site not found');
});

// ---------------------------------------------------------------- Worker entries
/** GitHub path filter globs as regular expressions (** any path, * one segment). */
const pathFilter = glob => new RegExp('^' + glob.split('**').map(part => part.split('*').map(text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*') + '$');

test('each Worker entry imports first the installer for every serialized function it bundles', () => {
  const {sites} = serializationSites(workerFiles, {strict: false});
  for (const [entry, graph] of graphs) {
    const first = moduleInfo(entry).ast.body.find(node => node.type === 'ImportDeclaration');
    const installer = repoPath(resolve(root, dirname(entry), first.source.value));
    assert(installer in groups, `${entry} must import a canonical-text installer before any other module, not ${installer}`);
    for (const {file, fn} of sites) {
      if (!graph.has(file.replace(/:\d+$/, ''))) continue;
      const needed = installerOf.get(`${fn.path}#${fn.name}`);
      if (!needed) continue; // reported by the coverage test above
      assert(graph.has(needed), `${entry} bundles ${file}, which serializes ${fn.name}, but not ${needed}`);
    }
    if (installer.endsWith('install-test-workspace.mjs')) assert(graph.has('worker/runtime-canonical/install.mjs'));
  }
  // A change to any committed file of a Worker bundle must run the generation-parity job.
  const workflow = readFileSync(resolve(root, '.github/workflows/test-workspace.yml'), 'utf8');
  const block = /^ {2}pull_request:\n(?: {4}.*\n)*? {4}paths:\n((?: {6}- .*\n)+)/m.exec(workflow);
  assert(block, 'test-workspace.yml has no pull_request path filter');
  const filters = block[1].trim().split('\n').map(line => pathFilter(line.replace(/^\s*- /, '').trim()));
  const unfiltered = workerFiles.filter(path => !path.startsWith('.generated/') && !filters.some(filter => filter.test(path)));
  assert.deepEqual(unfiltered, [], 'Worker-bundled files outside the test-workspace.yml pull_request paths');
});

// ---------------------------------------------------------------- installed text
test('installed text is the unbundled source and no Worker code serializes an uncovered function', async () => {
  await import('../../worker/test-workspace/index.mjs');
  await import('../../worker/app-builtin-runtime-preview.ts');
  const {canonicalSources} = await import('../../.generated/browser-canonical-source.mjs');
  for (const [path, listed] of Object.entries({...runtimeFunctions, ...testWorkspaceFunctions})) {
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
