import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parse} from 'acorn';
import * as current from '../../worker/experiments/ab-loader-1.0.2.mjs';
import * as legacy from '../../worker/experiments/ab-loader-1.0.1.mjs';

const registry=JSON.parse(readFileSync(new URL('../../worker/experiments/ab-loader-registry.json',import.meta.url),'utf8'));
const arm=side=>({release:'builtin-release-'+side.toLowerCase().repeat(64),name:side,runtimeVersion:'3.25.1',path:'r/builtin-release-'+side.toLowerCase().repeat(64)+'/ads.js',sha256:'a'.repeat(64),integrity:'sha384-'+'A'.repeat(64)});
function page({L=current,keywords,existing={},slots=[],ready=true,search='',crypto=true,lockedGuard=false,failSet=null,lockedService=false}={}){
  let now=0,sequence=0;const timers=new Map(),scripts=[],starts=[],calls=[],values=new Map(Object.entries(existing).map(([k,v])=>[k,[].concat(v)]));
  const service={getTargeting(key){return values.get(key)?.slice()??[];},setTargeting(key,value){calls.push({kind:'set',receiver:this,args:[...arguments]});if(key===failSet)throw Error('injected label failure');values.set(key,[].concat(value));return this;},clearTargeting(key){calls.push({kind:'clear',receiver:this,args:[...arguments]});if(arguments.length)values.delete(key);else values.clear();return this;}};
  const nativeSet=service.setTargeting,nativeClear=service.clearTargeting;
  service.getSlots=()=>slots;
  service.refresh=function(){calls.push({kind:'refresh',receiver:this,args:[...arguments]});if(arguments[1]?.failure)throw Error('injected refresh failure');return this;};
  if(lockedService)Object.defineProperty(service,'setTargeting',{value:nativeSet,writable:false});
  const queue=[];
  const googletag={cmd:ready?{push(fn){fn();}}:queue,pubads(){return service;},display(){calls.push({kind:'display',receiver:this,args:[...arguments]});if(arguments[0]==='throwing')throw Error('injected display failure');return this;},setConfig(config){
    calls.push({kind:'config',receiver:this,args:[...arguments]});
    if(config?.failure)throw Error('injected configuration failure');
    if(config?.targeting===null)nativeClear.call(service);
    else for(const [key,value] of Object.entries(config?.targeting??{}))nativeSet.call(service,key,value);
    return this;
  }};
  const tag={src:'https://publisher.example/ads.js',nonce:'nonce'};
  const head={appendChild(el){scripts.push(el);el.parentNode=head;return el;},removeChild(el){el.parentNode=null;el.removed=true;return el;}};
  const document={currentScript:tag,head,createElement(){return {setAttribute(){}};}};
  const sandbox={document,googletag,location:{search},URL,console:{},starts,
    setTimeout(fn,delay){const id=++sequence;timers.set(id,{fn,due:now+delay});return id;},clearTimeout(id){timers.delete(id);}};
  if(crypto)sandbox.crypto={getRandomValues(a){a[0]=4294967295;return a;}};
  if(keywords)sandbox.adsKeywords=keywords;
  sandbox.window=sandbox;vm.createContext(sandbox);
  if(lockedGuard)Object.defineProperty(sandbox,'__TESSERA_RUNTIME_STARTED',{value:undefined,writable:true,configurable:false});
  const config={schema:L.AB_LOADER_CONFIG_SCHEMA,id:'abx-'+'c'.repeat(64),testId:'loader_102',name:'Loader protection',trafficBPercent:100,arms:{A:arm('A'),B:arm('B')},loader:{version:L.AB_LOADER_VERSION,sha256:registry[L.AB_LOADER_VERSION].sha256}};
  vm.runInContext(L.renderAbLoader(config),sandbox);
  return {sandbox,document,scripts,starts,timers,calls,service,nativeSet,nativeClear,values,
    state(){document.currentScript=null;return JSON.parse(JSON.stringify(sandbox.__tesseraAbLoader.snapshot()));},
    advance(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!next)break;now=next[1].due;timers.delete(next[0]);next[1].fn();}now=end;},
    flush(){googletag.cmd={push(fn){fn();}};while(queue.length)queue.shift()();},
    runtime(el){document.currentScript=el;return vm.runInContext('(function(){if(window.__TESSERA_RUNTIME_STARTED)return false;window.__TESSERA_RUNTIME_STARTED={};starts.push(document.currentScript);return true;})()',sandbox);},
    load(el=scripts.at(-1)){const result=this.runtime(el);el.onload?.();return result;},
    error(el=scripts.at(-1)){el.onerror?.();}};
}

