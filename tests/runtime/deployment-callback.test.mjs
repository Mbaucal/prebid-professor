import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deploymentCallback } from '../../worker/external-deployments.ts';
import { callbackResult } from '../../scripts/pages-release-verification.mjs';
import { workspaceStore } from '../support/test-workspace-store.mjs';

const origin = 'https://callback.example.invalid';
const runUrl = 'https://github.com/Mbaucal/prebid-professor/actions/runs/123456';
const deploymentUrl = 'https://0123abcd.example-pages.pages.dev';
const aliasUrl = 'https://staging.example-pages.pages.dev';
const links = {githubRunId:'123456',githubRunUrl:runUrl,deploymentUrl,aliasUrl};

function fixture({channel='staging',publicBase=null,audit=false,branch='staging'}={}) {
  const f = workspaceStore();
  f.env.DEPLOY_CALLBACK_SECRET = 'LOCAL-CALLBACK-FIXTURE';
  f.sqlite.exec(readFileSync('migrations/0001_initial.sql','utf8'));
  f.sqlite.exec(readFileSync('migrations/0003_external_deployments.sql','utf8'));
  f.sqlite.exec(`INSERT INTO publishers(id,name,domain,gam_path) VALUES ('site','Fixture','example.invalid','/123/example');
    INSERT INTO releases(id,publisher_id,version,status) VALUES ('release','site','fixture-v1','production');`);
  f.sqlite.prepare(`INSERT INTO deployment_targets (id,publisher_id,name,account_id,project_name,github_environment,production_branch,preview_branch,public_base_url)
    VALUES ('target','site','Fixture',?,'example-pages','CLOUDFLARE_API_TOKEN_FIXTURE','main',?,?)`).run('a'.repeat(32),branch,publicBase);
  f.sqlite.prepare(`INSERT INTO external_deployments(id,publisher_id,target_id,release_id,release_version,channel,status,correlation_id,message,updated_at)
    VALUES ('deployment','site','target','release','fixture-v1',?,'queued','correlation','Untouched message','original')`).run(channel);
  if(audit) f.sqlite.prepare(`INSERT INTO audit_log(id,actor,action,publisher_id,entity_type,entity_id,details_json)
    VALUES ('dispatch','fixture','external_deployment.dispatched','site','external_deployment','deployment',?)`)
    .run(JSON.stringify({repository:'Mbaucal/prebid-professor',branch}));
  f.row = () => f.sqlite.prepare('SELECT * FROM external_deployments').get();
  f.snapshot = () => JSON.stringify(['external_deployments','deployment_targets','audit_log'].map(table=>f.sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all()));
  f.call = async (body={},options={}) => deploymentCallback(new Request(origin+'/api/deployments/callback',{
    method:options.method ?? 'POST',headers:{authorization:options.authorization ?? 'Bearer LOCAL-CALLBACK-FIXTURE','content-type':'application/json'},
    ...(options.method==='GET'?{}:{body:typeof body==='string'?body:JSON.stringify({correlationId:'correlation',status:'running',...body})})}),f.env);
  return f;
}

const originalFetch=globalThis.fetch;
test.before(()=>{globalThis.fetch=()=>assert.fail('Callback validation must never use the network.');});
test.after(()=>{globalThis.fetch=originalFetch;});

test('actual callback accepts runner success, verification failure and status-only retries against SQLite',async()=>{
  for(const status of ['running','success','failed']) {
    const f=fixture();try {
      const input=status==='running'?{status,...links}:callbackResult({deployOutcome:'success',verificationOutcome:status==='success'?'success':'failure',runId:links.githubRunId,runUrl,correlationId:'correlation',deploymentUrl,aliasUrl});
      const response=await f.call(input);assert.equal(response.status,200,await response.clone().text());
      const row=f.row();assert.equal(row.status,status);assert.equal(row.github_run_url,runUrl);assert.equal(row.provider_deployment_url,deploymentUrl);assert.equal(row.provider_alias_url,aliasUrl);
      assert.equal(Boolean(row.completed_at),status!=='running');
      assert.equal((await f.call({status:'failed',githubRunId:null,githubRunUrl:'',deploymentUrl:'',aliasUrl:null})).status,200);
      assert.equal(f.row().github_run_id,links.githubRunId);assert.equal(f.row().github_run_url,runUrl);assert.equal(f.row().provider_deployment_url,deploymentUrl);assert.equal(f.row().provider_alias_url,aliasUrl);
    }finally{f.close();}
  }
});

