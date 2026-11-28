import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {OBSERVER435_REPORTING_SOURCE,OBSERVER435_BEFORE,observer435PatchedSource,observer435Modules} from '../../scripts/observer435-patch.mjs';

function realm({missing=false,constructorError=false,observeError=false,disconnectError=false,removeError=false,listenError=false}={}){
  const listeners=new Map(),instances=[];
  const view={document:null,addEventListener(type,callback){if(listenError)throw Error('listener');if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(callback);},
    removeEventListener(type,callback){if(removeError)throw Error('remove');listeners.get(type)?.delete(callback);}};
  if(!missing)view.ReportingObserver=class{
    constructor(callback,options){if(constructorError)throw Error('constructor');this.callback=callback;this.options=options;this.observed=0;this.disconnected=0;this.records=[];instances.push(this);}
    observe(){this.observed++;if(observeError)throw Error('observe');}
    takeRecords(){return this.records.splice(0);}
    disconnect(){this.disconnected++;if(disconnectError)throw Error('disconnect');}
  };
  const document={defaultView:view};view.document=document;
  return{view,document,instances,listeners,hide(persisted=false){for(const callback of [...listeners.get('pagehide')??[]])callback({persisted});}};
}
function helper(global=realm()){
  const sandbox={window:global.view};
  vm.runInNewContext(OBSERVER435_REPORTING_SOURCE.replace('export function ','function ')+'\nglobalThis.register=registerReportingObserver;',sandbox);
  return{register:sandbox.register,global};
}

