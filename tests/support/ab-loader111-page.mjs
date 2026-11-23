import vm from 'node:vm';
import {createHash} from 'node:crypto';

/** Independent page model: real rendered loader, controlled browser callbacks and clock.
 * The runtime body uses only the same public startup property as a compiled arm.
 * Browser/SRI/CSP/native-Prebid behavior is covered separately by transport QA.
 */
export function loader111Page(L,{random=4294967295,traffic=50,existing={},keywords,ready=true,search='',lockedGuard=false}={}){
  let now=0,serial=0;const timers=new Map(),scripts=[],starts=[],dispatches=[],values=new Map(Object.entries(existing).map(([key,value])=>[key,[].concat(value)]));
  const service={
    setTargeting(key,value){values.set(key,[].concat(value));return this;},
    clearTargeting(key){if(arguments.length)values.delete(key);else values.clear();return this;},
    getTargeting(key){return values.get(key)?.slice()??[];},getSlots(){return [];},
    refresh(){dispatches.push(Object.fromEntries([...values].map(([key,value])=>[key,value.slice()])));return this;},
  };
  const commands=[],googletag={cmd:ready?{push(fn){fn();}}:commands,pubads(){return service;},display(){return this;},setConfig(config){
    if(config.targeting===null)service.clearTargeting();
    else for(const [key,value]of Object.entries(config.targeting??{}))service.setTargeting(key,value);
    return this;
  }};
  const entry={src:'https://publisher.example/ads.js',nonce:'qa-nonce'};
  const head={appendChild(script){scripts.push(script);script.parentNode=head;return script;},removeChild(script){script.parentNode=null;script.removed=true;return script;}};
  const document={currentScript:entry,head,createElement(){return {setAttribute(key,value){this[key]=value;}};}};
  const sandbox={window:null,document,googletag,location:{search},URL,console:{},starts,
    crypto:{getRandomValues(array){array[0]=random;return array;}},
    setTimeout(callback,delay){const id=++serial;timers.set(id,{callback,due:now+delay});return id;},
    clearTimeout(id){timers.delete(id);},
  };
  if(keywords)sandbox.adsKeywords=keywords;
  sandbox.window=sandbox;
  for(const key of ['localStorage','sessionStorage'])Object.defineProperty(sandbox,key,{get(){throw Error('Persistent storage touched');}});
  if(lockedGuard)Object.defineProperty(sandbox,'__TESSERA_RUNTIME_STARTED',{value:undefined,writable:true,configurable:false});
  const arm=side=>({release:'builtin-release-'+side.toLowerCase().repeat(64),name:side,runtimeVersion:'3.25.1',
    path:'r/builtin-release-'+side.toLowerCase().repeat(64)+'/ads.js',sha256:'a'.repeat(64),integrity:'sha384-'+'A'.repeat(64)});
  const config={schema:L.AB_LOADER_CONFIG_SCHEMA,site:'independent-qa',id:'abx-'+'c'.repeat(64),testId:'loader_qa',name:'Independent transport race',
    trafficBPercent:traffic,arms:{A:arm('A'),B:arm('B')},loader:{version:L.AB_LOADER_VERSION,sha256:createHash('sha256').update(L.AB_LOADER_TEMPLATE).digest('hex')}};
  vm.createContext(sandbox);vm.runInContext(L.renderAbLoader(config),sandbox);
  const result={sandbox,document,service,scripts,starts,dispatches,timers,config,
    state(){document.currentScript=null;return JSON.parse(JSON.stringify(sandbox.__tesseraAbLoader.snapshot()));},
    measurement(){document.currentScript=null;return JSON.parse(JSON.stringify(sandbox.__tesseraAbLoader.measurement()));},
    advance(milliseconds){const end=now+milliseconds;let budget=1000;for(;;){
      const next=[...timers].filter(([,timer])=>timer.due<=end).sort((a,b)=>a[1].due-b[1].due||a[0]-b[0])[0];if(!next)break;
      if(!--budget)throw Error('Unbounded timer loop');now=next[1].due;timers.delete(next[0]);next[1].callback();
    }now=end;},
    runtime(script,{dispatch=true}={}){document.currentScript=script;return vm.runInContext(`(function(){
      if(window.__TESSERA_RUNTIME_STARTED)return false;
      window.__TESSERA_RUNTIME_STARTED={source:document.currentScript.src};
      starts.push(document.currentScript);${dispatch?'googletag.pubads().refresh([]);':''}return true;
    })()`,sandbox);},
    load(script=scripts.at(-1),options){const accepted=this.runtime(script,options);document.currentScript=null;script.onload?.();return accepted;},
    onload(script=scripts.at(-1)){document.currentScript=null;script.onload?.();},
    error(script=scripts.at(-1)){document.currentScript=null;script.onerror?.();},
    flush(){googletag.cmd={push(fn){fn();}};while(commands.length)commands.shift()();},
  };
  return result;
}