test('1.0.2 template is ES5 and its new registry hash matches',()=>{
  parse(current.AB_LOADER_TEMPLATE,{ecmaVersion:5});
  assert.equal(createHash('sha256').update(current.AB_LOADER_TEMPLATE).digest('hex'),registry['1.0.2'].sha256);
  assert.equal(current.AB_LOADER_TEMPLATE.split(current.AB_LOADER_PLACEHOLDER).length,2);
});

test('regression evidence: 1.0.1 stays stuck on pending B and merges foreign reserved targeting',()=>{
  const p=page({L:legacy});p.advance(60000);
  assert.equal(p.scripts.length,1);assert.equal(p.state().runtimeStarted,false);
  p.service.setTargeting('Variant',['forged','B']);
  assert.deepEqual(p.service.getTargeting('Variant'),['forged','B']);
});

test('8 second deadline retries A once, retires B handlers and blocks B before A starts',()=>{
  const p=page(),b=p.scripts[0],staleLoad=b.onload;
  assert.match(b.src,/bbbb/);assert.equal(p.timers.size,1);
  p.advance(7999);assert.equal(p.scripts.length,1);
  p.advance(1);const a=p.scripts[1];assert.match(a.src,/aaaa/);
  assert.equal(b.removed,true);assert.equal(b.onload,null);assert.equal(b.onerror,null);
  assert.equal(p.runtime(b),false);assert.equal(p.starts.length,0);assert.equal(p.state().runtimeStarted,false);
  staleLoad();assert.equal(p.state().scriptRelease,arm('A').release);
  assert.equal(p.load(a),true);assert.equal(p.starts.length,1);assert.equal(p.timers.size,0);
  assert.equal(p.state().variant,'B');assert.equal(p.state().status,'fallback-control');
  assert.deepEqual(p.service.getTargeting('Variant'),['B']);
});

test('late B after control startup cannot execute a second runtime',()=>{
  const p=page(),b=p.scripts[0];p.advance(8000);p.load();
  assert.equal(p.runtime(b),false);assert.equal(p.starts.length,1);assert.equal(p.timers.size,0);
});

test('control failure is terminal and clears all deadline timers',()=>{
  for(const reason of ['timeout','error']){
    const p=page();p.advance(8000);
    if(reason==='timeout')p.advance(8000);else p.error();
    assert.equal(p.scripts.length,2);assert.equal(p.timers.size,0);
    assert.equal(p.state().status,'control-load-error');assert.equal(p.state().armStatus,reason);
    p.advance(60000);assert.equal(p.scripts.length,2);
  }
});

test('successful runtime start and load both clear the arm timer',()=>{
  const p=page();assert.equal(p.runtime(p.scripts[0]),true);assert.equal(p.timers.size,0);
  p.scripts[0].onload();p.advance(60000);assert.equal(p.scripts.length,1);
});

test('native error retries control only before a runtime starts',()=>{
  const p=page();p.error();assert.equal(p.scripts.length,2);p.load();p.error();
  assert.equal(p.scripts.length,2);assert.equal(p.starts.length,1);assert.equal(p.timers.size,0);
});

test('uninstallable startup accessor chooses A unlabelled before B insertion',()=>{
  const p=page({lockedGuard:true});assert.equal(p.scripts.length,1);assert.match(p.scripts[0].src,/aaaa/);
  assert.equal(p.state().variant,null);assert.equal(p.state().exclusionReason,'startup-guard-unavailable');
  assert.deepEqual(p.service.getTargeting('Variant'),[]);p.load();assert.equal(p.timers.size,0);
});

test('pre-existing keyword keys load A unlabelled, preserving originals and unrelated data',()=>{
  const keywords={Variant:['forged','B'],TestId:'other_test',section:'sport'},p=page({keywords});
  assert.match(p.scripts[0].src,/aaaa/);assert.equal(p.state().variant,null);
  assert.equal(p.state().status,'excluded-key-conflict');assert.deepEqual(keywords,{Variant:['forged','B'],TestId:'other_test',section:'sport'});
  assert.equal(p.sandbox.adsKeywords.section,'sport');assert.equal(Object.hasOwn(p.sandbox.adsKeywords,'Variant'),false);
  assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);
});

