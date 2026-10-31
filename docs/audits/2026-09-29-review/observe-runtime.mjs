/** Historical audit experiment, not a passing regression specification.
 * Run after prepare-test-workspace.mjs. Extracts real generated functions;
 * fake clock/CMP/GPT/requestBids do NOT establish live consent or revenue.
 */
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parse} from 'acorn';
const source=readFileSync('.generated/tanjug-pilot/ads.js','utf8');
const functions=new Map();
function walk(node){
 if(!node||typeof node!=='object')return;
 if(node.type==='FunctionDeclaration')functions.set(node.id.name,source.slice(node.start,node.end));
 for(const child of Object.values(node))if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);
}
walk(parse(source,{ecmaVersion:'latest'}));
function clock(){
 let now=0,seq=0;const tasks=new Map();
 return {get now(){return now;},setTimeout(fn,delay){const id=++seq;tasks.set(id,{fn,at:now+delay});return id;},clearTimeout(id){tasks.delete(id);},
 advance(end){while(true){const next=[...tasks].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;tasks.delete(next[0]);next[1].fn();}now=end;},get pending(){return tasks.size;}};
}
function context(names,extra={}){
 const time=clock();const ctx=vm.createContext({window:{__PP_CONSENT_TIMEOUT:8000},setTimeout:time.setTimeout,clearTimeout:time.clearTimeout,...extra});
 for(const name of names){if(!functions.has(name))throw Error('Missing generated function '+name);vm.runInContext(functions.get(name),ctx);}
 return {ctx,time};
}
const consentEvents=[];let listener;
const consent=context(['getUSP','getTCF','decidePFromTCF','decidePFromUSP','resolveConsent'],{
 __tcfapi(command,version,callback){if(command==='addEventListener'){listener=callback;callback({listenerId:1,eventStatus:'cmpuishown',gdprApplies:true},true);}else if(command==='removeEventListener')listener=null;},
});
consent.ctx.resolveConsent(result=>consentEvents.push({at:consent.time.now,...result}),8000);
consent.time.advance(5000);
listener?.({listenerId:1,eventStatus:'useractioncomplete',gdprApplies:true,purpose:{consents:{1:true,3:true,4:true}},vendor:{consents:{755:true}}},true);
consent.time.advance(10000);

let refreshes=0;
const missing=context(['startATF'],{HAS_PREBID:true,BIDDERS:[{bidder:'synthetic'}],pbjs:{que:[]},googletag:{cmd:{push(fn){fn();}},pubads(){return {refresh(){refreshes++;}}}}});
missing.ctx.startATF([{getSlotElementId(){return 'Billboard';}}]);missing.time.advance(30000);

const grouped=[];
const auction=context(['runAtfGroup'],{PREBID_TIMEOUT_ATF:2500,getAdUnitTimeoutMs:()=>2500,log(){},applyPrebidTargetingToSlots(){},applyHbVerTargetingForSlots(){},
 googletag:{cmd:{push(fn){fn();}},pubads(){return {refresh(){grouped.push({event:'refresh',at:auction.time.now});}}}},
 pbjs:{requestBids(input){auction.time.setTimeout(()=>{grouped.push({event:'simulated bids back after pre-auction wait',at:auction.time.now});input.bidsBackHandler();},5700);}},
});
auction.ctx.runAtfGroup('ATF',[{}],['Billboard'],[{}]);auction.time.advance(8000);
console.log(JSON.stringify({scope:'Generated Tanjug functions with synthetic dependencies, not real Prebid/GPT or publisher traffic',consentEvents,missingPrebid:{queuedCallbacks:missing.ctx.pbjs.que.length,pendingTimers:missing.time.pending,refreshes},grouped},null,2));
