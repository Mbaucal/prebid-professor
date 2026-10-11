/** Release records are append-only; a new engine build needs a new version. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'acorn';
import { checkRuntimeReleaseHistory } from './runtime-release-history-contract.mjs';
const path='worker/runtime/runtime-releases.json';
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
    assert(['scripts/prepare-builtin-runtime.mjs','scripts/prepare-next-runtime.mjs','scripts/prepare-creative-runtime.mjs','scripts/prepare-reporting-runtime.mjs','scripts/prepare-demand-runtime.mjs','scripts/prepare-readiness-runtime.mjs','scripts/prepare-revenue-runtime.mjs','scripts/prepare-revenue-v2-runtime.mjs'].includes(manifest),'Known source manifest required');
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
export { checkRuntimeReleaseHistory } from './runtime-release-history-contract.mjs';

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