test('existing publisher service keys remain intact, with no Tessera labels added',()=>{
  const p=page({existing:{Variant:['publisher'],TestId:['publisher_test'],section:'sport'}});
  assert.match(p.scripts[0].src,/aaaa/);assert.equal(p.state().variant,null);
  assert.deepEqual(p.service.getTargeting('Variant'),['publisher']);assert.deepEqual(p.service.getTargeting('TestId'),['publisher_test']);
  assert.deepEqual(p.service.getTargeting('section'),['sport']);
  p.service.setTargeting('Variant','publisher_update');
  assert.deepEqual(p.service.getTargeting('Variant'),['publisher_update']);
});

test('keys introduced after assignment and before B startup retire B and choose unlabelled A',()=>{
  const p=page(),b=p.scripts[0],original={Variant:'forged',TestId:'forged_test',section:'news'};
  p.sandbox.ADS_KEYWORDS=original;
  assert.equal(p.runtime(b),false);assert.equal(p.starts.length,0);assert.equal(p.scripts.length,2);
  p.load();assert.equal(p.starts.length,1);assert.equal(p.state().variant,null);
  assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);
  assert.equal(original.TestId,'forged_test');assert.equal(p.sandbox.ADS_KEYWORDS.section,'news');
});

test('reserved writes before consent/GAM or later refresh exclude measurement and clear only owned values',()=>{
  const p=page();p.load();
  for(const key of ['Variant','TestId'])assert(p.service.getTargeting(key).length);
  const receiver=p.service.setTargeting('section',['news','local']);assert.equal(receiver,p.service);
  assert.equal(p.service.setTargeting('Variant',['forged','B']),p.service);
  assert.equal(p.state().variant,null);assert.equal(p.state().status,'excluded-key-conflict');
  assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);
  p.service.setTargeting('TestId','late_test');p.service.setTargeting('section','sport');
  assert.deepEqual(p.service.getTargeting('TestId'),[]);assert.deepEqual(p.service.getTargeting('section'),['sport']);
  assert.equal(p.timers.size,0);assert.equal(p.starts.length,1);
});

test('cleanup preserves current publisher values when they no longer match our owned labels',()=>{
  const p=page();p.nativeSet.call(p.service,'Variant','publisher');
  p.service.setTargeting('TestId','forged');
  assert.deepEqual(p.service.getTargeting('Variant'),['publisher']);assert.deepEqual(p.service.getTargeting('TestId'),[]);
});

test('modern GPT setConfig targeting cannot bypass reserved ownership, preserving all other config',()=>{
  const p=page();p.load();
  const original={targeting:{Variant:['forged','B'],TestId:['forged_test','loader_102'],section:'news'},singleRequest:true,custom:{value:1}},receiver={};
  assert.equal(p.sandbox.googletag.setConfig.call(receiver,original,'extra'),receiver);
  assert.equal(p.state().variant,null);assert.equal(p.state().status,'excluded-key-conflict');
  assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);assert.deepEqual(p.service.getTargeting('section'),['news']);
  assert.deepEqual(original.targeting.Variant,['forged','B']);assert.equal(original.targeting.TestId[0],'forged_test');
  const forwarded=p.calls.findLast(c=>c.kind==='config');
  assert.equal(forwarded.receiver,receiver);assert.equal(forwarded.args[1],'extra');
  assert.equal(forwarded.args[0].singleRequest,true);assert.equal(forwarded.args[0].custom,original.custom);
  assert.deepEqual(Object.keys(forwarded.args[0].targeting),['section']);
  assert.throws(()=>p.sandbox.googletag.setConfig({failure:true}),/injected configuration failure/);
});

test('modern GPT config preserves publisher-owned reserved updates when no Tessera labels were assigned',()=>{
  const p=page({existing:{Variant:'publisher'}});
  p.sandbox.googletag.setConfig({targeting:{Variant:'publisher_new',TestId:'publisher_test',section:'news'}});
  assert.deepEqual(p.service.getTargeting('Variant'),['publisher_new']);assert.deepEqual(p.service.getTargeting('TestId'),['publisher_test']);
  assert.equal(p.state().variant,null);
});

