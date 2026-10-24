/** Local fixtures from the checked reference and actual legacy CSS producer.
 * Generated code is never served to a publisher and uses synthetic GPT only.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parse } from 'acorn';
import assert from 'node:assert/strict';
import ts from '../tools/node_modules/typescript/lib/typescript.js';
import { buildReference391 } from '../.generated/reference391.mjs';
import { compileRuntime } from '../worker/runtime-compiler.ts';
import { compileReferenceBuild } from '../worker/runtime/reference-bridge.mjs';
import { fixture } from '../tests/runtime/bridge-fixture.mjs';
import { patchLegacyStickyPortal, patchLegacyStickyPortalCss } from '../worker/legacy-sticky-portal.mjs';

const f = fixture();
f.options.enablePrebid = false;
f.options.floors.enabled = false;
f.options.takeOver.enabled = false;
const source = compileReferenceBuild(f.core, f.options, { buildReference391, compileRuntime }).adsJs;
const parsed = parse(source, { ecmaVersion: 'latest' });
function flatten(root) {
  const result = [], pending = [root];
  while (pending.length) {
    const node = pending.pop(); result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) { if (child && typeof child.type === 'string') pending.push(child); }
      else if (value && typeof value.type === 'string') pending.push(value);
    }
  }
  return result;
}
const declarations = flatten(parsed).filter(n => n.type === 'VariableDeclarator' && n.id.name === 'ALLOW_CLOSE_PORTAL');
if (declarations.length !== 1) throw Error('The actual reference portal variable needs review.');
const value = declarations[0].init;
const enabled = source.slice(0, value.start) + 'true' + source.slice(value.end);
const cssSource = ts.transpileModule(await readFile('worker/releases.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const cssAst = parse(cssSource, { ecmaVersion: 'latest', sourceType: 'module' });
const names = ['isRecord', 'cssEscape', 'cssCommentText', 'stickyCss'];
const cssFunctions = cssAst.body.filter(n => n.type === 'FunctionDeclaration' && names.includes(n.id.name));
if (cssFunctions.length !== names.length) throw Error('Legacy CSS helper structure changed.');
// Executes only trusted repository functions, never uploaded scripts or advertiser content.
const cssProducer = Function('patchLegacyStickyPortalCss', cssFunctions.map(n => cssSource.slice(n.start, n.end)).join('\n') + ';return stickyCss;');
const cssInput = { site: { name: 'Local portal test', domain: 'example.invalid' }, config: {
  runtimeControls: { sticky: { bottomAdUnitId: 'Sticky', topAdUnitId: '', allowClosePortal: true } },
}, adUnits: [{ code: 'Sticky', enabled: 1 }] };
// Isolate the baseline appearance from the new repair. The positive fixture
// comes from the actual producer with its real helper, not a copied CSS string.
const css = cssProducer(source => source)(cssInput);
const fixedCss = cssProducer(patchLegacyStickyPortalCss)(cssInput);
assert.equal(fixedCss, patchLegacyStickyPortalCss(css, true));
const directory = '.generated/legacy-portal-evidence';
await mkdir(directory, { recursive: true });
for (const [name, content] of Object.entries({ 'original.js': enabled, 'fixed.js': patchLegacyStickyPortal(enabled, true),
  'original.css': css, 'fixed.css': fixedCss })) await writeFile(directory + '/' + name, content);
console.log('Prepared actual reference output and legacy CSS for local portal browser checks.');
