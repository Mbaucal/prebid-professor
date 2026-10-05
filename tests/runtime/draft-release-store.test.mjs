import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArtifactCandidate } from '../../worker/runtime/artifact-candidate.mjs';
import { describeCandidate,saveDraftRelease,readDraftRelease } from '../../worker/runtime/draft-release-store.mjs';
import { isStoredBuiltinDraft } from '../../worker/runtime/stored-draft-safety.mjs';
import { fixture,configure,pin,checkedFixture,TS,takeOver } from './artifact-fixture.mjs';
import { isolatedStore } from '../support/isolated-draft-store.mjs';
import { sha256 } from '../../worker/runtime/prebid-artifact-check.mjs';
const encoder=new TextEncoder(),decoder=new TextDecoder();
async function build(enabled=true,timestamp=TS) {
  const snapshot=configure(fixture(),(c)=>{c.enablePrebid=enabled;});
  return buildArtifactCandidate({snapshot,pin:pin(),prebid:await checkedFixture(snapshot),takeOver:takeOver(),buildTimestamp:timestamp});
}
const standard=await build();
const gptOnly=await build(false);
const candidate=()=>structuredClone(standard);
function setup(t,c=candidate()) {
  const f=isolatedStore();t.after(()=>f.close());
  return {...f,candidate:c,save:(extra={})=>saveDraftRelease(f.store,{siteId:'test-site',candidate:c,actor:'test@example.invalid',...extra}),
    read:(releaseId,siteId='test-site')=>readDraftRelease(f.store,{siteId,releaseId})};
}
function corrupt(bytes) { const copy=bytes.slice();copy[0]^=1;return copy; }
async function editConfig(c,mutate) {
  const cfg=JSON.parse(decoder.decode(c.files['config.json']));mutate(cfg);
  c.files['config.json']=encoder.encode(JSON.stringify(cfg)+'\n');
  const m=JSON.parse(decoder.decode(c.files['manifest.json']));
  m.files['config.json']={byteSize:c.files['config.json'].length,sha256:await sha256(c.files['config.json'])};
  c.files['manifest.json']=encoder.encode(JSON.stringify(m)+'\n');
}

