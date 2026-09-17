/** Release records are append-only; a new engine build needs a new version. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
const path='worker/runtime/runtime-releases.json';
const legacyVersion='3.9.1-tessera.preview.2';
const legacyHashes=new Set([
  '222569881b377c085f0b5d373523d092d64e2ac5dab05d421c3cc9f371078de9',
  '71fddef7fb9e7c3a23eca8a1098776e0b1c4c7e299e2cc5766e8a649e7e94939'
]);
const identity=r=>[r.id,r.version,r.codeSha256].join('/');
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const readGitSource=(commit,path)=>{
  assert.equal(execFileSync('git',['cat-file','-t',commit],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim(),'commit','Source reference must be a commit');
  return execFileSync('git',['show',`${commit}:${path}`],{maxBuffer:4*1024*1024,stdio:['ignore','pipe','pipe']});
};

/** Read declarations as data, never execute code from a recorded source commit. */
export function verifyRuntimeReleaseProvenance(releases,readSource=readGitSource){
  for(const release of releases){
    assert(/^[a-f0-9]{40}$/.test(release.sourceCommit),'Exact source commit required');
    const declarations=[];
    function visit(node){
      if(!node||typeof node!=='object')return;
      if(node.type==='VariableDeclarator'&&['sourceFiles','MODULE_SHA256'].includes(node.id?.name))declarations.push(node);
      for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else if(value&&typeof value==='object')visit(value);
    }
    const manifest=release.sourceManifest??'scripts/prepare-builtin-runtime.mjs';
    assert(['scripts/prepare-builtin-runtime.mjs','scripts/prepare-next-runtime.mjs','scripts/prepare-observed-runtime.mjs'].includes(manifest),'Known source manifest required');
    visit(parse(readSource(release.sourceCommit,manifest).toString('utf8'),{ecmaVersion:'latest',sourceType:'module'}));
    const files=declarations.filter(d=>d.id.name==='sourceFiles'),module=declarations.filter(d=>d.id.name==='MODULE_SHA256');
    assert(files.length===1&&files[0].init?.type==='ArrayExpression','Recorded source closure must declare one literal file list');
    assert(module.length===1&&module[0].init?.type==='Literal'&&/^[a-f0-9]{64}$/.test(module[0].init.value),'Recorded reference module checksum required');
    const paths=files[0].init.elements.map(item=>{
      assert(item?.type==='Literal'&&typeof item.value==='string'&&/^[a-zA-Z0-9._/-]+$/.test(item.value)&&!item.value.startsWith('/')&&!item.value.split('/').includes('..'),'Recorded source paths must be repository files');
      return item.value;
    });
    assert(paths.length>0&&paths.length<=100&&new Set(paths).size===paths.length,'Recorded source file list must be nonempty and unique');
    const components=[{path:'reference391.mjs',sha256:module[0].init.value},...paths.map(path=>({path,sha256:sha256(readSource(release.sourceCommit,path))}))];
    components.sort((a,b)=>a.path.localeCompare(b.path,'en'));
    assert.equal(sha256(JSON.stringify(components)),release.codeSha256,`Recorded source commit does not match runtime ${release.version}`);
  }
}
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
  verifyRuntimeReleaseProvenance(current);
  console.log(`Runtime history checked: ${current.length} records; existing entries preserved.`);
}
