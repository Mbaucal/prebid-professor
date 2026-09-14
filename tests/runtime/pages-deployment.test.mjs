import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateDeploymentInput, manifestInventory, verifyPackage, boundedGet, checkPagesProject, deploymentOrigin, verifyPublicPackage, callbackResult } from '../../scripts/pages-release-verification.mjs';
import { deploymentManifestPin } from '../../worker/deployment-manifest-pin.mjs';
import { dispatchExternalDeployment } from '../../worker/external-deployments.ts';
import { buildArtifactCandidate } from '../../worker/runtime/artifact-candidate.mjs';
import { describeCandidate } from '../../worker/runtime/draft-release-store.mjs';
import { fixture, pin, takeOver, checkedFixture, TS } from './artifact-fixture.mjs';
const bytes = value => new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
const sha = value => createHash('sha256').update(value).digest('hex');
const ref = 'refs/heads/feature/isolated-runtime-workspace-v1';
const origin = 'https://prebid-professor.mbaucal.workers.dev';
function legacy() {
  const input={site_id:'test-site',release_id:'11111111-1111-4111-8111-111111111111',release_version:'20260914_010000',
    correlation_id:'22222222-2222-4222-8222-222222222222',account_id:'a'.repeat(32),project_name:'test-pages',branch:'staging',channel:'staging',
    github_environment:'CLOUDFLARE_API_TOKEN_FIXTURE',callback_url:origin+'/api/deployments/callback',release_base_url:origin+'/cdn/test-site/releases/20260914_010000'};
  const pb={id:'pb-fixture',version:'11.34.0',modules:['consentManagementTcf','currency','pubmaticBidAdapter','tcfControl','teadsBidAdapter']};
  const config={site:{id:input.site_id},version:input.release_version,prebidBuild:pb};
  const files={'ads.js':bytes('throw Error("Do not execute uploaded code");'),'ads.min.js':bytes('throw Error("Do not execute uploaded code");'),
    'prebid.js':bytes('/* prebid.js v11.34.0\nModules: '+pb.modules.join(', ')+' */\nthrow Error("Do not execute uploaded code");'),
    'config.json':bytes(config),'min-height.css':bytes('.ad{min-height:250px}'),'sticky.css':bytes('.sticky{bottom:0}'),
    'div-export.csv':bytes('id\nBillboard'),'implementation.html':bytes('<script>throw Error("Do not execute")</script>')};
  const manifest={schemaVersion:1,siteId:input.site_id,releaseId:input.release_id,version:input.release_version,configHash:sha(files['config.json']),prebidBuild:pb,
    files:Object.fromEntries(Object.entries(files).map(([name,value])=>[name,{size:value.length,sha256:sha(value)}]))};
  files['manifest.json']=bytes(manifest);input.manifest_sha256=sha(files['manifest.json']);
  return {input,files,manifest,config};
}
function rewrite(f, mutate) {mutate(f.manifest);f.files['manifest.json']=bytes(f.manifest);return f;}
function response(body,headers={}){return new Response(body,{headers});}
test('legacy deployment validates the private manifest, all eight assets and Prebid metadata without execution',async()=>{
  const f=legacy();assert.deepEqual(validateDeploymentInput(f.input,ref),f.input);
  const checked=await verifyPackage(f.files,f.input);assert.equal(checked.files.length,9);assert.equal(checked.builtinDraft,false);
  const release={id:f.input.release_id,version:f.input.release_version,manifest_key:`publishers/test-site/releases/${f.input.release_version}/manifest.json`,config_hash:f.manifest.configHash};
  const bucket={async get(key){assert.equal(key,release.manifest_key);return{size:f.files['manifest.json'].length,customMetadata:{sha256:f.input.manifest_sha256},async arrayBuffer(){return f.files['manifest.json'].buffer;}};}};
  assert.equal(await deploymentManifestPin(bucket,'test-site',release),f.input.manifest_sha256);
});
test('older legacy package without sticky remains valid when the manifest omits it',async()=>{
  const f=legacy();delete f.files['sticky.css'];rewrite(f,m=>delete m.files['sticky.css']);assert.equal((await verifyPackage(f.files,f.input)).files.length,8);
});
for(const [name,edit] of [
  ['callback host',i=>i.callback_url='https://other.invalid/callback'],['source redirect URL',i=>i.release_base_url+='?redirect=elsewhere'],
  ['token secret substitution',i=>i.github_environment='PREBID_PROFESSOR_CALLBACK_SECRET'],['shell characters',i=>i.branch='staging;echo'],
  ['production from TEST ref',i=>i.channel='production'],['source traversal',i=>i.release_version='../other'],
  ['missing manifest pin',i=>delete i.manifest_sha256],['built-in public bypass',i=>i.release_id='builtin-draft-'+'a'.repeat(64)],
  ['unexpected account',i=>i.account_id='a'.repeat(31)],['project argument injection',i=>i.project_name='test --branch=main'],
])test('rejects '+name+' before credentials or network',()=>{const f=legacy();edit(f.input);assert.throws(()=>validateDeploymentInput(f.input,ref));});

