/** Release records are append-only; a new engine build needs a new version. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const path='worker/runtime/runtime-releases.json';
const legacyVersion='3.9.1-tessera.preview.2';
const legacyHashes=new Set([
  '222569881b377c085f0b5d373523d092d64e2ac5dab05d421c3cc9f371078de9',
  '71fddef7fb9e7c3a23eca8a1098776e0b1c4c7e299e2cc5766e8a649e7e94939'
]);
const identity=r=>[r.id,r.version,r.codeSha256].join('/');
export function checkRuntimeReleaseHistory(current,previous){
  assert(Array.isArray(current)&&current.length>0&&current.length<=100,'An explicit runtime history is required');
  const identities=new Set(),versions=new Set();
  for(const r of current){
    assert(/^[a-zA-Z0-9._-]{1,96}$/.test(r.id),'Runtime ID required');
    assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(r.version),'Exact runtime version required');
    assert(/^[a-f0-9]{64}$/.test(r.codeSha256),'Source checksum required');
    assert(/^[a-f0-9]{40}$/.test(r.sourceCommit),'Source commit required');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&!Number.isNaN(Date.parse(r.date)),'Release date required');
    assert(typeof r.title==='string'&&r.title.trim().length>0&&r.title.length<=160,'Release title required');
    assert(Array.isArray(r.changes)&&r.changes.length>0&&r.changes.length<=12&&r.changes.every(x=>typeof x==='string'&&x.trim().length>0&&x.length<=600),'Change notes required');
    assert(['preview','stable'].includes(r.channel),'Explicit release channel required');
    assert(!identities.has(identity(r)),'Duplicate runtime build');identities.add(identity(r));
    if(versions.has(r.version))assert(r.version===legacyVersion&&legacyHashes.has(r.codeSha256),'A new engine build requires a new version number');
    if(r.version===legacyVersion)assert(legacyHashes.has(r.codeSha256),'Do not reuse the historical preview.2 number');
    versions.add(r.version);
  }
  if(previous===null){
    assert.equal(current.length,2,'Only the two verified historical builds can initialize this register');
    assert(current.every(r=>r.version===legacyVersion&&legacyHashes.has(r.codeSha256)),'Unexpected history initialization');
  }else{
    assert(Array.isArray(previous)&&previous.length,'Previous history is required');
    for(const old of previous)assert.deepEqual(current.find(r=>identity(r)===identity(old)),old,'Keep every existing runtime release record unchanged');
    const oldVersions=new Set(previous.map(r=>r.version));
    for(const r of current)if(!previous.some(old=>identity(old)===identity(r)))assert(!oldVersions.has(r.version),'An upgrade must use a new version number');
    const retained=current.filter(r=>previous.some(old=>identity(old)===identity(r)));
    assert.deepEqual(retained,previous,'Keep historical release order');
    const added=current.length-previous.length;
    assert.deepEqual(current.slice(added),previous,'New releases go before the retained history');
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const base=process.argv[2]||'HEAD^';
  // ls-tree failing means the comparison revision is unavailable, not empty history.
  const listed=execFileSync('git',['ls-tree','--name-only',base,'--',path],{encoding:'utf8'}).trim();
  const previous=listed?JSON.parse(execFileSync('git',['show',`${base}:${path}`],{encoding:'utf8'})):null;
  const current=JSON.parse(await readFile(path,'utf8'));
  checkRuntimeReleaseHistory(current,previous);
  console.log(`Runtime history checked: ${current.length} records; existing entries preserved.`);
}
