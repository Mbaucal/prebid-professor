import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import * as current from '../../worker/experiments/ab-loader-1.1.0.mjs';

const registry=JSON.parse(readFileSync(new URL('../../worker/experiments/ab-loader-registry.json',import.meta.url),'utf8'));
const arm=side=>({release:'builtin-release-'+side.toLowerCase().repeat(64),name:side,runtimeVersion:'3.25.1',path:'r/builtin-release-'+side.toLowerCase().repeat(64)+'/ads.js',sha256:'a'.repeat(64),integrity:'sha384-'+'A'.repeat(64)});
export function loaderMeasurementPage({L=current,keywords,existing={},slots=[],ready=true,search='',crypto=true,lockedGuard=false,failSet=null,lockedService=false,random=4294967295}={}){
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
  if(crypto)sandbox.crypto={getRandomValues(a){a[0]=random;return a;}};
  if(keywords)sandbox.adsKeywords=keywords;
  sandbox.window=sandbox;vm.createContext(sandbox);
  if(lockedGuard)Object.defineProperty(sandbox,'__TESSERA_RUNTIME_STARTED',{value:undefined,writable:true,configurable:false});
  const config={schema:L.AB_LOADER_CONFIG_SCHEMA,...(L.AB_LOADER_VERSION==='1.1.0'?{site:'memory-site'}:{}),id:'abx-'+'c'.repeat(64),testId:'loader_memory',name:'Loader protection',trafficBPercent:100,arms:{A:arm('A'),B:arm('B')},loader:{version:L.AB_LOADER_VERSION,sha256:registry[L.AB_LOADER_VERSION].sha256}};
  vm.runInContext(L.renderAbLoader(config),sandbox);
  return {sandbox,document,scripts,starts,timers,calls,service,nativeSet,nativeClear,values,
    measurement(){document.currentScript=null;return JSON.parse(JSON.stringify(sandbox.__tesseraAbLoader.measurement()));},
    state(){document.currentScript=null;return JSON.parse(JSON.stringify(sandbox.__tesseraAbLoader.snapshot()));},
    advance(ms){const end=now+ms;for(;;){const next=[...timers].filter(([,t])=>t.due<=end).sort((a,b)=>a[1].due-b[1].due)[0];if(!next)break;now=next[1].due;timers.delete(next[0]);next[1].fn();}now=end;},
    flush(){googletag.cmd={push(fn){fn();}};while(queue.length)queue.shift()();},
    runtime(el){document.currentScript=el;return vm.runInContext('(function(){if(window.__TESSERA_RUNTIME_STARTED)return false;window.__TESSERA_RUNTIME_STARTED={};starts.push(document.currentScript);return true;})()',sandbox);},
    load(el=scripts.at(-1)){const result=this.runtime(el);el.onload?.();return result;},
    error(el=scripts.at(-1)){el.onerror?.();}};
}