test('pre-deploy failure and status-only callback retain null optional URLs',async()=>{
  const f=fixture();try {
    assert.equal((await f.call({status:'failed'})).status,200);assert.equal(f.row().github_run_id,null);assert.equal(f.row().provider_deployment_url,null);
    assert.equal((await f.call(callbackResult({deployOutcome:'failure',verificationOutcome:'skipped',runId:'123456',runUrl,correlationId:'correlation'}))).status,200);
    assert.equal(f.row().status,'failed');assert.equal(f.row().provider_alias_url,null);
  }finally{f.close();}
});

test('otherwise authorized destinations reject scheme, credential, port and parser-normalized control tricks',async()=>{
  const f=fixture();try{
    assert.equal((await f.call(links)).status,200);
    for(const field of ['githubRunUrl','deploymentUrl','aliasUrl']) for(const mutate of [
      value=>value.replace('https:','http:'),value=>value.replace('https://','https://user@'),
      value=>value.replace('https://','https://@'),value=>value.replace(/(https:\/\/[^/]+)/,'$1:444'),
      value=>value.replace('https://','https://\t'),value=>value+'\r\n',value=>value+'?next=elsewhere',
      value=>value+'#fragment',value=>value.replace('https://','https:\\\\'),
    ]) {
      const before=f.snapshot();assert.equal((await f.call({...links,[field]:mutate(links[field])})).status,422);assert.equal(f.snapshot(),before);
    }
    assert.equal((await f.call({...links,githubRunUrl:runUrl.replace('https://github.com','HTTPS://GITHUB.COM:443'),deploymentUrl:deploymentUrl+'/'})).status,200);
  }finally{f.close();}
});

for(const field of ['githubRunUrl','deploymentUrl','aliasUrl']) for(const value of [
  'javascript:alert(1)','data:text/html,x','http://example.invalid','//example.invalid',
  'https://user:password@example.invalid','https://example.invalid:444/','https://example.invalid/?redirect=x',
  'https://example.invalid/#fragment',' https://example.invalid/','https://example.invalid/\n','https:\\example.invalid/',
  'https://example.invalid/%0a','https://example.invalid/%7f',{},false,17,
]) test(`rejects unsafe ${field}: ${JSON.stringify(value)}`,async()=>{
  const f=fixture();try {
    assert.equal((await f.call(links)).status,200);const before=f.snapshot(),sqlAt=f.log.sql.length;
    const response=await f.call({status:'success',...links,[field]:value,message:'Must not persist'});
    assert.equal(response.status,422,await response.clone().text());assert.equal(f.snapshot(),before);
    assert(!f.log.sql.slice(sqlAt).some(sql=>/\b(?:UPDATE|INSERT|DELETE)\b/i.test(sql)));
  }finally{f.close();}
});

for(const [field,value] of [
  ['githubRunUrl','https://github.com.evil.invalid/Mbaucal/prebid-professor/actions/runs/123456'],
  ['githubRunUrl','https://github.com/Other/prebid-professor/actions/runs/123456'],
  ['githubRunUrl','https://github.com/Mbaucal/other/actions/runs/123456'],
  ['githubRunUrl','https://github.com/Mbaucal/prebid-professor/issues/123456'],
  ['githubRunUrl','https://github.com/Mbaucal/prebid-professor/actions/runs/123456/jobs/1'],
  ['githubRunUrl','https://%67ithub.com/Mbaucal/prebid-professor/actions/runs/123456'],
  ['githubRunUrl','https://github.com@evil.invalid/Mbaucal/prebid-professor/actions/runs/123456'],
  ['deploymentUrl','https://0123abcd.example-pages.pages.dev.evil.invalid'],
  ['deploymentUrl','https://0123abcd.other-project.pages.dev'],
  ['deploymentUrl','https://staging.example-pages.pages.dev'],
  ['deploymentUrl','https://0123abcd.example-pages.pages.dev/ads.js'],
  ['aliasUrl','https://other.example-pages.pages.dev'],
  ['aliasUrl','https://staging.other-project.pages.dev'],
  ['aliasUrl','https://example-pages.pages.dev'],
  ['aliasUrl','https://cdn.other.invalid'],
]) test(`rejects foreign or wrong-shaped ${field}: ${value}`,async()=>{
  const f=fixture();try{const before=f.snapshot();assert.equal((await f.call({...links,[field]:value,status:'success'})).status,422);assert.equal(f.snapshot(),before);}finally{f.close();}
});

