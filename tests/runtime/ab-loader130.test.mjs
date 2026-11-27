import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import {build} from 'esbuild';
import * as loader from '../../worker/experiments/ab-loader-1.3.0.mjs';
const registry=JSON.parse(readFileSync('worker/experiments/ab-loader-registry.json','utf8'));
const arm=c=>({release:'original-source-'+c.repeat(64),name:'Original '+c,runtimeVersion:'build 20260813_125447',path:'r/original-source-'+c.repeat(64)+'/ads.js',sha256:c.repeat(64),integrity:'sha384-'+Buffer.alloc(48,1).toString('base64')});
const config={schema:loader.AB_LOADER_CONFIG_SCHEMA,id:'abx-'+'c'.repeat(64),testId:'politika_2',name:'Original test',trafficBPercent:50,arms:{A:arm('a'),B:arm('b')},loader:{version:'1.3.0',sha256:registry['1.3.0'].sha256}};
const text=loader.renderAbLoader(config);
function page({random=0,ready=false,query='',globals={},fail='',targeting={}}={}){
  const scripts=[],queue=[],touched=[],targets={...targeting};
  const service={getTargeting:k=>targets[k]??[],setTargeting:(k,v)=>{if(fail==='labels'&&k==='VersionId')throw Error('blocked');targets[k]=[v];},clearTargeting:k=>delete targets[k]};
  const g={pubads:()=>service,cmd:ready?{push:fn=>fn()}:queue};
  const doc={currentScript:{src:'https://example.invalid/ads.js',nonce:'nonce-value'},createElement:()=>({setAttribute(){}}),head:{appendChild:s=>{if(fail==='append')throw Error('blocked');scripts.push(s);}}};
  const box={document:doc,URL,location:{search:query},googletag:g,crypto:{getRandomValues:a=>{if(fail==='random')throw Error('random');a[0]=random;}},...globals};box.window=box;
  for(const name of ['localStorage','sessionStorage','__tcfapi','__gpp','fetch','XMLHttpRequest','setTimeout'])Object.defineProperty(box,name,{get(){touched.push(name);throw Error('forbidden');}});
  Object.defineProperty(doc,'cookie',{get(){touched.push('cookie');throw Error('forbidden');}});
  const context=vm.createContext(box);vm.runInContext(text,context);
  return {box,context,scripts,targets,touched,flush(){while(queue.length)queue.shift()();},snapshot:()=>box.AdVariant?.snapshot()};
}
test('registered original loader is ASCII, ES2015 and stable through production minification',async()=>{
  assert.equal(createHash('sha256').update(loader.AB_LOADER_TEMPLATE).digest('hex'),registry['1.3.0'].sha256);
  assert.match(loader.AB_LOADER_TEMPLATE,/^[\x09\x0a\x20-\x7e]*$/);parse(text,{ecmaVersion:2015});
  const compiled=await build({entryPoints:['worker/experiments/ab-loader-1.3.0.mjs'],bundle:true,write:false,format:'esm',platform:'node',minify:true});
  const built=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));assert.equal(built.renderAbLoader(config),text);
});
test('random A/B boundary uses exact one pinned script and labels before runtime GPT work',()=>{
  for(const [random,side]of [[0,'A'],[2147483647,'A'],[2147483648,'B'],[4294967295,'B']])for(const ready of [false,true]){
    const p=page({random,ready});assert.equal(p.scripts.length,1);assert.equal(p.snapshot().variant,side);assert.equal(p.scripts[0].src,'https://example.invalid/'+config.arms[side].path);
    assert.equal(p.scripts[0].integrity,config.arms[side].integrity);assert.equal(p.scripts[0].nonce,'nonce-value');p.flush();
    assert.deepEqual(p.targets,{Variant:[side],VersionId:['politika_2']});assert.deepEqual(p.touched,[]);
  }
});
test('a late or failed B never inserts A; errors remove only loader-owned labels',()=>{
  for(const ready of [false,true]){
    const p=page({random:4294967295,ready});const script=p.scripts[0];assert.equal(p.snapshot().status,'assigned');
    // No timer exists: this could be an arbitrarily late transport failure.
    script.onerror();p.flush();assert.equal(p.scripts.length,1);assert.equal(p.snapshot().status,'script-error');assert.deepEqual(p.targets,{});assert.deepEqual(p.touched,[]);
  }
  const p=page({ready:true});p.targets.Variant=['publisher'];p.scripts[0].onerror();assert.deepEqual(p.targets,{Variant:['publisher']});
});
test('duplicate loader and pre-existing original runtime do not run a second arm',()=>{
  const p=page();vm.runInContext(text,p.context);assert.equal(p.scripts.length,1);assert.equal(p.snapshot().blockedDuplicateLoaders,1);
  for(const globals of [{ADS_BUILD_TS:'old'},{__TESSERA_RUNTIME_STARTED:true},{__tesseraExperimentOwner:'old'},{AdVariant:{snapshot:()=>({old:true})}}])assert.equal(page({globals}).scripts.length,0);
});
test('key conflicts, queue errors and partial targeting failure preserve publisher labels',()=>{
  for(const globals of [{adsKeywords:{Variant:'old'}},{ADS_KEYWORDS:{VersionId:'old'}}])assert.equal(page({globals}).scripts.length,0);
  const ready=page({ready:true,targeting:{Variant:['old']}});assert.equal(ready.scripts.length,0);assert.deepEqual(ready.targets,{Variant:['old']});
  const late=page({targeting:{VersionId:['old']}});late.flush();assert.equal(late.scripts.length,1);assert.deepEqual(late.targets,{VersionId:['old']});assert.equal(late.snapshot().status,'excluded-key-conflict');
  const labels=page({ready:true,fail:'labels'});assert.equal(labels.scripts.length,0);assert.deepEqual(labels.targets,{});
});
test('forced QA and random failure load one unlabelled source; append failure cannot retry',()=>{
  const qa=page({query:'?tessera_ab=B'});qa.flush();assert.equal(qa.snapshot().variant,'B');assert.deepEqual(qa.targets,{});
  const noRandom=page({fail:'random'});noRandom.flush();assert.equal(noRandom.snapshot().variant,'A');assert.deepEqual(noRandom.targets,{});
  const blocked=page({fail:'append',ready:true});assert.equal(blocked.scripts.length,0);assert.deepEqual(blocked.targets,{});assert.equal(blocked.snapshot().status,'script-blocked');
});
test('malformed arm paths and executable test names cannot escape configuration',()=>{
  assert.throws(()=>loader.renderAbLoader({...config,arms:{...config.arms,A:{...config.arms.A,path:'https://evil.invalid/script.js'}}}));
  const rendered=loader.renderAbLoader({...config,name:'</script><script>alert(1)</script>'});assert(!rendered.includes('</script>'));parse(rendered,{ecmaVersion:2015});
});