for(const [name,mutate] of [
  ['changed bytes',f=>f.files['ads.js'][0]^=1],['missing file',f=>delete f.files['prebid.js']],
  ['extra file',f=>f.files['_worker.js']=bytes('untrusted')],['foreign release',f=>rewrite(f,m=>m.releaseId='other')],
  ['unsafe inventory path',f=>rewrite(f,m=>m.files['../evil.js']=m.files['ads.js'])],
  ['manifest size',f=>rewrite(f,m=>m.files['ads.js'].size=0)],
  ['wrong config identity',f=>{f.config.site.id='other';f.files['config.json']=bytes(f.config);rewrite(f,m=>{m.files['config.json']={size:f.files['config.json'].length,sha256:sha(f.files['config.json'])};m.configHash=sha(f.files['config.json']);});}],
  ['header/manifest version drift',f=>rewrite(f,m=>{m.prebidBuild.version='11.11.0';})],
])test('refuses package with '+name,async()=>{const f=legacy();mutate(f);await assert.rejects(verifyPackage(f.files,f.input));});

test('built-in verification reuses exact stored identity but does not authorize legacy delivery',async()=>{
  const snapshot=fixture(),candidate=await buildArtifactCandidate({snapshot,pin:pin(),takeOver:takeOver(),buildTimestamp:TS,prebid:await checkedFixture(snapshot)});
  const {descriptor}=await describeCandidate('test-site',candidate);
  const expected={...legacy().input,release_id:descriptor.releaseId,release_version:descriptor.releaseId};
  const verified=await verifyPackage(candidate.files,expected);
  assert.equal(verified.packageSha256,descriptor.packageSha256);assert.equal(verified.files.length,10);
  assert.throws(()=>validateDeploymentInput(expected,ref),/separate reviewed staging/);
});