test('run URL and ID omission are compatible but cannot replace an already recorded run',async()=>{
  for(const first of [{githubRunId:'123456'},{githubRunUrl:runUrl},{githubRunId:123456,githubRunUrl:runUrl}]) {
    const f=fixture();try{
      assert.equal((await f.call(first)).status,200);assert.equal(f.row().github_run_id,'123456');
      assert.equal((await f.call({githubRunUrl:runUrl})).status,200);
      for(const bad of [{githubRunId:'222'}, {githubRunUrl:runUrl.replace('123456','222')}, {githubRunId:'222',githubRunUrl:runUrl.replace('123456','222')}, {githubRunId:0},{githubRunId:'1e3'},{githubRunId:' 123456'}]) {
        const before=f.snapshot();assert.equal((await f.call({...bad,status:'success'})).status,422);assert.equal(f.snapshot(),before);
      }
    }finally{f.close();}
  }
  const f=fixture();try{const before=f.snapshot();assert.equal((await f.call({githubRunId:'123',githubRunUrl:runUrl})).status,422);assert.equal(f.snapshot(),before);}finally{f.close();}
});

test('legacy URL-only run provenance binds future reports',async()=>{
  const f=fixture();try{
    f.sqlite.prepare('UPDATE external_deployments SET github_run_url=?').run(runUrl);const before=f.snapshot();
    assert.equal((await f.call({githubRunId:'222',githubRunUrl:runUrl.replace('123456','222')})).status,422);assert.equal(f.snapshot(),before);
    assert.equal((await f.call({githubRunId:'123456'})).status,200);
  }finally{f.close();}
});

