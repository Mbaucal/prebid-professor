/** Independent baseline observations. No hosted reads, writes or ad traffic. */
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import vm from 'node:vm';
import {stripTypeScriptTypes} from 'node:module';
import {execFileSync} from 'node:child_process';
import {parse} from 'acorn';
import {createTesseraReadiness} from '../worker/runtime-readiness-v1/browser-readiness.mjs';
import {parsePrebidHeader} from '../worker/runtime/prebid-artifact-check.mjs';
import {fixture, configure, TS} from '../tests/runtime/artifact-fixture.mjs';
import {previewInput} from '../worker/runtime-316/snapshot.mjs';
import {compileRuntime316} from '../worker/runtime-316/compiler.mjs';
import {descriptor} from '../.generated/runtime-316-manifest.mjs';
import {buildReference391} from '../.generated/reference391.mjs';
import {positionFixture} from '../tests/support/position-runtime-fixture.mjs';

const results=[];
const BASE='3be20bd888ffdcae486d6c7e876b6e4c49adbd61';
const baselineSource=path=>execFileSync('git',['show',BASE+':'+path],{cwd:new URL('../',import.meta.url),encoding:'utf8'});
function observe(id,name,detail){results.push({id,name,detail});}
function functionSource(source,name){
 const found=[];function walk(node){if(!node||typeof node!=='object')return;if(node.type==='FunctionDeclaration'&&node.id?.name===name)found.push(node);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(walk);else if(value&&typeof value==='object')walk(value);}
 walk(parse(source,{ecmaVersion:'latest',sourceType:'module'}));assert.equal(found.length,1,name+' must be unique');return source.slice(found[0].start,found[0].end);
}
function readinessFixture(){
 let time=0, sequence=0, cmp;const timers=new Map(),events=new Map(),sent=[],blocked=[],requests=[];
 const win={setTimeout(fn,ms){timers.set(++sequence,{fn,at:time+ms});return sequence;},clearTimeout(id){timers.delete(id);},
  __tcfapi(command,version,cb){if(command==='addEventListener')cmp=cb;}};
 const pb={current:{},setConfig(){},onEvent(name,cb){events.set(cb,name);},offEvent(name,cb){events.delete(cb);},
  requestBids(input){requests.push(input);},getAdserverTargetingForAdUnitCode(){return this.current;}};win.pbjs=pb;
 const slot={id:'P1',targeting:{},getSlotElementId(){return this.id;}};
 const gate=createTesseraReadiness(win,{rawRequest:(p,input)=>p.requestBids(input),rawDispatch(service,slots){
  for(const s of slots){if(s.id==='guard'&&!win.allowGuard)blocked.push(s.id);else sent.push({...s.targeting});}},
  code:s=>s.id,clear(s){s.targeting={};},apply(s,t){Object.assign(s.targeting,t);}});
 function tick(ms){const end=time+ms;for(let n=0;n<10000;n++){const due=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].fn();}time=end;}
 cmp({gdprApplies:false},true);
 return{win,pb,gate,slot,tick,events,sent,blocked,requests};
}
{
 const f=readinessFixture();const guard={id:'guard',targeting:{}};f.win.allowGuard=true;
 try{f.gate.dispatch({},[guard]);}finally{f.win.allowGuard=false;}
 assert.equal(f.sent.length,0);f.tick(0);assert.equal(f.blocked.length,1);assert.equal(f.sent.length,0);
 observe('T04','ready CMP still defers guard dispatch until after one-use flag reset',{blocked:f.blocked.length,sent:f.sent.length});
}
for(const secondary of [false,true]){
 const f=readinessFixture();f.gate.request(f.pb,{adUnits:[{code:'P1'}],timeout:500});f.tick(0);
 const r=f.requests.at(-1);for(const[fn,name]of f.events)if(name==='auctionInit')fn({auctionId:r.auctionId});
 f.pb.current={hb_adid:'valid',hb_pb:'2.00',...(secondary?{hb_adid_short:'expired-secondary',hb_pb_short:'0.50'}:{})};
 const bids=[{auctionId:r.auctionId,adUnitCode:'P1',cpm:2,adId:'valid'},...(secondary?[{auctionId:r.auctionId,adUnitCode:'P1',cpm:0.5,adId:'expired-secondary'}]:[])];
 r.bidsBackHandler({P1:{bids}},false,r.auctionId);
 f.pb.current=secondary?{hb_adid:'valid',hb_pb:'2.00'}:{};
 f.tick(90000);f.gate.dispatch({},[f.slot]);f.tick(0);
 assert.equal(f.sent[0].hb_adid,'valid');if(secondary)assert.equal(f.sent[0].hb_adid_short,'expired-secondary');
 observe('T06',secondary?'expired secondary targeting survives live Prebid omission':'expired winning targeting survives empty live Prebid targeting',{live:f.pb.current,sent:f.sent[0],auctions:f.requests.length});
}
{
 const source=baselineSource('worker/runtime-controls-release.ts');
 const start=source.indexOf('function escapeRegExp('),end=source.indexOf('function patchGenericSticky(');
 const helpers=stripTypeScriptTypes(source.slice(start,end));const context=vm.createContext({});
 vm.runInContext(helpers+'\nthis.after=ensureVarAfter("var BIDDER_FLOORS = {};", "BIDDER_FLOORS", "FLOOR_RULES", {});this.metadata=ensureWindowMetadata("window.ADOPS_GENERATOR_PROFILE = \\\"x\\\";", "x", "1");',context);
 for(const kind of ['after','metadata']){assert(context[kind].includes('\\n'));assert.throws(()=>parse(context[kind],{ecmaVersion:'latest'}));}
 observe('T27','actual extracted TS postprocessing helpers emit unparseable literal slash-n',{after:context.after,metadata:context.metadata});
}
for(const module of ['33acrossBidAdapter','51DegreesRtdProvider','1plusXRtdProvider']){
 assert.throws(()=>parsePrebidHeader('/* prebid.js v11.34.0\nModules: consentManagementTcf, tcfControl, '+module+' */'));
}
observe('T08','valid numeric-leading module names are rejected',{modules:['33acrossBidAdapter','51DegreesRtdProvider','1plusXRtdProvider']});
for(const variant of ['none','only-exact','default-disabled']){
 const snapshot=configure(fixture(),config=>{config.enablePrebid=false;});
 if(variant==='only-exact')snapshot.rules=[{rule_key:'P1',rule_json:'{"refresh":{"enabled":true,"minSeconds":30,"minViewPct":50}}'}];
 if(variant==='default-disabled')snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":false}}'},{rule_key:'P1',rule_json:'{"refresh":{"enabled":true,"minSeconds":30,"minViewPct":50}}'}];
 const input=previewInput(snapshot,descriptor,TS);const output=compileRuntime316(input);
 assert.equal(input.core.globalRefresh.enabled,false);assert.match(output.adsJs,/var REFRESH_ENABLED = false;/);
 observe('T01','actual stable snapshot and compiler disable global refresh '+variant,{global:input.core.globalRefresh,exact:input.core.adUnitRules.P1??null});
}
{
 const snapshot=fixture();const input=previewInput(snapshot,descriptor,TS);const output=compileRuntime316(input);
 observe('T20','duplicate responseInfo blocks in actual stable generated source',{declarations:output.adsJs.split('var responseInfoAtRender = null').length-1});
 assert.equal(output.adsJs.split('var responseInfoAtRender = null').length-1,2);
 const base=JSON.parse(snapshot.config.config_json);delete base.userSync;snapshot.config.config_json=JSON.stringify(base);
 assert.equal(previewInput(snapshot,descriptor,TS).core.userSync.syncEnabled,false);
 observe('T03','missing persisted userSync compiles to disabled',{userSync:previewInput(snapshot,descriptor,TS).core.userSync});
 let es2015=true;try{parse(output.adsJs,{ecmaVersion:2015});}catch{es2015=false;}
 assert.equal(es2015,false);observe('T25','stable Prebid program exceeds ES2015 syntax',{es2015});
}
{
 const baseline=configure(fixture(),config=>{config.enablePrebid=false;});
 baseline.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":true,"minSeconds":30,"minGapSeconds":120,"minViewPct":50}}'}];
 const source=compileRuntime316(previewInput(baseline,descriptor,TS)).adsJs;
 const context=vm.createContext({_slotState:{P1:{dwellTimer:1,dwellDeadline:30000,dwellRemainingMs:null}},now:()=>10000,clearTimeout(){}});
 vm.runInContext(functionSource(source,'clearDwell')+'\nclearDwell("P1",true);this.first=_slotState.P1.dwellRemainingMs;clearDwell("P1",true);this.second=_slotState.P1.dwellRemainingMs;',context);
 assert.equal(context.first,20000);assert.equal(context.second,null);
 observe('T14','double pause erases previously preserved dwell in actual generated function',{first:context.first,second:context.second});
 const queued=[],retry=[];const rule={enabled:true,minSeconds:30,minGapSeconds:120,minViewPct:50};
 const refresh=vm.createContext({window:{},pageActive:()=>true,log(){},REFRESH_EXCLUDE_IDS:[],_refreshCounts:{},MAX_REFRESHES_PER_SLOT:20,
  canRefreshSlotNow:()=>({ok:true}),scheduleRefreshGuardRetry:(id,reason)=>retry.push({id,reason}),getAdUnitRefreshRule:()=>rule,
  _lastRefreshAt:{P1:30000},now:()=>90000,_slotMeta:{},GAM_NOREFRESH_ADVERTISER_IDS:[],STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',
  enqueueRefresh:(id)=>queued.push(id),_gamReporting:{plan(){}},slot:{setConfig(){}}});
 vm.runInContext(functionSource(source,'tryRefresh')+'\ntryRefresh("P1",slot,30);',refresh);
 assert.equal(queued.length,1);assert.equal(refresh._refreshCounts.P1,1);
 observe('T11','actual generated tryRefresh ignores saved 120-second wall-clock gap',{sinceSeconds:60,minGapSeconds:120,queued:queued.length});
 observe('T18','refresh count increments before enqueue reaches actual dispatch',{queued:queued.length,actualDispatched:0,count:refresh._refreshCounts.P1});
 refresh.canRefreshSlotNow=()=>({ok:false,reason:'refresh disabled'});
 vm.runInContext('tryRefresh("P1",slot,30);',refresh);assert.equal(retry.length,1);
 observe('T16','disabled refresh still schedules guard retry',{retries:retry.length});
 const polls=[],merged=[];const late=vm.createContext({window:{},ADS_KEYWORDS:{},setTimeout:(fn,ms)=>polls.push({fn,ms}),mergeKV:obj=>merged.push(obj),log(){}});
 vm.runInContext(functionSource(source,'lateMergeTargeting')+'\nlateMergeTargeting(2500,250);window.adsKeywords={category:"late"};',late);
 assert.equal(polls.length,0);assert.equal(merged.length,1);
 observe('T15','empty default ADS_KEYWORDS short-circuits polling for later window keywords',{scheduledPolls:polls.length,mergedEmptyDefaults:merged.length});
 const guard=vm.createContext({_slotState:{Sticky:{}},getAdUnitRefreshRule:()=>({enabled:true,minViewPct:50}),getSlotViewPct:()=>0});
 vm.runInContext(functionSource(source,'canRefreshSlotNow')+'\nthis.result=canRefreshSlotNow("Sticky");',guard);
 assert.equal(guard.result.ok,false);observe('T13','empty hidden Sticky geometry cannot pass ordinary minimum-view guard',{viewPct:0,minViewPct:50,result:guard.result});
 const schedules=[];const lateWrappers=vm.createContext({window:{__ADS_WAITING_FOR_SLOTS:true},DEBUG_MODE:false,defineAllSlots(){},setTimeout:(fn,ms)=>schedules.push(ms)});
 vm.runInContext(functionSource(source,'scheduleDefineSlotsRetry')+'\nscheduleDefineSlotsRetry("only sticky wrappers");scheduleDefineSlotsRetry("only sticky wrappers");',lateWrappers);
 assert.equal(schedules.length,2);observe('T05','actual generated retry function has no deduplication for repeat sticky-only calls',{scheduled:schedules});
}
{
 const raw=baselineSource('worker/release-size-map-compat.ts');
 const source=stripTypeScriptTypes(raw);const ctx=vm.createContext({});
 vm.runInContext(functionSource(source,'activeBreakpoint')+'\nthis.row=activeBreakpoint([{minViewPort:[768,0],sizes:[[300,600]]}],0);',ctx);
 assert.equal(ctx.row.minViewPort[0],768);observe('T09','actual CSS helper falls forward to desktop row at width zero',{width:0,chosenMinWidth:ctx.row.minViewPort[0]});
}
{
 const r=readinessFixture();delete r.win.pbjs;const completed=[];
 r.gate.prebid(()=>assert.fail('library should be absent'),()=>completed.push(1));r.tick(3000);
 r.gate.prebid(()=>assert.fail('library should be absent'),()=>completed.push(2));r.tick(2999);assert.equal(completed.length,1);r.tick(1);assert.equal(completed.length,2);
 observe('T24','missing Prebid repeats full readiness wait on next request',{fallbacks:completed.length,waitPerCallMs:3000});
}
{
 const snapshot=configure(fixture(),config=>{config.advancedUnitRules={__DEFAULT__:{timeout:2500,refresh:{enabled:true,minSeconds:30}},P1:{refresh:{enabled:true,minSeconds:15}}};});
 snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"timeout":1200,"refresh":{"enabled":false}}'}];
 const input=previewInput(snapshot,descriptor,TS);assert.equal(input.core.defaultTimeout,2500);assert.equal(input.core.globalRefresh.enabled,true);assert(input.core.adUnitRules.P1);
 observe('T02','saved advanced shadow data wins over edited basic timeout/disabled refresh and deleted exact rule',{defaultTimeout:input.core.defaultTimeout,refreshEnabled:input.core.globalRefresh.enabled,deletedExactStillPresent:!!input.core.adUnitRules.P1});
}
{
 const snapshot=fixture();snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":true,"minSeconds":60}}'}];
 const input=previewInput(snapshot,descriptor,TS);assert.equal(input.options.sticky.refreshSeconds,30);
 const output=compileRuntime316(input).adsJs;assert.match(output,/var STICKY_REFRESH_SEC = 30;/);
 observe('T12','stable snapshot seeds 30-second Sticky timer despite inherited 60-second refresh',{inherited:60,stickyTimer:input.options.sticky.refreshSeconds});
 const migration=configure(fixture(),config=>{config.runtimeControls.targeting={pageTypeKeys:['category']};});
 const source=compileRuntime316(previewInput(migration,descriptor,TS)).adsJs;
 assert.match(source,/var PAGE_TYPE_KEYS = \[\s*"pageType"\s*\];/);
 observe('T17','unsupported migration targeting field is not represented by stable adapter',{requested:['category'],generated:['pageType'],classification:'migration capability gap, not proof of a supported setting regression'});
 const overlay=previewInput(positionFixture(false),descriptor,TS);assert.deepEqual(overlay.options.takeOver.desktopSize,[300,250]);
 assert.deepEqual(overlay.overlay.maps.at(-1).sizes[0],[800,600]);
 observe('T23','TakeOver diagnostic seeded size differs from responsive desktop row',{seededDesktop:overlay.options.takeOver.desktopSize,actual1400Row:overlay.overlay.maps.at(-1).sizes[0]});
 const camel=source.match(/\.setProperty\(["'](?:zIndex|pointerEvents|alignItems|justifyContent|borderRadius|fontFamily|fontSize|lineHeight|boxShadow|userSelect)["']/g)??[];
 assert.equal(camel.length,13);assert.match(source,/var ALLOW_CLOSE_PORTAL = false;/);
 observe('T19','invalid CSS property spelling remains but portal is deliberately disabled in built-in output',{camelCaseCalls:camel.length,portalEnabled:false,classification:'conditional legacy portal defect; built-in default visual impact unproven'});
}
{
 const snapshot=fixture();snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"timeout":45000}'}];
 assert.throws(()=>previewInput(snapshot,descriptor,TS),/Auction timeout/);
 const id=configure(fixture(),config=>{config.userSync.userIds=[{name:'id5Id',params:{partner:'1355'}}];});
 assert.throws(()=>compileRuntime316(previewInput(id,descriptor,TS)),/id5Id.params.partner must be a number/);
 const unicode=fixture();unicode.bidders[0].params_json=JSON.stringify({siteId:'glo\u2028bal'});
 assert.throws(()=>compileRuntime316(previewInput(unicode,descriptor,TS)),/does not contain variable BIDDERS/);
 observe('T21','actual stable generation rejects saved 45s group timeout, string ID5 and Unicode separator bidder params',{groupTimeout45000:'rejected',quotedId5:'rejected',unicodeBidder:'misleading template-variable error'});
}
{
 const snapshot=configure(fixture(),config=>{config.runtimeControls.schain={enabled:true,ver:'1.0',complete:1,nodes:[{asi:'seller.test',sid:'s$&t',hp:1,name:'X$$Y'}]};});
 const input=previewInput(snapshot,descriptor,TS);const output=compileRuntime316(input);
 assert(output.adsJs.includes('s__SCHAIN_CONFIG_LINE__t'));assert(output.adsJs.includes('X$Y'));
 observe('T22','actual stable compiler corrupts String.replace metacharacters in saved SChain',{sidCorrupted:true,nameCorrupted:true});
}
{
 const settings={GAM_PATH:'/123/test/',AD_CONTAINER_SELECTOR:'.wrapperAd',STICKY_TARGET_ID:'Sticky',PREBID_TIMEOUT:2500,HARD_FLOOR_EUR:0.04,
  AD_UNITS:[{id:'Billboard',type:'ATF',sizes:[[300,250]]},{id:'Sticky',type:'ATF',sizes:[[320,100]]}],BIDDERS:[],USER_ID_MODULES:[]};
 const zero=buildReference391({...settings,MAX_REFRESHES_PER_SLOT:0},{buildTimestamp:TS});
 const badFloor=buildReference391({...settings,HARD_FLOOR_EUR:'0,04'},{buildTimestamp:TS});
 assert.match(zero,/var MAX_REFRESHES_PER_SLOT = 20;/);assert.match(badFloor,/var HARD_FLOOR_EUR = NaN;/);
 observe('T26','raw historical builder coerces supplied numeric zero and decimal comma incorrectly',{numericZeroRefreshCap:20,decimalCommaFloor:'NaN',scope:'raw builder inputs only; live Sheets reader absent and production effect not established'});
}
await mkdir(new URL('../.generated/audit-independent-review/',import.meta.url),{recursive:true});
await writeFile(new URL('../.generated/audit-independent-review/baseline-mechanisms.json',import.meta.url),JSON.stringify({base:'3be20bd888ffdcae486d6c7e876b6e4c49adbd61',scope:'Existing generated output and extracted actual helpers; fake timer/Prebid signals; no hosted traffic',results},null,2)+'\n');
console.log(JSON.stringify(results,null,2));