test('actual Cloudflare project decides which branch is production',async()=>{
  const {input}=legacy();let count=0;
  const cf=async(url,options)=>{count++;assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${input.account_id}/pages/projects/test-pages`);assert.equal(options.method,'GET');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer LOCAL-ONLY');return response(JSON.stringify({success:true,result:{name:'test-pages',production_branch:'live'}}));};
  assert.equal((await checkPagesProject(input,'LOCAL-ONLY',cf)).productionBranch,'live');
  await assert.rejects(checkPagesProject({...input,branch:'live'},'LOCAL-ONLY',cf),/channel/);
  await assert.rejects(checkPagesProject({...input,channel:'production'},'LOCAL-ONLY',cf),/channel/);
  assert.equal(count,3);
});
test('missing token and wrong provider project cannot proceed',async()=>{
  const {input}=legacy();await assert.rejects(checkPagesProject(input,'',()=>assert.fail('No network')),/missing/);
  await assert.rejects(checkPagesProject(input,'LOCAL',async()=>response(JSON.stringify({success:true,result:{name:'other',production_branch:'main'}}))),/confirmed/);
});
test('bounded reads reject redirects, HTTP failures and advertised/streamed oversized responses',async()=>{
  await assert.rejects(boundedGet('https://source.invalid',8,{fetcher:async()=>new Response(null,{status:302,headers:{location:'https://other.invalid'}})}));
  await assert.rejects(boundedGet('https://source.invalid',8,{fetcher:async()=>new Response('missing',{status:404})}));
  await assert.rejects(boundedGet('https://source.invalid',8,{fetcher:async()=>response('x',{'content-length':'99'})}),/size/);
  await assert.rejects(boundedGet('https://source.invalid',8,{fetcher:async()=>response('123456789')}),/size/);
});
test('public verification checks exact deployment hostname, bytes, content types, CORS and cache',async()=>{
  const f=legacy(), verified=await verifyPackage(f.files,f.input), urls=[];
  let corrupt='',badHeader='';
  const publicFetch=async(url,options)=>{urls.push(url);assert.equal(options.method,'GET');assert.deepEqual(options.headers,{});assert.equal(options.redirect,'error');
    const name=new URL(url).pathname.slice(1),data=name===corrupt?bytes('bad'):f.files[name];
    const type=name.endsWith('.js')?'application/javascript':name.endsWith('.json')?'application/json':name.endsWith('.css')?'text/css':name.endsWith('.html')?'text/html':'text/csv';
    const headers={'content-type':type,'access-control-allow-origin':'*','x-content-type-options':'nosniff','cache-control':'no-store'};if(badHeader)delete headers[badHeader];return response(data,headers);};
  const url='https://0123abcd.test-pages.pages.dev/';
  assert.equal((await verifyPublicPackage(url,'test-pages',verified,publicFetch)).fileCount,9);
  assert.equal(urls.length,9);corrupt='ads.js';await assert.rejects(verifyPublicPackage(url,'test-pages',verified,publicFetch),/differs/);corrupt='';
  for(const h of ['content-type','access-control-allow-origin','x-content-type-options','cache-control']){badHeader=h;await assert.rejects(verifyPublicPackage(url,'test-pages',verified,publicFetch));}
  for(const wrong of ['https://staging.test-pages.pages.dev/','https://0123abcd.other.pages.dev/','http://0123abcd.test-pages.pages.dev/','https://0123abcd.test-pages.pages.dev/?x=1'])assert.throws(()=>deploymentOrigin(wrong,'test-pages'));
});

test('private pin rejects a missing, corrupted or foreign source before dispatch',async()=>{
  const f=legacy();const release={id:f.input.release_id,version:f.input.release_version,manifest_key:`publishers/test-site/releases/${f.input.release_version}/manifest.json`,config_hash:f.manifest.configHash};
  const bucket={async get(){return{size:f.files['manifest.json'].length,customMetadata:{sha256:'a'.repeat(64)},async arrayBuffer(){return f.files['manifest.json'].buffer;}};}};
  await assert.rejects(deploymentManifestPin(bucket,'test-site',release),/checksum/);
  await assert.rejects(deploymentManifestPin(bucket,'other-site',release),/unavailable/);
  await assert.rejects(deploymentManifestPin(bucket,'test-site',{...release,id:'builtin-draft-'+'a'.repeat(64)}),/cannot use/);
});

test('actual dispatch carries a checksum from private R2 and never dispatches on mismatch',async()=>{
  const f=legacy(),calls=[],writes=[];
  const release={id:f.input.release_id,publisher_id:'test-site',version:f.input.release_version,status:'draft',manifest_key:`publishers/test-site/releases/${f.input.release_version}/manifest.json`,config_hash:f.manifest.configHash};
  const target={id:'target',name:'Fixture',enabled:1,account_id:f.input.account_id,project_name:f.input.project_name,github_environment:f.input.github_environment,preview_branch:'staging',production_branch:'main'};
  const env={GITHUB_ACTIONS_TOKEN:'LOCAL-GITHUB',DEPLOY_CALLBACK_SECRET:'LOCAL-CALLBACK',GITHUB_DEPLOY_REF:'feature/isolated-runtime-workspace-v1',
    DB:{
      prepare(sql){
        return {bind(...args){return {
          async first(){return sql.includes('FROM releases')?release:sql.includes('FROM deployment_targets')?target:{id:'deployment',status:'running'};},
          async run(){writes.push({sql,args});return {};},
        };}};
      },
      async batch(items){for(const item of items)await item.run();return [];},
    },
    BUILDS:{async get(key){assert.equal(key,release.manifest_key);return{size:f.files['manifest.json'].length,customMetadata:{sha256:f.input.manifest_sha256},async arrayBuffer(){return f.files['manifest.json'].buffer;}};}}};
  const request=()=>new Request(origin+'/api/unused',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({releaseId:release.id,channel:'staging'})});
  const previous=globalThis.fetch;globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(null,{status:204});};
  try{
    const ok=await dispatchExternalDeployment(request(),env,'test-site','target');assert.equal(ok.status,202,await ok.clone().text());
    assert.equal(JSON.parse(calls[0].options.body).inputs.manifest_sha256,f.input.manifest_sha256);
    const before=writes.length;f.input.manifest_sha256='0'.repeat(64);
    assert.equal((await dispatchExternalDeployment(request(),env,'test-site','target')).status,409);assert.equal(calls.length,1);assert.equal(writes.length,before);
  }finally{globalThis.fetch=previous;}
});
test('a completed deployment is retained when verification fails, and notification result cannot change it',()=>{
  const base={runId:'123',runUrl:'https://github.com/Mbaucal/prebid-professor/actions/runs/123',correlationId:legacy().input.correlation_id,deploymentUrl:'https://0123abcd.test-pages.pages.dev',aliasUrl:'https://staging.test-pages.pages.dev'};
  const good=callbackResult({...base,deployOutcome:'success',verificationOutcome:'success'});assert.equal(good.status,'success');
  const failed=callbackResult({...base,deployOutcome:'success',verificationOutcome:'failure'});assert.equal(failed.status,'failed');assert.equal(failed.deploymentUrl,base.deploymentUrl);assert.match(failed.message,/deployment completed/);
  const uncertain=callbackResult({...base,deployOutcome:'failure',verificationOutcome:'skipped'});assert.equal(uncertain.deploymentUrl,'');assert.match(uncertain.message,/confirmed/);
});
test('workflow separates deployment, verification and status retries and never uploads package bytes',()=>{
  const yaml=readFileSync('.github/workflows/deploy-pages-release.yml','utf8');
  const verify=yaml.split('\n  verify:')[1].split('\n  report:')[0],report=yaml.split('\n  report:')[1];
  assert.match(verify,/needs: deploy/);assert.match(report,/needs: \[deploy, verify\]/);
  for(const job of [verify,report]){assert.doesNotMatch(job,/wrangler-action|CLOUDFLARE_API_TOKEN|pages deploy/);}
  assert.equal((yaml.match(/pages-release-verification.mjs callback/g)||[]).length,1);
  assert.doesNotMatch(yaml,/--location|retry-all-errors|dist\/\*/);
  assert.match(yaml,/manifest_sha256:/);assert.match(yaml,/wranglerVersion: "4\.118\.0"/);
});
