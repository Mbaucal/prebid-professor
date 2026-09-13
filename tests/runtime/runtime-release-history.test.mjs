import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeReleaseHistory, assertRuntimeReleaseSource } from '../../worker/runtime/runtime-release-history.mjs';
import { checkRuntimeReleaseHistory } from '../../scripts/check-runtime-release-history.mjs';
const history=()=>structuredClone(runtimeReleaseHistory);
const next=()=>({...history()[0],id:'tessera-reference391-preview-3',version:'3.9.1-tessera.preview.3',codeSha256:'a'.repeat(64),title:'A documented upgrade'});
test('historical register can be initialized and retained unchanged',()=>{
  assert.doesNotThrow(()=>checkRuntimeReleaseHistory(history(),null));
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