test('registers one immutable draft in the EXISTING releases table with exact byte roundtrip',async(t)=>{
  const f=setup(t);const result=await f.save();assert.equal(result.created,true);
  assert.equal(result.draft.publishable,false);assert.equal(result.draft.completeRelease,false);
  assert.equal(f.count('releases'),1);assert.equal(f.count('audit_log'),1);
  const read=await f.read(result.draft.id);
  for(const [name,bytes] of Object.entries(f.candidate.files))assert.deepEqual(read.files[name],bytes,name);
  assert.equal(read.draft.runtime.runtimeSha256,pin().runtimeSha256);
  assert.equal(read.draft.prebidBuild.sha256,standard.manifest.prebidBuild.sha256);
  assert.equal(f.count('builtin_draft_assertions'),0);
});
test('does not change the site configuration, current release or any channel',async(t)=>{
  const f=setup(t);const before=f.sqlite.prepare('SELECT * FROM publishers').all();
  const configs=f.sqlite.prepare('SELECT * FROM publisher_configs').all();await f.save();
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM publishers').all(),before);
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM publisher_configs').all(),configs);
  assert(f.log.puts.every((key)=>!key.includes('/current/')&&!key.includes('/staging/')));
});
test('repeated save of the same package is idempotent, including note/actor provenance',async(t)=>{
  const f=setup(t);const first=await f.save({note:'Reviewed'});const puts=f.log.puts.length;
  const second=await f.save({note:'Different',actor:'other@example.invalid'});
  assert.equal(second.created,false);assert.equal(second.draft.id,first.draft.id);
  assert.equal(second.draft.note,'Reviewed');assert.equal(second.draft.createdBy,'test@example.invalid');
  assert.equal(f.count('releases'),1);assert.equal(f.count('audit_log'),1);assert.equal(f.log.puts.length,puts);
});
test('two simultaneous saves register exactly one release and one audit row',async(t)=>{
  const f=setup(t);const results=await Promise.all([f.save(),f.save()]);
  assert.equal(results.filter((r)=>r.created).length,1);
  assert.equal(results[0].draft.id,results[1].draft.id);assert.equal(f.count('releases'),1);assert.equal(f.count('audit_log'),1);
});
test('a second package does not modify the first one',async(t)=>{
  const f=setup(t);const first=await f.save();const next=await build(true,'20260911_120100');
  const second=await f.save({candidate:next});assert.notEqual(second.draft.id,first.draft.id);
  assert.equal(f.count('releases'),2);const old=await f.read(first.draft.id);assert.deepEqual(old.files['ads.js'],standard.files['ads.js']);
});
test('GPT-only saves nine files and no Prebid key/pin',async(t)=>{
  const f=setup(t,structuredClone(gptOnly));const result=await f.save();const read=await f.read(result.draft.id);
  assert.equal(read.draft.fileCount,9);assert.equal(read.draft.prebidBuild,null);assert(!read.files['prebid.js']);
  assert.equal(f.sqlite.prepare('SELECT prebid_js_key FROM releases').get().prebid_js_key,null);
});
test('another site cannot read a saved package or cause an R2 read',async(t)=>{
  const f=setup(t);const result=await f.save();const n=f.log.gets.length;
  assert.equal(await f.read(result.draft.id,'other-site'),null);assert.equal(f.log.gets.length,n);
});
test('package for another site is rejected before SQL or R2 writes',async(t)=>{
  const f=setup(t);await assert.rejects(f.save({siteId:'other-site'}),/manifest/);
  assert.equal(f.count('builtin_draft_uploads'),0);assert.equal(f.log.puts.length,0);
});
for(const value of ['../test-site','test-site/other','',undefined])test(`invalid site ID ${value}`,async(t)=>{
  const f=setup(t);await assert.rejects(f.save({siteId:value}),/site ID/);assert.equal(f.log.puts.length,0);
});
test('explicit isolated-store guard prevents implicit production bindings',async()=>{
  const production={get DB(){assert.fail('Production DB accessed');},get BUILDS(){assert.fail('Production R2 accessed');}};
  await assert.rejects(saveDraftRelease(production,{siteId:'test-site',candidate:standard,actor:'test@example.invalid'}),/isolated/);
});
test('requires a primary sequential D1 session',async(t)=>{
  const f=setup(t);delete f.db.withSession;await assert.rejects(f.save(),/session/);assert.equal(f.log.puts.length,0);
});
test('an invalid actor/note never writes a reservation',async(t)=>{
  const f=setup(t);await assert.rejects(f.save({actor:''}),/actor/);await assert.rejects(f.save({note:'x'.repeat(161)}),/note/);
  assert.equal(f.count('builtin_draft_uploads'),0);
});
test('missing site never uploads anything',async(t)=>{
  const f=setup(t);f.sqlite.exec("DELETE FROM publishers WHERE id='test-site'");await assert.rejects(f.save(),/Site not found/);assert.equal(f.objects.size,0);
});
test('extra filenames and traversal paths are rejected',async(t)=>{
  const f=setup(t);f.candidate.files['../secrets']=new Uint8Array([1]);await assert.rejects(f.save(),/file set/);assert.equal(f.count('releases'),0);
});
test('missing file is not accepted as a smaller valid release',async(t)=>{
  const f=setup(t);delete f.candidate.files['sticky.css'];await assert.rejects(f.save(),/file set/);
});
test('checks serialized manifest instead of a mutable manifest property',async(t)=>{
  const f=setup(t);f.candidate.manifest={siteId:'malicious'};const result=await f.save();assert.equal(result.draft.siteId,'test-site');
});
test('mutated output bytes cannot reuse an old manifest',async(t)=>{
  const f=setup(t);f.candidate.files['ads.min.js']=corrupt(f.candidate.files['ads.min.js']);await assert.rejects(f.save(),/checksum/);assert.equal(f.objects.size,0);
});
test('mismatched runtime/config pin is rejected even with updated file hash',async(t)=>{
  const f=setup(t);await editConfig(f.candidate,(c)=>{c.runtime.runtimeSha256='0'.repeat(64);});await assert.rejects(f.save(),/identity mismatch/);
});
test('a Prebid pin cannot be silently dropped',async(t)=>{
  const f=setup(t);await editConfig(f.candidate,(c)=>{c.prebidBuild=null;});await assert.rejects(f.save(),/Prebid/);
});
test('input byte arrays are defensively copied before async work',async(t)=>{
  const f=setup(t);const work=f.save();f.candidate.files['ads.js'][0]^=1;
  const result=await work;const read=await f.read(result.draft.id);assert.deepEqual(read.files['ads.js'],standard.files['ads.js']);
});
test('failed R2 write leaves a recoverable intent and no visible release',async(t)=>{
  const f=setup(t);f.faults.failPutName='manifest.json';await assert.rejects(f.save(),/write failure/);
  assert.equal(f.count('releases'),0);assert.equal(f.count('audit_log'),0);assert.equal(f.count('builtin_draft_uploads'),1);assert(f.objects.size>0);
  const id=(await describeCandidate('test-site',f.candidate)).descriptor.releaseId;assert.equal(await f.read(id),null);
  f.faults.failPutName='';const retry=await f.save();assert.equal(f.count('releases'),1);assert(await f.read(retry.draft.id));
});
test('lost reservation response can be retried without duplicate intent',async(t)=>{
  const f=setup(t);f.faults.afterIntent=true;await assert.rejects(f.save(),/lost after intent/);assert.equal(f.objects.size,0);
  f.faults.afterIntent=false;await f.save();assert.equal(f.count('builtin_draft_uploads'),1);assert.equal(f.count('releases'),1);
});
test('SQL failure before commit retains files and retries safely',async(t)=>{
  const f=setup(t);f.faults.batchBefore=true;await assert.rejects(f.save(),/before commit/);
  assert.equal(f.count('releases'),0);assert.equal(f.objects.size,10);f.faults.batchBefore=false;
  await f.save();assert.equal(f.count('releases'),1);assert.equal(f.count('audit_log'),1);
});
test('lost SQL success response NEVER deletes a successfully committed package',async(t)=>{
  const f=setup(t);f.faults.batchAfter=true;await assert.rejects(f.save(),/after commit/);
  assert.equal(f.count('releases'),1);assert.equal(f.objects.size,10);f.faults.batchAfter=false;
  const retry=await f.save();assert.equal(retry.created,false);assert.equal(f.count('audit_log'),1);assert(await f.read(retry.draft.id));
});
test('audit failure rolls registration/state back atomically',async(t)=>{
  const f=setup(t);f.sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'test audit failure'); END;");
  await assert.rejects(f.save(),/audit failure/);assert.equal(f.count('releases'),0);assert.equal(f.count('builtin_draft_assertions'),0);
  assert.equal(f.sqlite.prepare('SELECT state FROM builtin_draft_uploads').get().state,'uploading');assert.equal(f.objects.size,10);
  f.sqlite.exec('DROP TRIGGER reject_audit');await f.save();assert.equal(f.count('releases'),1);
});
test('a conflicting registered record is rejected; no silent overwrite',async(t)=>{
  const f=setup(t);const id=(await describeCandidate('test-site',f.candidate)).descriptor.releaseId;
  f.sqlite.prepare("INSERT INTO releases(id,publisher_id,version,status)VALUES(?,?,?,'production')").run(id,'other-site','unrelated');
  await assert.rejects(f.save(),/CHECK constraint/);assert.equal(f.count('audit_log'),0);
  assert.equal(f.sqlite.prepare('SELECT status FROM releases WHERE id=?').get(id).status,'production');
});
test('stored corrupted bytes are not overwritten by a repeated save',async(t)=>{
  const f=setup(t);const result=await f.save();const key=[...f.objects.keys()].find((k)=>k.endsWith('/ads.js'));f.objects.set(key,corrupt(f.objects.get(key)));
  const puts=f.log.puts.length;await assert.rejects(f.save(),/checksum/);await assert.rejects(f.read(result.draft.id),/checksum/);assert.equal(f.log.puts.length,puts);
});
test('missing bytes in a ready draft are not silently regenerated',async(t)=>{
  const f=setup(t);const result=await f.save();f.objects.delete([...f.objects.keys()].find((k)=>k.endsWith('/prebid.js')));
  await assert.rejects(f.save(),/missing/);await assert.rejects(f.read(result.draft.id),/missing/);
});
test('R2 read failure does not delete or replace any package',async(t)=>{
  const f=setup(t);const result=await f.save();f.faults.failGetName='ads.js';await assert.rejects(f.read(result.draft.id),/read failure/);
  assert.equal(f.objects.size,10);f.faults.failGetName='';assert(await f.read(result.draft.id));
});
test('read path uses only SELECTs, and does not regenerate latest source',async(t)=>{
  const f=setup(t);const result=await f.save();f.log.sql.length=0;const puts=f.log.puts.length;
  const before=globalThis.fetch;globalThis.fetch=()=>assert.fail('No network');
  try{await f.read(result.draft.id);}finally{globalThis.fetch=before;}
  assert(f.log.sql.every((sql)=>sql.startsWith('SELECT ')));assert.equal(f.log.puts.length,puts);
});
test('descriptor path traversal cannot read another object',async(t)=>{
  const f=setup(t);const result=await f.save();const row=f.sqlite.prepare('SELECT descriptor_json FROM builtin_draft_uploads').get();
  const d=JSON.parse(row.descriptor_json);d.files[0].name='../other';f.sqlite.prepare('UPDATE builtin_draft_uploads SET descriptor_json=?').run(JSON.stringify(d));
  const n=f.log.gets.length;await assert.rejects(f.read(result.draft.id),/file names/);assert.equal(f.log.gets.length,n);
});
test('generic release metadata changes are not accepted as the saved draft',async(t)=>{
  const f=setup(t);const result=await f.save();f.sqlite.exec("UPDATE releases SET ads_js_key='other-key'");
  const n=f.log.gets.length;await assert.rejects(f.read(result.draft.id),/metadata mismatch/);assert.equal(f.log.gets.length,n);
});
test('audit contains identities/counts but never full configuration or JS',async(t)=>{
  const f=setup(t);await f.save();const row=f.sqlite.prepare('SELECT details_json FROM audit_log').get();
  assert.equal(JSON.parse(row.details_json).publishable,false);assert(!row.details_json.includes('bidders'));assert(row.details_json.length<500);
});
test('reserved draft guard covers both identifier and version without blocking legacy releases',()=>{
  assert(isStoredBuiltinDraft({id:'builtin-draft-anything'}));assert(isStoredBuiltinDraft({id:'uuid',version:'builtin-draft-example'}));
  assert(!isStoredBuiltinDraft({id:'uuid',version:'20260911_120000'}));assert(!isStoredBuiltinDraft(null));
});