test('concurrent first callbacks cannot bind the deployment to two different Actions runs',async()=>{
  const f=fixture();try{
    const results=await Promise.all([f.call(links),f.call({...links,githubRunId:'222',githubRunUrl:runUrl.replace('123456','222')})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    const row=f.row();assert.equal(row.github_run_url,runUrl.replace('123456',row.github_run_id));
    const before=f.snapshot(),other=row.github_run_id==='123456'?'222':'123456';
    assert.equal((await f.call({githubRunId:other,githubRunUrl:runUrl.replace('123456',other)})).status,422);assert.equal(f.snapshot(),before);
  }finally{f.close();}
});

test('production origin, selected normalized branch and exact configured custom base remain supported',async()=>{
  for(const [options,alias] of [
    [{channel:'production'},'https://example-pages.pages.dev/'],
    [{branch:'Fix/API_v2'},'https://fix-api-v2.example-pages.pages.dev'],
    [{branch:'Fix/API__v2'},'https://fix-api-v2.example-pages.pages.dev'],
    [{branch:'Feature/a-long-branch-name-with-a-long-suffix'},'https://feature-a-long-branch-name-w.example-pages.pages.dev'],
    [{publicBase:'https://cdn.example.invalid'},'https://cdn.example.invalid/'],
    [{publicBase:'https://cdn.example.invalid/assets/wrapper'},'https://cdn.example.invalid/assets/wrapper/'],
  ]) {
    const f=fixture(options);try{assert.equal((await f.call({...links,aliasUrl:alias})).status,200);}finally{f.close();}
  }
  const f=fixture({publicBase:'https://cdn.example.invalid/assets/wrapper'});try{
    for(const alias of ['https://cdn.example.invalid','https://cdn.example.invalid/assets/wrapper/child','https://cdn.example.invalid/assets/wrapper-other','https://cdn.example.invalid.evil.invalid/assets/wrapper']){
      const before=f.snapshot();assert.equal((await f.call({aliasUrl:alias})).status,422);assert.equal(f.snapshot(),before);
    }
  }finally{f.close();}
});

test('malformed or incomplete dispatch audit never falls back to mutable configuration',async()=>{
  for(const details of ['{','null','{}','{"repository":17,"branch":null}',
    '{"repository":"Mbaucal/prebid-professor"}', '{"branch":"staging"}',
    '{"repository":"other/invalid/repo","branch":"staging"}',
    '{"repository":"Mbaucal/prebid-professor","branch":"staging\\n"}']) {
    const f=fixture({audit:true});try{
      f.sqlite.prepare('UPDATE audit_log SET details_json=?').run(details);const before=f.snapshot(),at=f.log.sql.length;
      assert.equal((await f.call(links)).status,503);assert.equal(f.snapshot(),before);
      assert(!f.log.sql.slice(at).some(sql=>/\bUPDATE\b/.test(sql)));
    }finally{f.close();}
  }
});

test('dispatch audit pins repo/branch; historical rows use configured repository and target',async()=>{
  const f=fixture({audit:true});try{
    f.env.GITHUB_DEPLOY_REPOSITORY='Other/new-repository';f.sqlite.exec("UPDATE deployment_targets SET preview_branch='changed'");
    assert.equal((await f.call(links)).status,200);
    const before=f.snapshot();assert.equal((await f.call({githubRunUrl:'https://github.com/Other/new-repository/actions/runs/123456'})).status,422);assert.equal(f.snapshot(),before);
    f.sqlite.exec("UPDATE deployment_targets SET project_name='changed-project'");const changed=f.snapshot();
    assert.equal((await f.call({status:'success'})).status,422);assert.equal(f.snapshot(),changed);
  }finally{f.close();}
  const legacy=fixture();try{
    legacy.env.GITHUB_DEPLOY_REPOSITORY='Other/repository';assert.equal((await legacy.call({githubRunUrl:'https://github.com/Other/repository/actions/runs/123456'})).status,200);
    legacy.env.GITHUB_DEPLOY_REPOSITORY='Else/repository';const before=legacy.snapshot();assert.equal((await legacy.call({status:'success'})).status,422);assert.equal(legacy.snapshot(),before);
  }finally{legacy.close();}
});

test('omitted fields never legitimize unsafe stored links; an explicit valid replacement can repair them',async()=>{
  for(const [column,key] of [['github_run_url','githubRunUrl'],['provider_deployment_url','deploymentUrl'],['provider_alias_url','aliasUrl']]) {
    const f=fixture();try{
      f.sqlite.prepare(`UPDATE external_deployments SET ${column}=?`).run('javascript:alert(1)');const before=f.snapshot();
      for(const value of [undefined,null,'']){assert.equal((await f.call({status:'success',[key]:value})).status,422);assert.equal(f.snapshot(),before);}
      assert.equal((await f.call({status:'success',[key]:links[key]})).status,200);
    }finally{f.close();}
  }
});

test('legacy HTTP public target does not grant callback HTTP or arbitrary HTTPS authority',async()=>{
  const f=fixture({publicBase:'http://cdn.example.invalid/path'});try{
    for(const alias of ['http://cdn.example.invalid/path','https://cdn.example.invalid/path'])assert.equal((await f.call({aliasUrl:alias})).status,422);
    assert.equal((await f.call(links)).status,200);
  }finally{f.close();}
});

test('credential, method, malformed payload, status and correlation guards stay read-only',async()=>{
  const f=fixture();try{
    const before=f.snapshot();
    for(const [body,options,status] of [[{}, {authorization:'Bearer wrong'},401],[{}, {method:'GET'},405],['{',{},422],[{status:'unknown'},{},422],[{correlationId:'absent'},{},404]]) {
      assert.equal((await f.call(body,options)).status,status);assert.equal(f.snapshot(),before);
    }
  }finally{f.close();}
});
