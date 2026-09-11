/** Persist generated packages to local SQLite + simulated R2, exit/reopen in a
 * separate process, and export ONLY the re-read bytes for browser regression.
 * No Cloudflare account, secrets, live publisher or network access is involved.
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { isolatedStore } from '../tests/support/isolated-draft-store.mjs';
import { saveDraftRelease, readDraftRelease } from '../worker/runtime/draft-release-store.mjs';
const source = resolve(process.argv[2] || '.generated/artifact-candidate-verification');
const output = resolve(process.argv[3] || '.generated/stored-draft-verification');
const reopen = process.argv[4] === '--reopen';
const databasePath = join(output,'isolated-drafts.sqlite');
const escapeHtml = (s) => String(s).replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
globalThis.fetch = () => { throw new Error('Verification must not access any external network.'); };
await mkdir(output,{ recursive: true });
async function readPackage(folder) {
  const files = Object.create(null);
  for (const name of await readdir(folder)) files[name] = new Uint8Array(await readFile(join(folder,name)));
  return { files };
}
if (!reopen) {
  const f=isolatedStore({databasePath});
  const cases=[];
  for (const name of (await readdir(join(source,'packages'))).sort()) {
    const candidate=await readPackage(join(source,'packages',name));
    const result=await saveDraftRelease(f.store,{siteId:'test-site',candidate,actor:'offline-verifier@example.invalid',note:`Offline test: ${name}`});
    cases.push({name,id:result.draft.id});
  }
  assert.equal(f.count('releases'),new Set(cases.map((c)=>c.id)).size);
  // R2 is a test double. Its actual object bytes are persisted locally for process restart.
  const keys=[...f.objects.keys()];
  for (const key of keys) {
    const path=join(output,'objects',key);await mkdir(resolve(path,'..'),{recursive:true});
    await writeFile(path,f.objects.get(key));
  }
  await writeFile(join(output,'restart-index.json'),JSON.stringify({cases,keys}));
  f.close();
  const child=spawnSync(process.execPath,['--experimental-strip-types',fileURLToPath(import.meta.url),source,output,'--reopen'],{encoding:'utf8'});
  process.stdout.write(child.stdout || '');process.stderr.write(child.stderr || '');
  if(child.status!==0) process.exit(child.status || 1);
} else {
  const index=JSON.parse(await readFile(join(output,'restart-index.json'),'utf8'));
  const objects=new Map();
  for(const key of index.keys) {
    assert.match(key,/^publishers\/test-site\/releases\/builtin-draft-[a-f0-9]{64}\/[A-Za-z0-9.-]+$/);
    objects.set(key,new Uint8Array(await readFile(join(output,'objects',key))));
  }
  const f=isolatedStore({databasePath,persistedObjects:objects});
  f.bucket.put=()=>assert.fail('Reopening a draft must not regenerate/write files.');
  const cases=[];const cards=[];
  for(const entry of index.cases) {
    const result=await readDraftRelease(f.store,{siteId:'test-site',releaseId:entry.id});assert(result);
    const original=await readPackage(join(source,'packages',entry.name));
    for(const [name,bytes]of Object.entries(original.files))assert.deepEqual(result.files[name],bytes,`${entry.name}/${name}`);
    const folder=join(output,'reopened','packages',entry.name);await mkdir(folder,{recursive:true});
    for(const [name,bytes]of Object.entries(result.files))await writeFile(join(folder,name),bytes);
    for(const [variant,file]of [['readable','ads.js'],['minified','ads.min.js']]) {
      await mkdir(join(output,'reopened',variant),{recursive:true});
      await writeFile(join(output,'reopened',variant,`${entry.name}.js`),result.files[file]);
    }
    cases.push({name:entry.name,passed:true,releaseId:entry.id,files:result.draft.fileCount,
      runtimeVersion:result.draft.runtime.runtimeVersion,packageSha256:result.draft.packageSha256,
      prebid:result.draft.prebidBuild?.version??'GPT-only',publishable:false,byteSize:result.draft.byteSize});
    cards.push(`<tr><td>${escapeHtml(entry.name)}</td><td>${result.draft.fileCount}</td><td>${escapeHtml(result.draft.runtime.runtimeVersion)}</td><td>${escapeHtml(result.draft.prebidBuild?.version??'GPT-only')}</td><td>PASS</td></tr>`);
  }
  assert(f.log.sql.every((sql)=>sql.startsWith('SELECT ')));
  assert.equal(f.count('audit_log'),new Set(index.cases.map((c)=>c.id)).size);
  assert.equal(f.sqlite.prepare("SELECT current_release_id FROM publishers WHERE id='test-site'").get().current_release_id,null);
  f.close();
  const report={passed:cases.length,failed:0,registeredPackages:new Set(cases.map((c)=>c.releaseId)).size,
    scope:'Actual SQLite persisted to local disk, restarted in another Node process; simulated R2 reloaded from exact local files. Real stored-draft adapter and generated candidates. Not hosted D1/R2 or production acceptance.',
    noPublication:true,noRemoteRequests:true,cases};
  for(const variant of ['readable','minified'])await writeFile(join(output,'reopened',variant,'generation-report.json'),JSON.stringify(report,null,2));
  await writeFile(join(output,'stored-draft-report.json'),JSON.stringify(report,null,2));
  const html=`<!doctype html><html lang="sr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Tessera — test snimanja release-a</title><style>body{font:16px/1.6 system-ui;margin:0;background:#f1f4f8;color:#182335}main{max-width:1000px;margin:48px auto;padding:32px;background:white;border-radius:16px}h1{margin:0 0 16px}table{border-collapse:collapse;width:100%;margin-top:24px}td,th{padding:10px;text-align:left;border-bottom:1px solid #ddd}strong{color:#14753e}.note{padding:16px;background:#fff4e8;border-radius:8px}small{color:#64748b}@media(max-width:700px){main{margin:12px;padding:18px}table{font-size:12px}td,th{padding:6px}}</style></head><body><main><small>TESSERA · AUTOMATIZOVANA PROVERA · 11.09.2026.</small><h1>Sačuvan paket ostaje isti posle ponovnog pokretanja</h1><p><strong>${cases.length}/${cases.length} scenarija uspešno sačuvano i ponovo pročitano.</strong> Proveren je svaki bajt skripti, CSS-a, konfiguracije i Prebida. Identični paketi ne stvaraju novu kopiju.</p><p class="note">Ovo je izveštaj iz izolovanog lokalnog testa, ne ekran live platforme. SQLite baza je stvarna; R2 je simuliran. Ništa nije objavljeno. Ova stranica nema JavaScript ni pristup oglasnim mrežama.</p><table><thead><tr><th>Scenario</th><th>Fajlova</th><th>Runtime</th><th>Prebid</th><th>Rezultat</th></tr></thead><tbody>${cards.join('')}</tbody></table><p><small>Dalje: isti ponovo učitani ads.js i ads.min.js prolaze zasebnu browser proveru u CI-ju. Hosted preview i objava na drugi Cloudflare nalog još nisu potvrđeni.</small></p></main></body></html>`;
  await writeFile(join(output,'report.html'),html);
  console.log(JSON.stringify(report,null,2));
}
