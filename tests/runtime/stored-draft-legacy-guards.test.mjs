import test from 'node:test';
import assert from 'node:assert/strict';
import { publishReleaseToStaging,publishReleaseToProduction,rollbackRelease } from '../../worker/releases.ts';
import { dispatchExternalDeployment } from '../../worker/external-deployments.ts';
import { deleteRelease } from '../../worker/release-deletion.ts';
const id='builtin-draft-'+'a'.repeat(64);
function setup(versionOnly=false) {
  const row={id:versionOnly?'legacy-id':id,publisher_id:'test-site',version:versionOnly?id:'20260911_120000',status:'draft'};
  const queries=[];
  const env={DB:{prepare(sql){queries.push(sql);assert.match(sql,/^SELECT /);return{bind(){return{async first(){
    return sql.includes('FROM releases')?row:{id:'target',enabled:1};
  }}}};}},GITHUB_ACTIONS_TOKEN:'synthetic-test-token',DEPLOY_CALLBACK_SECRET:'synthetic-test-secret',
    BUILDS:{get(){assert.fail('Draft guard must not read R2');},put(){assert.fail('Draft guard must not write R2');},list(){assert.fail('Draft guard must not list/delete R2');},delete(){assert.fail('No deletion');}}};
  const request=new Request('https://test.invalid/api/unused',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({releaseId:row.id,channel:'staging'})});
  return{env,row,queries,request};
}
for(const [name,handler] of [['staging',publishReleaseToStaging],['production',publishReleaseToProduction],['rollback',rollbackRelease],['delete',deleteRelease]]) {
  for(const versionOnly of [false,true])test(`actual legacy ${name} refuses reserved ${versionOnly?'version':'ID'} before storage`,async()=>{
    const f=setup(versionOnly);const response=await handler(f.request,f.env,'test-site',f.row.id);
    assert.equal(response.status,409);assert.match((await response.json()).error,/review package/);assert.equal(f.queries.length,1);
  });
}
for(const channel of ['staging','production'])test(`actual cross-account ${channel} dispatch cannot publish candidate drafts`,async()=>{
  const f=setup();const request=new Request('https://test.invalid/api/unused',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({releaseId:id,channel})});
  const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('No dispatch network');
  try{const response=await dispatchExternalDeployment(request,f.env,'test-site','target');assert.equal(response.status,409);assert.match((await response.json()).error,/review package/);}
  finally{globalThis.fetch=original;}
});
test('existing legacy release path remains reachable',async()=>{
  const f=setup();f.row.id='legacy-id';f.row.version='20260911_120000';let reads=0;f.env.BUILDS.get=async()=>{reads++;return null;};
  const response=await publishReleaseToStaging(f.request,f.env,'test-site',f.row.id);
  assert.equal(response.status,409);assert.match((await response.json()).error,/artifacts could not be promoted/);assert.equal(reads,1);
});
