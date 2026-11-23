import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import * as current from '../../worker/experiments/ab-loader-1.1.1.mjs';
import * as previous from '../../worker/experiments/ab-loader-1.1.0.mjs';
import {loaderMeasurementPage} from '../support/ab-measurement-page.mjs';
import {syntheticDraft} from '../support/ab-synthetic-drafts.mjs';
import {composeAbBundle} from '../../worker/experiments/ab-bundle.mjs';

const page=options=>loaderMeasurementPage({L:current,...options});
const events=(p,type)=>p.measurement().events.filter(row=>row.type===type);

test('1.1.1 is a new registered ES5 template; released earlier templates are unchanged',()=>{
  const registry=JSON.parse(readFileSync(new URL('../../worker/experiments/ab-loader-registry.json',import.meta.url),'utf8'));
  parse(current.AB_LOADER_TEMPLATE,{ecmaVersion:5});
  assert.equal(createHash('sha256').update(current.AB_LOADER_TEMPLATE).digest('hex'),registry['1.1.1'].sha256);
  assert.equal(createHash('sha256').update(previous.AB_LOADER_TEMPLATE).digest('hex'),'87d6c6be15e2b64cde17edad3e3fcd51c105b1b3d5ffcaa8e00596cb738add70');
  for(const name of ['fetch','XMLHttpRequest','sendBeacon','localStorage','sessionStorage','cookie','__tcfapi','__gpp','__uspapi'])assert.equal(current.AB_LOADER_TEMPLATE.includes(name),false,name);
});

test('soft B deadline requests control but the original verified B can still win',()=>{
  const p=page(),b=p.scripts[0];p.advance(8000);const a=p.scripts[1];
  assert.equal(p.scripts.length,2);assert.notEqual(b.removed,true);assert.equal(p.state().fallback,false);assert.equal(p.state().fallbackRequested,true);
  assert.equal(p.load(b),true);assert.equal(p.state().executionArm,'B');assert.equal(p.state().scriptRelease,'builtin-release-'+'b'.repeat(64));
  assert.equal(p.runtime(a),false);assert.equal(p.starts.length,1);assert.equal(p.timers.size,0);
  assert.equal(events(p,'fallback').length,0);assert.equal(events(p,'fallback-requested').length,1);assert.equal(events(p,'runtime-started')[0].arm,'B');
});

test('both deadlines leave pending arms eligible without retry loops; actual A execution retains assigned B',()=>{
  const p=page();p.advance(16000);const [b,a]=p.scripts;
  assert.equal(p.timers.size,0);assert.equal(p.state().status,'waiting-for-arm');assert.equal(p.state().armStatus,'pending');
  assert.equal(p.state().attempts.filter(row=>row.eligible).length,2);assert.equal(events(p,'terminal-failure').length,0);
  p.advance(120000);assert.equal(p.scripts.length,2);assert.equal(p.load(a),true);assert.equal(p.runtime(b),false);
  assert.equal(p.state().fallback,true);assert.equal(p.state().executionArm,'A');assert.equal(p.state().originalVariant,'B');
  assert.deepEqual(p.service.getTargeting('Variant'),['B']);assert.deepEqual(events(p,'fallback').map(({fromArm,toArm})=>[fromArm,toArm]),[['B','A']]);
});

test('assigned A control retry is distinct from a B-to-A fallback',()=>{
  const p=page({trafficBPercent:50,random:0});p.advance(16000);const [first,second]=p.scripts;
  assert.equal(p.state().controlRetryRequested,true);assert.equal(p.state().fallbackRequested,false);
  assert.equal(p.load(first),true);assert.equal(p.runtime(second),false);assert.equal(p.state().fallback,false);
  assert.equal(events(p,'control-retry').length,1);assert.equal(events(p,'fallback').length,0);assert.equal(events(p,'fallback-requested').length,0);
  assert.equal(p.measurement().assignment.variant,'A');assert.equal(p.timers.size,0);
});

test('load without native startup is a definite failure and starts the one control attempt',()=>{
  const p=page(),b=p.scripts[0];b.onload();
  assert.equal(p.scripts.length,2);assert.equal(events(p,'arm-failed')[0].reason,'no-start');
  assert.equal(p.runtime(b),false);assert.equal(p.load(),true);assert.equal(p.state().fallback,true);assert.equal(p.timers.size,0);
  assert.equal(events(p,'fallback')[0].reason,'no-start');assert.equal(events(p,'runtime-started').length,1);
});

test('a failed fallback cannot revoke a still-pending original B',()=>{
  const p=page(),b=p.scripts[0];p.advance(8000);p.error();
  assert.equal(p.state().status,'waiting-for-arm');assert.equal(events(p,'terminal-failure').length,0);
  assert.equal(p.load(b),true);assert.equal(p.state().executionArm,'B');assert.equal(p.state().fallback,false);assert.equal(p.starts.length,1);
});

