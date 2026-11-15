// TEST wording around A/B tests and saved versions: the Generate field is a "Version name", the home page links the A/B
// tests panel right after Bid caching, the panel says what is published and what TEST lacks, and the shared runtime.css
// (bundled into the Tanjug pilot) stays byte-for-byte as it was.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {workspacePage} from '../../worker/test-workspace/page.mjs';
const source=path=>readFile(new URL('../../'+path,import.meta.url),'utf8');
// sha256 of src/site-workspace/runtime.css at d950498 (the base of the A/B tests branch).
const RUNTIME_CSS_SHA256='c9efaec3854f7d026b68dfd7e9af12d12bcf67d371eb1f5933fd49f3cdec2a69';

test('Generate asks for a version name, on the workspace panel and the TEST home page',async()=>{
 const panel=await source('src/components/SitePackagesPanel.tsx');
 assert.doesNotMatch(panel,/What changed\?/);
 assert.doesNotMatch(panel,/Short release note/);
 assert.match(panel,/<label>Version name<input maxLength=\{160\} value=\{notes\}[^\n]*?placeholder="For example: Bid cache 60 s"\/><\/label>/);
 const page=workspacePage('tester@example.invalid');
 assert.match(page,/<label for="note">Version name \(optional\)<\/label><input id="note" maxlength="160"/);
 assert.doesNotMatch(page,/Version note/);
 assert.match(await source('worker/site-runtime/releases.mjs'),/'Use a version name of up to 160 characters\.'/);
 assert.match(await source('worker/test-workspace/index.mjs'),/keep the version name within 160 characters\./);
});

test('the TEST home page links the A/B tests panel right after Bid caching',()=>{
 const page=workspacePage('tester@example.invalid');
 assert.match(page,/<a class="button" href="\/site-workspace#bid-cache">Bid caching<\/a><a class="button" href="\/site-workspace#ab-tests">A\/B tests<\/a>/);
});

test('the workspace opens #ab-tests in Generate and releases, below Saved versions, with delivery by ZIP only',async()=>{
 const entry=await source('src/site-workspace/test-entry.tsx');
 assert.match(entry,/if \(hash === 'ab-tests'\) return 'packages';/);
 assert.match(entry,/<SitePackagesPanel publisherId="test-site"[^]*?\/><AbTestsPanel publisherId="test-site" endpoint="\/test-api\/ab-tests" testOnly refreshKey=\{packagesChanged\}\/>/);
 assert.doesNotMatch(entry,/deploymentsHref/);
 assert.match(entry,/import '\.\/test-workspace\.css';/);
 assert.match(entry,/import '\.\.\/components\/ab-tests\.css';/);
});

test('the A/B tests panel states what is published, what TEST lacks and how GAM is set up',async()=>{
 const panel=await source('src/components/AbTestsPanel.tsx');
 for(const sentence of [
  'The test name, the TestId and both version names are published inside /ads.js. Do not use private notes.',
  'This site has no production version on TEST. Choose A yourself: use the version your test page runs now.',
  'Lowercase letters, digits and _. Each TestId is used once on this site and stays reserved.',
  'A/A check: both groups get the same version.',
  'Download the ZIP and upload all of its files, unchanged, as one Pages deployment.',
  '(no longer in Saved versions; this test keeps its own copy)',
  'No differences in the compared settings.',
  'Turn on reporting for both keys.',
  'GAM does not report traffic from before this setup.',
 // A passing check says the versions can be compared and, while Save is disabled, which field blocks it.
 'Compatible. These versions can be compared.',
 'Enter a test name to save.',
 'Use 1 to 24 lowercase letters, digits or _ in the TestId to save.',
 'Use a whole number from 0 to 100 for traffic to save.',
 'For lists, each side shows only what it has and the other version does not.',
 // How to stop a test delivered by hand, and that Delete does not stop one.
 "To stop a test, upload version A's own saved ZIP from Saved versions to the same Pages project again, or roll back that Pages deployment. Then use Mark stopped.",
 ' This test is marked live. Deleting it does not stop it on your site.',
 'Finish the GAM setup checklist first.',
 // A failed read of one test offers its own Retry; no message points to a button that is not there.
 'Could not read this A/B test. Retry.',
 '<button disabled={busy} onClick={()=>void loadDetail(test.id)}>Retry</button>',
 ])assert(panel.includes(sentence),sentence);
 for(const text of ['You can save this A/B test','what the other version lacks','this A/B test. Reload A/B tests.'])assert(!panel.includes(text),text);
 assert.match(panel,/<li>Key <code>Variant<\/code> with the values <code>A<\/code> and <code>B<\/code>\.<\/li>/);
 assert.match(panel,/<li>Key <code>TestId<\/code> with the value <code>\{test\.testId\}<\/code>\.<\/li>/);
 // No production menus, no preview-publish link in this PR, and no second "Download saved ZIP" button in the view.
 for(const text of ['Config →','Releases →','Publish to TEST preview','deploymentsHref','Download saved ZIP'])assert(!panel.includes(text),text);
 // React only: no worker module reaches the browser bundle.
 assert.deepEqual([...panel.matchAll(/^import .* from '([^']+)';$/gm)].map(match=>match[1]),['react']);
});

test('the panel never puts role=status on .runtime-message or .runtime-error',async()=>{
 const panel=await source('src/components/AbTestsPanel.tsx');
 assert.doesNotMatch(panel,/role=\{/,'roles are literal, so this scan sees every one');
 const tags=[];
 for(let at=panel.indexOf('role="status"');at>=0;at=panel.indexOf('role="status"',at+1)){
  let end=at;
  // The end of the tag: a > that is not the arrow of a function inside an attribute.
  while((end=panel.indexOf('>',end+1))>=0&&panel[end-1]==='=');
  tags.push(panel.slice(panel.lastIndexOf('<',at),end+1));
 }
 assert(tags.length>=3,'the loading line, the action notices and the check result are status lines');
 for(const tag of tags){
  assert.match(tag,/className=(?:"ab-tests-status|\{checked\.compatible\?'ab-tests-status')/,tag);
  assert.doesNotMatch(tag,/runtime-(?:message|error)/,tag);
 }
 for(const match of panel.matchAll(/className="runtime-error"/g)){
  const tag=panel.slice(panel.lastIndexOf('<',match.index),panel.indexOf('>',match.index)+1);
  assert.match(tag,/role="alert"/,tag);
 }
});

test('runtime.css, which the Tanjug pilot bundles, is unchanged; the TEST wrap rules live in test-workspace.css',async()=>{
 const css=await readFile(new URL('../../src/site-workspace/runtime.css',import.meta.url));
 assert.equal(createHash('sha256').update(css).digest('hex'),RUNTIME_CSS_SHA256);
 assert.match(await source('src/site-workspace/test-workspace.css'),/\.runtime-release strong,\.runtime-message,\.runtime-error\{overflow-wrap:anywhere\}/);
 const pilot=await source('src/site-workspace/named-script-test-entry.tsx');
 assert.doesNotMatch(pilot,/test-workspace\.css|ab-tests\.css|AbTestsPanel/);
 const css2=await source('src/components/ab-tests.css');
 for(const rule of css2.replace(/\/\*[^]*?\*\//g,'').split('}').map(part=>part.trim()).filter(Boolean)){
  const body=rule.replace(/^@media[^{]*\{\s*/,''),selectors=body.slice(0,body.indexOf('{')).trim();
  for(const selector of selectors.split(/,(?![^(]*\))/))assert.match(selector.trim(),/^\.ab-tests-panel\b/,`ab-tests.css rule not scoped to the panel: ${selector}`);
 }
});
