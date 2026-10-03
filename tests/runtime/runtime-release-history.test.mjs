import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReleaseHistory, assertRuntimeReleaseSource } from '../../worker/runtime/runtime-release-history.mjs';
import { checkRuntimeReleaseHistory, verifyRuntimeReleaseProvenance } from '../../scripts/check-runtime-release-history.mjs';
import { createHash } from 'node:crypto';
const history=()=>structuredClone(runtimeReleaseHistory);
const next=()=>({...history()[0],sourceManifest:'scripts/prepare-builtin-runtime.mjs',id:'tessera-reference391-preview-3',version:'3.9.1-tessera.preview.3',codeSha256:'a'.repeat(64),title:'A documented upgrade'});
test('historical register can be initialized and retained unchanged',()=>{
  assert.doesNotThrow(()=>checkRuntimeReleaseHistory(history().slice(-2),null));
  assert.doesNotThrow(()=>checkRuntimeReleaseHistory(history(),history()));
});
test('a new version can be prepended without rewriting history',()=>assert.doesNotThrow(()=>checkRuntimeReleaseHistory([next(),...history()],history())));
test('removing, editing or reordering an old release fails the build check',()=>{
  for(const records of [history().slice(0,1),history().reverse(),history().map((r,i)=>i?{...r,title:'Rewritten history'}:r)]){
    assert.throws(()=>checkRuntimeReleaseHistory(records,history()));
  }
});
test('new code cannot reuse an existing version number',()=>{
  assert.throws(()=>checkRuntimeReleaseHistory([{...next(),version:history()[0].version},...history()],history()));
  const previous=[next(),...history()];
  assert.throws(()=>checkRuntimeReleaseHistory([{...next(),codeSha256:'b'.repeat(64)},...previous],previous));
});
test('new releases require notes, exact identity and newest-first order',()=>{
  for(const invalid of [{changes:[]},{version:'latest'},{sourceCommit:'unknown'},{codeSha256:'unknown'},{title:''}]){
    assert.throws(()=>checkRuntimeReleaseHistory([{...next(),...invalid},...history()],history()));
  }
  assert.throws(()=>checkRuntimeReleaseHistory([...history(),next()],history()));
  assert.throws(()=>checkRuntimeReleaseHistory([next(),next(),...history()],history()));
});
test('an undocumented source change blocks runtime preparation',()=>{
  assert.doesNotThrow(()=>assertRuntimeReleaseSource(history()[0].codeSha256));
  assert.throws(()=>assertRuntimeReleaseSource('f'.repeat(64)),/Register a new exact runtime version/);
});
test('recorded commit must exist and reproduce its declared source checksum',()=>{
  const moduleHash='d'.repeat(64),source='export const value=42;',hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const components=[{path:'reference391.mjs',sha256:moduleHash},{path:'worker/engine.mjs',sha256:hash(source)}];
  const release={...next(),codeSha256:hash(JSON.stringify(components))};
  const readSource=(commit,path)=>{
    assert.equal(commit,release.sourceCommit);
    if(path==='scripts/prepare-builtin-runtime.mjs')return `export const MODULE_SHA256='${moduleHash}';function prepare(){const sourceFiles=['worker/engine.mjs'];}`;
    assert.equal(path,'worker/engine.mjs');return source;
  };
  assert.doesNotThrow(()=>verifyRuntimeReleaseProvenance([release],readSource));
  assert.throws(()=>verifyRuntimeReleaseProvenance([{...release,codeSha256:'e'.repeat(64)}],readSource),/does not match runtime/);
  assert.throws(()=>verifyRuntimeReleaseProvenance([release],()=>{throw Error('Unknown source commit');}),/Unknown source commit/);
});