test('two definitive errors are terminal and cannot later claim native startup',()=>{
  const p=page(),b=p.scripts[0];p.error(b);const a=p.scripts[1];p.error(a);p.advance(120000);
  assert.equal(p.state().status,'control-load-error');assert.equal(events(p,'terminal-failure').length,1);
  assert.equal(p.runtime(b),false);assert.equal(p.runtime(a),false);assert.equal(p.scripts.length,2);assert.equal(p.timers.size,0);assert.equal(p.starts.length,0);
});

test('late targeting conflict blocks B and keeps only the existing control eligible',()=>{
  const p=page(),b=p.scripts[0];p.advance(8000);const a=p.scripts[1];p.service.setTargeting('TestId','publisher-change');
  assert.equal(p.scripts.length,2);assert.equal(p.runtime(b),false);assert.equal(p.load(a),true);
  assert.equal(p.state().variant,null);assert.equal(p.state().executionArm,'A');assert.equal(p.state().originalVariant,'B');
  assert.deepEqual(p.service.getTargeting('TestId'),[]);assert.equal(p.measurement().events.find(row=>row.type==='exclusion').phase,'after-assignment');
});

test('a native startup claim is monotonic and a foreign script never becomes the loader execution',()=>{
  const p=page();p.advance(8000);p.load();p.sandbox.__TESSERA_RUNTIME_STARTED=false;
  assert.equal(p.runtime(p.scripts[0]),false);assert.equal(p.state().runtimeStarted,true);assert.equal(p.starts.length,1);
  const foreign=page(),b=foreign.scripts[0];foreign.runtime({src:b.src});
  assert.equal(foreign.state().status,'existing-runtime-conflict');assert.equal(foreign.state().executionArm,null);
  assert.equal(events(foreign,'runtime-started').length,0);assert.equal(foreign.runtime(b),false);assert.deepEqual(foreign.service.getTargeting('Variant'),[]);
});

test('a publisher accessor changing keys in the setter excludes labels after one atomic B claim',()=>{
  const p=page();let reads=0;
  Object.defineProperty(p.sandbox,'adsKeywords',{configurable:true,get(){reads++;return reads===2?{Variant:'publisher'}:{};}});
  assert.equal(p.runtime(p.scripts[0]),true);p.advance(16000);
  assert.equal(p.scripts.length,1);assert.equal(p.starts.length,1);assert.equal(p.state().runtimeStarted,true);assert.equal(p.state().executionArm,'B');
  assert.equal(p.state().originalVariant,'B');assert.equal(p.state().variant,null);assert.deepEqual(p.service.getTargeting('Variant'),[]);
  assert.equal(events(p,'runtime-started').length,1);assert.equal(events(p,'exclusion').at(-1).phase,'after-assignment');
});

test('a publisher getter reentering the targeting gate cannot admit a retired B body',()=>{
  const p=page(),b=p.scripts[0];let reads=0;
  Object.defineProperty(p.sandbox,'adsKeywords',{configurable:true,get(){if(++reads===1)p.service.clearTargeting('Variant');return {};}});
  assert.equal(p.runtime(b),false);assert.equal(p.starts.length,0);assert.equal(p.scripts.length,2);
  assert.equal(p.load(),true);assert.equal(p.starts.length,1);assert.equal(p.state().executionArm,'A');assert.equal(p.state().originalVariant,'B');
});

test('a failed element creation is never mistaken for an anonymous native script',()=>{
  const p=page(),b=p.scripts[0];p.document.createElement=()=>{throw Error('synthetic DOM failure');};p.advance(8000);
  p.document.currentScript=null;assert.equal(Boolean(p.sandbox.__TESSERA_RUNTIME_STARTED),false);
  assert.equal(p.state().runtimeStarted,false);assert.equal(p.state().executionArm,null);assert.equal(p.load(b),true);
});

test('forced and pre-assignment excluded traffic stays outside randomized measurement',()=>{
  for(const options of [{search:'?tessera_ab=B'},{crypto:false},{keywords:{Variant:'publisher'}},{lockedGuard:true}]){
    const p=page(options);assert.equal(p.measurement().assignment,null);assert.deepEqual(p.service.getTargeting('TestId'),[]);
    p.load();assert.equal(p.timers.size,0);assert.equal(p.state().fallback,false);
  }
});

test('new compositions default to 1.1.1 while explicit 1.1.0 keeps its identity and original arm bytes',async()=>{
  const a=await syntheticDraft(),b=await syntheticDraft({runtimeVersion:'9.0.1',script:'window.arm="B";'}),input={site:'test-site',a,b,testId:'pending_1',name:'Pending recovery',trafficBPercent:50};
  const now=await composeAbBundle(input),old=await composeAbBundle({...input,loaderVersion:'1.1.0'});
  assert.equal(now.record.loader.version,'1.1.1');assert.equal(old.record.loader.version,'1.1.0');assert.notEqual(now.id,old.id);assert.notEqual(now.zipSha256,old.zipSha256);
  assert.deepEqual(now.files[now.record.arms.A.path],old.files[old.record.arms.A.path]);assert.deepEqual(now.files[now.record.arms.B.path],old.files[old.record.arms.B.path]);
});