test('final refresh boundary catches either slot targeting API and preserves publisher slot data',()=>{
  for(const all of [false,true]){
    const values={Variant:['FORGED_SLOT'],TestId:['slot_test'],slot_section:['sport']},slot={getTargeting(key){return values[key]??[];}},p=page({slots:[slot]});
    p.load();const receiver={},args=all?[undefined,{changeCorrelator:false}]:[[slot],{changeCorrelator:false}];
    assert.equal(p.service.refresh.apply(receiver,args),receiver);
    assert.equal(p.state().variant,null);assert.equal(p.state().status,'excluded-key-conflict');
    assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);
    assert.deepEqual(values,{Variant:['FORGED_SLOT'],TestId:['slot_test'],slot_section:['sport']});
    const forwarded=p.calls.findLast(call=>call.kind==='refresh');assert.equal(forwarded.receiver,receiver);assert.equal(forwarded.args[0],args[0]);assert.equal(forwarded.args[1],args[1]);
  }
});

test('display boundary covers compatible runtimes that may dispatch an initial display',()=>{
  const slot={getTargeting(key){return key==='Variant'?['publisher_slot']:[];}},p=page({slots:[slot]}),receiver={};
  assert.equal(p.sandbox.googletag.display.call(receiver,'Billboard'),receiver);
  assert.equal(p.state().variant,null);assert.deepEqual(p.service.getTargeting('TestId'),[]);
  assert.deepEqual(slot.getTargeting('Variant'),['publisher_slot']);
  const forwarded=p.calls.findLast(call=>call.kind==='display');assert.equal(forwarded.receiver,receiver);assert.deepEqual(forwarded.args,['Billboard']);
});

test('dispatch boundary catches an otherwise bypassed page ownership change and preserves native errors',()=>{
  const p=page();p.load();p.nativeSet.call(p.service,'TestId','publisher_test');
  assert.throws(()=>p.service.refresh(null,{failure:true}),/injected refresh failure/);
  assert.equal(p.state().variant,null);assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),['publisher_test']);
  assert.throws(()=>p.sandbox.googletag.display('throwing'),/injected display failure/);
});

test('unrelated setters and clears forward receiver, arguments, return and errors',()=>{
  const p=page({failSet:'throwing'}),receiver={};
  assert.equal(p.service.setTargeting.call(receiver,'section',['a','b']),receiver);
  assert.equal(p.calls.at(-1).receiver,receiver);assert.deepEqual(p.calls.at(-1).args,['section',['a','b']]);
  assert.throws(()=>p.service.setTargeting('throwing','value'),/injected/);
  assert.equal(p.service.clearTargeting.call(receiver,'section'),receiver);
  assert.equal(p.calls.at(-1).receiver,receiver);
});

test('partial label failure and an unpatchable service choose A with no owned labels',()=>{
  for(const options of [{failSet:'TestId'},{lockedService:true}]){
    const p=page(options);assert.match(p.scripts[0].src,/aaaa/);assert.equal(p.state().variant,null);
    assert.deepEqual(p.service.getTargeting('Variant'),[]);assert.deepEqual(p.service.getTargeting('TestId'),[]);
    p.load();assert.equal(p.timers.size,0);
  }
});

test('GPT queue waits for exclusive labels; bounded queue failure cannot later start B',()=>{
  const p=page({ready:false});assert.equal(p.scripts.length,0);p.advance(7999);p.flush();
  assert.match(p.scripts[0].src,/bbbb/);assert.deepEqual(p.service.getTargeting('Variant'),['B']);p.load();assert.equal(p.timers.size,0);
  const q=page({ready:false});q.advance(8000);assert.match(q.scripts[0].src,/aaaa/);q.flush();
  assert.equal(q.scripts.length,1);assert.equal(q.state().variant,null);assert.deepEqual(q.service.getTargeting('Variant'),[]);q.load();assert.equal(q.timers.size,0);
});

test('forced QA and random failure remain unlabelled and do not retry a failing arm',()=>{
  for(const options of [{search:'?tessera_ab=B'},{crypto:false}]){
    const p=page(options);assert.equal(p.scripts.length,1);assert.deepEqual(p.service.getTargeting('Variant'),[]);
    p.error();assert.equal(p.scripts.length,1);assert.equal(p.timers.size,0);
  }
});