test('registers in the rendered document realm, keeps the API and exact intervention payload',()=>{
  const renderer=realm(),creative=realm(),{register}=helper(renderer),messages=[];
  const cleanup=register(report=>messages.push(report),['intervention'],creative.document);
  assert.equal(typeof cleanup,'function');assert.equal(renderer.instances.length,0);assert.equal(creative.instances.length,1);
  const observer=creative.instances[0];assert.equal(observer.observed,1);assert.equal(observer.options.buffered,true);assert.deepEqual(observer.options.types,['intervention']);
  const report={type:'intervention',body:{id:'HeavyAdIntervention',message:'fixture'}};
  observer.callback([report,{type:'ignored-second-record'}]);assert.deepEqual(messages,[report]);
  assert.equal(typeof creative.view.ReportingObserver,'function');assert.equal(typeof renderer.view.ReportingObserver,'function');
});
test('non-persisted pagehide drains queued reports once, disconnects and ignores late callbacks',()=>{
  const creative=realm(),{register}=helper(),messages=[];
  const cleanup=register(report=>messages.push(report),['intervention'],creative.document),observer=creative.instances[0];
  observer.records.push({type:'intervention',body:{id:'queued'}});creative.hide();
  assert.equal(observer.disconnected,1);assert.equal(creative.listeners.get('pagehide').size,0);
  observer.callback([{type:'late'}]);cleanup();creative.hide();assert.equal(observer.disconnected,1);
  assert.deepEqual(messages,[{type:'intervention',body:{id:'queued'}}]);
});
test('BFCache entry preserves reporting until a later non-persisted pagehide',()=>{
  const creative=realm(),{register}=helper(),messages=[];
  register(report=>messages.push(report),['intervention'],creative.document);const observer=creative.instances[0];
  creative.hide(true);assert.equal(observer.disconnected,0);assert.equal(creative.listeners.get('pagehide').size,1);
  observer.callback([{type:'restored'}]);assert.deepEqual(messages,[{type:'restored'}]);
  creative.hide(false);assert.equal(observer.disconnected,1);assert.equal(creative.listeners.get('pagehide').size,0);
});
test('same-document rerender replaces only the previous registration and flushes its pending payload',()=>{
  const creative=realm(),other=realm(),{register}=helper(),messages=[];
  const first=register(report=>messages.push(['first',report]),['intervention'],creative.document);
  register(report=>messages.push(['other',report]),['intervention'],other.document);
  const old=creative.instances[0];old.records.push({id:'old-queued'});
  register(report=>messages.push(['second',report]),['intervention'],creative.document);
  assert.equal(old.disconnected,1);assert.equal(creative.listeners.get('pagehide').size,1);assert.equal(other.instances[0].disconnected,0);
  old.callback([{id:'stale'}]);creative.instances[1].callback([{id:'current'}]);other.instances[0].callback([{id:'other-current'}]);first();
  assert.equal(creative.instances[1].disconnected,0);
  assert.deepEqual(messages,[['first',{id:'old-queued'}],['second',{id:'current'}],['other',{id:'other-current'}]]);
});
test('an explicit inactive or null document never falls back to the persistent renderer',()=>{
  const {register,global}=helper();
  for(const document of [{defaultView:null},null]){const cleanup=register(()=>assert.fail('must not report'),['intervention'],document);assert.equal(typeof cleanup,'function');cleanup();}
  assert.equal(global.instances.length,0);
});
test('omitted document retains the helper default-window contract',()=>{
  const {register,global}=helper(),messages=[];register(report=>messages.push(report),['intervention']);
  assert.equal(global.instances.length,1);global.instances[0].callback([{id:'default'}]);assert.deepEqual(messages,[{id:'default'}]);
});
test('unavailable API adds no listeners and never affects rendering',()=>{
  const creative=realm({missing:true}),{register}=helper();assert.doesNotThrow(()=>register(()=>{},['intervention'],creative.document)());
  assert.equal(creative.instances.length,0);assert.equal(creative.listeners.size,0);
});
for(const key of ['constructorError','observeError','listenError'])test(`${key} remains a best-effort reporting failure and releases partial setup`,()=>{
  const creative=realm({[key]:true}),{register}=helper();let cleanup;
  assert.doesNotThrow(()=>{cleanup=register(()=>{},['intervention'],creative.document);});assert.doesNotThrow(cleanup);
  if(creative.instances.length)assert.equal(creative.instances[0].disconnected,1);
  assert.equal(creative.listeners.get('pagehide')?.size??0,0);
});
test('cleanup tolerates disconnect/listener/callback errors and disables already queued callbacks',()=>{
  const creative=realm({disconnectError:true,removeError:true}),{register}=helper();let calls=0;
  const cleanup=register(()=>{calls++;throw Error('consumer');},['intervention'],creative.document),observer=creative.instances[0];
  observer.records.push({id:'pending'});assert.doesNotThrow(cleanup);assert.equal(calls,1);assert.equal(observer.disconnected,1);
  assert.doesNotThrow(()=>observer.callback([{id:'late'}]));assert.doesNotThrow(cleanup);assert.equal(calls,1);
});
test('empty browser batches do not emit an undefined intervention',()=>{
  const creative=realm(),{register}=helper();register(()=>assert.fail('empty report'),['intervention'],creative.document);
  assert.doesNotThrow(()=>creative.instances[0].callback([]));
});
test('source patch fails closed on unreviewed upstream source without modifying any bytes',()=>{
  assert.equal(Object.keys(OBSERVER435_BEFORE).length,3);
  for(const name of Object.keys(OBSERVER435_BEFORE))assert.throws(()=>observer435PatchedSource(name,'unreviewed source'),/Unexpected upstream source/);
});
test('a retained disposed handle releases its document and window references',()=>{
  const source=OBSERVER435_REPORTING_SOURCE.replace('export function ','function ');
  const code=`import vm from 'node:vm';
    const sandbox={window:{document:{}}};
    vm.runInNewContext(${JSON.stringify(source)}+'\\nglobalThis.register=registerReportingObserver;',sandbox);
    function setup(){
      const view={addEventListener(){},removeEventListener(){},ReportingObserver:class{observe(){}disconnect(){}takeRecords(){return[];}}};
      const document={defaultView:view};view.document=document;
      const stop=sandbox.register(()=>{},['intervention'],document);
      const result={stop,document:new WeakRef(document),view:new WeakRef(view)};
      stop();return result;
    }
    const retained=setup();
    for(let i=0;i<20;i++){await new Promise(resolve=>setImmediate(resolve));globalThis.gc();}
    if(retained.document.deref()||retained.view.deref())throw Error('Disposed handle still roots rendered document/window');
    retained.stop();
  `;
  const result=spawnSync(process.execPath,['--expose-gc','--input-type=module'],{input:code,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
test('explicit site modules preserve every requested adapter without silently adding the Tanjug profile',()=>{
  const modules=['consentManagementTcf','tcfControl','connectadBidAdapter','smartadserverBidAdapter','ixBidAdapter'];
  assert.deepEqual(observer435Modules({version:'11.34.0',modules},true),modules.slice().sort());
  assert(!observer435Modules({version:'11.34.0',modules},true).includes('pubmaticBidAdapter'));
});
test('invalid, test-only, and implicit-version module selections fail before building',()=>{
  for(const profile of [null,{version:'11.11.0',modules:['consentManagementTcf','tcfControl']},
    {version:'11.34.0',modules:['consentManagementTcf','tcfControl','../bad']},
    {version:'11.34.0',modules:['consentManagementTcf','tcfControl','contextualAuditRtdProvider']},
    {version:'11.34.0',modules:['connectadBidAdapter']}])assert.throws(()=>observer435Modules(profile,true));
});
