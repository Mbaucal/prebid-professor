import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {fixture} from './artifact-fixture.mjs';
import {descriptor as previousDescriptor} from '../../.generated/runtime-316-manifest.mjs';
import {previewInput as input316} from '../../worker/runtime-316/snapshot.mjs';
import {previewInput} from '../../worker/runtime-3162/snapshot.mjs';
import {compileRuntime316} from '../../worker/runtime-316/compiler.mjs';
import {compileRuntime3161} from '../../worker/runtime-3161/compiler.mjs';
import {compileRuntime3162} from '../../worker/runtime-3162/compiler.mjs';
import {refreshSummary} from '../../worker/site-runtime/refresh-summary.mjs';

const descriptor={...previousDescriptor,id:'tessera-3.16.2',version:'3.16.2'};
const stamp='20261025_120000';
function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const x of Object.values(node))if(Array.isArray(x))x.forEach(v=>walk(v,visit));else if(x&&typeof x==='object')walk(x,visit);}
const declarations=new Map();
function fn(source,name){
  if(!declarations.has(source)){const found={};walk(parse(source,{ecmaVersion:'latest'}),n=>{if(n.type==='FunctionDeclaration')(found[n.id.name]??=[]).push(source.slice(n.start,n.end));});declarations.set(source,found);}
  const nodes=declarations.get(source)[name]??[];assert.equal(nodes.length,1,name);return nodes[0];
}
const COMPILERS={'3.16.1':compileRuntime3161,'3.16.2':compileRuntime3162};
const builds=new Map();
/** The fixture site with these Unit rules rows, compiled by 3.16.1 or 3.16.2 from the same input. */
function compiled(version,config={}){
  const key=version+' '+JSON.stringify(config);
  if(!builds.has(key)){
    const snapshot=fixture();snapshot.rules=Object.entries(config).map(([rule_key,rule])=>({rule_key,rule_json:JSON.stringify(rule)}));
    const input=previewInput(snapshot,descriptor,stamp);
    builds.set(key,{snapshot,input,source:COMPILERS[version](input).adsJs});
  }
  return builds.get(key);
}
const CONSTANTS=['REFRESH_ENABLED','DWELL_MIN_VIEW_SEC','REFRESH_IN_VIEW_PCT','REFRESH_MOBILE_IN_VIEW_PCT','REFRESH_EXIT_PCT','MAX_REFRESHES_PER_SLOT',
  'MIN_SECONDS_BETWEEN_REFRESHES','MOBILE_MIN_SECONDS_BETWEEN_REFRESHES','DWELL_ACCUMULATE','REFRESH_MAX_INTERVAL_SEC'];
/** Global refresh constants exactly as the compiler emitted them. */
const emitted=new Map();
function constants(source){
  if(!emitted.has(source))emitted.set(source,Object.fromEntries(CONSTANTS.map(name=>{const found=[...source.matchAll(new RegExp(`\\n\\s*var ${name} = ([^;]+);`,'g'))];assert.equal(found.length,1,name);return [name,JSON.parse(found[0][1])];})));
  return {...emitted.get(source)};
}
const before=compiled('3.16.1').source,after=compiled('3.16.2').source;
// 3.16.0 counts a refresh when it is accepted, so its request times do not depend on send latency.
const older=compileRuntime316(input316(Object.assign(fixture(),{rules:[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:30,minViewPct:50}})}]}),previousDescriptor,stamp)).adsJs;
function clock(){let time=1000000,next=0;const timers=new Map();return{timers,now:()=>time,setTimeout(f,ms){timers.set(++next,{f,at:time+ms});return next;},clearTimeout(i){timers.delete(i);},tick(ms){const end=time+ms;for(let i=0;i<100000;i++){const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!due)break;time=due[1].at;timers.delete(due[0]);due[1].f();}time=end;}};}
const RULE_FUNCTIONS=['_plainMerge','getAdUnitRuntimeRule','getAdUnitRefreshRule'];
const plain=value=>JSON.parse(JSON.stringify(value));// objects from separate vm contexts
const unitType=input=>id=>input.core.explicitUnits.find(unit=>unit.id===id)||{};

/** The real generated rule resolution and view gate with the compiled constants; DOM geometry is a stub. */
function rules({source,input},{adUnitRules=input.core.adUnitRules,pct=100,loaded=true,mobile=false}={}){
  const ctx=vm.createContext({...constants(source),AD_UNIT_RULES:structuredClone(adUnitRules),TESSERA_OUTSTREAM:{disabledRefreshCodes:['Video']},getUnitConfigById:unitType(input),
    isMobile:()=>mobile,_refreshCounts:{},_slotState:{},getSlotViewPct:()=>pct,STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',_sticky:{closed:false},_stickyTop:{closed:true},
    document:{getElementById:()=>({classList:{contains:()=>loaded}})}});
  vm.runInContext([...RULE_FUNCTIONS,'canRefreshSlotNow'].map(name=>fn(source,name)).join('\n'),ctx);
  return ctx;
}

/** The real generated setupAutoRefresh visibility listener: for every GPT
 * inViewPercentage 0..100, whether a position enters view, and whether a
 * position that is in view leaves it. */
function visibility({source,input},{adUnitRules=input.core.adUnitRules,mobile=false}={}){
  const c=clock(),listeners={};
  const ctx=vm.createContext({...constants(source),AD_UNIT_RULES:structuredClone(adUnitRules),TESSERA_OUTSTREAM:{disabledRefreshCodes:[]},getUnitConfigById:unitType(input),
    isMobile:()=>mobile,_refreshCounts:{},_slotState:{},STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',REFRESH_EXCLUDE_IDS:[],pageActive:()=>true,log(){},tryRefresh(){},
    now:c.now,setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,document:{getElementById:()=>null},window:{adSlots:{Billboard:{},P1:{}}},
    googletag:{cmd:{push:f=>f()},pubads:()=>({addEventListener(type,cb){listeners[type]=cb;}})}});
  vm.runInContext([...RULE_FUNCTIONS,'setupAutoRefresh'].map(name=>fn(source,name)).join('\n')+'\nsetupAutoRefresh();',ctx);
  const emit=(id,pct)=>listeners.slotVisibilityChanged({slot:{getSlotElementId:()=>id},inViewPercentage:pct});
  const inView=id=>ctx._slotState[id]?.inView===true;
  const percentages=[...Array(101).keys()];
  return id=>({
    enters:percentages.map(pct=>{delete ctx._slotState[id];emit(id,pct);return inView(id);}),
    leaves:percentages.map(pct=>{delete ctx._slotState[id];emit(id,100);assert(inView(id));emit(id,pct);return !inView(id);}),
  });
}

const CONFIGS={
  'no rules':{},
  'Default timeout only':{__DEFAULT__:{timeout:1500}},
  'Default refresh without minViewPct':{__DEFAULT__:{refresh:{enabled:true,minSeconds:30}}},
  'Default explicit 0':{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minViewPct:0}}},
  'Default explicit 70':{__DEFAULT__:{refresh:{enabled:true,minSeconds:40,minViewPct:70,requirePreviousViewable:true,checkEveryMs:2500}}},
  'ATF group only':{__ATF__:{refresh:{enabled:true,minSeconds:45,minViewPct:60}}},
  'BTF group explicit 0':{__BTF__:{refresh:{minViewPct:0}}},
  'position explicit 0 under Default 70':{__DEFAULT__:{refresh:{minViewPct:70}},P1:{refresh:{minViewPct:0}}},
  'position override without minViewPct':{P1:{refresh:{enabled:true,minSeconds:45,schedule:{mode:'sequence',sequenceSeconds:[45,90]}}}},
  'disabled group, enabled position':{__BTF__:{refresh:{enabled:false}},P1:{refresh:{enabled:true}}},
  'disabled Default':{__DEFAULT__:{refresh:{enabled:false}}},
};
const saved=(config,code,type)=>[config.__DEFAULT__,config[type==='ATF'?'__ATF__':'__BTF__'],config[code]].some(rule=>rule?.refresh&&Object.hasOwn(rule.refresh,'minViewPct'));

test('R3-01: a missing minViewPct resolves to the inherited REFRESH_IN_VIEW_PCT; saved values, including 0, and every other field are unchanged',()=>{
  for(const [name,config] of Object.entries(CONFIGS)){
    const oldBuild=compiled('3.16.1',config),newBuild=compiled('3.16.2',config);
    const inherited=constants(newBuild.source).REFRESH_IN_VIEW_PCT;
    assert.deepEqual(constants(newBuild.source),constants(oldBuild.source),name+': the same compiled global constants');
    assert.equal(inherited,Number(newBuild.input.core.globalRefresh.minViewPct??50),name);
    const old=rules(oldBuild),next=rules(newBuild);
    for(const [code,type] of [['Billboard','ATF'],['P1','BTF'],['Sticky','ATF']]){
      const a=old.getAdUnitRefreshRule(code),b=next.getAdUnitRefreshRule(code);
      const explicit=saved(config,code,type);
      assert.equal(b.minViewPct,explicit?a.minViewPct:inherited,`${name} ${code}`);
      if(!explicit)assert.equal(a.minViewPct,0,`${name} ${code}: 3.16.1 reproduces R3-01`);
      assert.deepEqual(plain({...b,minViewPct:null}),plain({...a,minViewPct:null}),`${name} ${code}: enabled, interval, schedule, gap, cap, exit and previous-viewable are unchanged`);
    }
  }
  // An ATF-only site: its BTF position inherits the ATF percentage, not a fixed 50%.
  assert.equal(rules(compiled('3.16.2',CONFIGS['ATF group only'])).getAdUnitRefreshRule('P1').minViewPct,60);
  assert.deepEqual(plain(rules(compiled('3.16.2')).getAdUnitRefreshRule('Video')),plain(rules(compiled('3.16.1')).getAdUnitRefreshRule('Video')),'video-enabled positions stay disabled');
});

test('R3-01: refresh at 30% is refused only when no value is saved; 60% and an explicit 0 still refresh',()=>{
  const reason='slot below view threshold: 30% < 50%';
  for(const [config,expected30] of [[{},false],[CONFIGS['Default timeout only'],false],[CONFIGS['Default explicit 0'],true],[{P1:{refresh:{minViewPct:0}}},true]]){
    assert.equal(rules(compiled('3.16.1',config),{pct:30}).canRefreshSlotNow('P1').ok,true,'3.16.1 refreshes regardless');
    const at30=rules(compiled('3.16.2',config),{pct:30}).canRefreshSlotNow('P1');
    assert.equal(at30.ok,expected30);if(!expected30)assert.equal(at30.reason,reason);
    assert.equal(rules(compiled('3.16.2',config),{pct:60}).canRefreshSlotNow('P1').ok,true);
  }
  // An empty Sticky keeps its 3.16.1 exemption; a filled Sticky now meets the inherited threshold.
  assert.equal(rules(compiled('3.16.2'),{pct:0,loaded:false}).canRefreshSlotNow('Sticky').ok,true);
  assert.equal(rules(compiled('3.16.2'),{pct:100}).canRefreshSlotNow('Sticky').ok,true);
});

test('R3-01: the refresh-time threshold is REFRESH_IN_VIEW_PCT when nothing is saved, the saved value otherwise, and 0 stays 0',()=>{
  const atfOnly=CONFIGS['ATF group only'];
  // config, position, applied threshold, saved by Default, group or position
  const CASES=[
    [{},'P1',50,false],[{},'Billboard',50,false],
    [atfOnly,'P1',60,false],[atfOnly,'Billboard',60,true],
    [{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minViewPct:70}}},'P1',70,true],
    [CONFIGS['Default explicit 0'],'P1',0,true],
    [CONFIGS['BTF group explicit 0'],'P1',0,true],[CONFIGS['BTF group explicit 0'],'Billboard',50,false],
    [CONFIGS['position explicit 0 under Default 70'],'P1',0,true],[CONFIGS['position explicit 0 under Default 70'],'Billboard',70,true],
    [{...atfOnly,P1:{refresh:{minViewPct:80}}},'P1',80,true],[{...atfOnly,P1:{refresh:{minViewPct:0}}},'P1',0,true],
  ];
  for(const [config,code,threshold,explicit] of CASES){
    const name=`${JSON.stringify(config)} ${code}`,build=compiled('3.16.2',config);
    if(!explicit)assert.equal(threshold,constants(build.source).REFRESH_IN_VIEW_PCT,name);
    for(const mobile of [false,true]){
      const at=pct=>rules(build,{pct,mobile}).canRefreshSlotNow(code),previous=pct=>rules(compiled('3.16.1',config),{pct,mobile}).canRefreshSlotNow(code);
      assert.equal(rules(build,{mobile}).getAdUnitRefreshRule(code).minViewPct,threshold,name);
      if(threshold>0){
        assert.deepEqual(plain(at(threshold-1)),{ok:false,reason:`slot below view threshold: ${threshold-1}% < ${threshold}%`},name);
        assert.equal(previous(threshold-1).ok,!explicit,name+': 3.16.1 checks only a saved value');
      }
      assert.equal(at(threshold).ok,true,name);assert.equal(at(0).ok,threshold===0,name);
      if(explicit)for(const pct of [0,threshold-1,threshold,100])assert.deepEqual(plain(at(pct)),plain(previous(pct)),name+' saved value unchanged at '+pct);
    }
  }
});

test('R3-01: view entry and exit are identical to 3.16.1 on desktop and mobile for every inherited and saved percentage',()=>{
  const percentages=[0,1,10,40,50,60,100];
  const globals={
    'no rules':{},
    'Default refresh without minViewPct':{__DEFAULT__:{refresh:{enabled:true,minSeconds:30}}},
    'ATF refresh without minViewPct':{__ATF__:{refresh:{enabled:true,minSeconds:45}}},
    ...Object.fromEntries(percentages.flatMap(pct=>[[`Default ${pct}`,{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minViewPct:pct}}}],[`ATF only ${pct}`,{__ATF__:{refresh:{enabled:true,minSeconds:45,minViewPct:pct}}}]])),
  };
  let inheritedChecks=0;
  for(const [name,config] of Object.entries(globals)){
    const oldBuild=compiled('3.16.1',config),newBuild=compiled('3.16.2',config);
    const inherited=constants(newBuild.source).REFRESH_IN_VIEW_PCT;
    assert.equal(inherited,Number(config.__DEFAULT__?.refresh?.minViewPct??config.__ATF__?.refresh?.minViewPct??50),name);
    // A saved position value does not change the compiled constants; only AD_UNIT_RULES differs.
    const variants=[[name,newBuild.input.core.adUnitRules],...percentages.map(pct=>{
      const snapshot=fixture();snapshot.rules=Object.entries({...config,P1:{refresh:{minViewPct:pct}}}).map(([rule_key,rule])=>({rule_key,rule_json:JSON.stringify(rule)}));
      return [`${name}, P1 saves ${pct}`,previewInput(snapshot,descriptor,stamp).core.adUnitRules];
    })];
    for(const mobile of [false,true]){
      for(const [label,adUnitRules] of variants){
        const old=visibility(oldBuild,{adUnitRules,mobile}),next=visibility(newBuild,{adUnitRules,mobile});
        for(const code of ['Billboard','P1']){
          const a=old(code),b=next(code);
          assert.deepEqual(b.enters,a.enters,`${label} ${code} ${mobile?'mobile':'desktop'} entry`);
          assert.deepEqual(b.leaves,a.leaves,`${label} ${code} ${mobile?'mobile':'desktop'} exit`);
          if(label===name&&!saved(config,code,code==='P1'?'BTF':'ATF')){
            inheritedChecks++;
            // The script's device default, unchanged: the inherited value, or 50% / 40% when it is 0.
            assert.equal(b.enters.indexOf(true),inherited>0?inherited:mobile?40:50,`${label} ${code} ${mobile?'mobile':'desktop'}`);
          }
        }
      }
    }
  }
  assert.equal(inheritedChecks,26,'positions without their own value, desktop and mobile');
});

test('R3-01: the 3.16.2 admin percentage is the threshold the compiled script applies at refresh time',()=>{
  // config, expected 3.16.2 label percentage for Billboard (ATF) and P1 (BTF)
  const LABELS={
    'no rules':[{},50,50],
    'Default timeout only':[{__DEFAULT__:{timeout:1500}},50,50],
    'Default refresh without minViewPct':[{__DEFAULT__:{refresh:{enabled:true,minSeconds:30}}},50,50],
    'Default 70':[{__DEFAULT__:{refresh:{enabled:true,minSeconds:40,minViewPct:70}}},70,70],
    'Default 0':[{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minViewPct:0}}},0,0],
    'ATF-only 60 (no Default refresh)':[{__ATF__:{refresh:{enabled:true,minSeconds:45,minViewPct:60}}},60,60],
    'BTF group 0':[{__BTF__:{refresh:{minViewPct:0}}},50,0],
    'positions 0 and 80':[{P1:{refresh:{minViewPct:0}},Billboard:{refresh:{minViewPct:80}}},80,0],
    'positions 0 and 80 under Default 70':[{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minViewPct:70}},P1:{refresh:{minViewPct:0}},Billboard:{refresh:{minViewPct:80}}},80,0],
    'position 80 under ATF-only 60':[{__ATF__:{refresh:{enabled:true,minSeconds:45,minViewPct:60}},P1:{refresh:{minViewPct:80}}},60,80],
    'ATF-only 60 sequence schedule':[{__ATF__:{refresh:{enabled:true,minSeconds:45,minViewPct:60,schedule:{mode:'sequence',sequenceSeconds:[45,90]}}}},60,60],
    'Default growing interval without minViewPct':[{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,schedule:{mode:'percentage',firstSeconds:30,growthPercent:50,maxSeconds:120}}}},50,50],
    'BTF sequence 0 under Default 70':[{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minViewPct:70}},__BTF__:{refresh:{minViewPct:0,schedule:{mode:'sequence',sequenceSeconds:[20,40]}}}},70,0],
    'position null under Default 70':[{__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minViewPct:70}},P1:{refresh:{minViewPct:null}}},70,70],
  };
  // Positions without a saved percentage say where the applied value comes from.
  const NOTES={
    'no rules':'its default 50%',
    'Default timeout only':'its default 50%',
    'Default refresh without minViewPct':'its default 50%',
    'Default growing interval without minViewPct':'its default 50%',
    'ATF-only 60 (no Default refresh)':'the 60% saved in the ATF refresh rule',
    'ATF-only 60 sequence schedule':'the 60% saved in the ATF refresh rule',
    'position null under Default 70':'the 70% saved in the Default refresh rule',
  };
  const pins=[{runtimeId:'tessera-3.16.2',runtimeVersion:'3.16.2'},{id:'tessera-3.16.2',version:'3.16.2'}];
  const shown=label=>{const match=/ · (\d+)%$/.exec(label);assert(match,label);return Number(match[1]);};
  for(const [name,[config,billboard,p1]] of Object.entries(LABELS)){
    const build=compiled('3.16.2',config),generated=rules(build);
    for(const pin of pins){
      const rows=refreshSummary(build.input,build.snapshot.units,pin,build.snapshot.rules).units.filter(row=>row.code!=='Sticky');
      assert.deepEqual(rows.map(row=>row.code),['Billboard','P1'],name);
      for(const row of rows)assert.equal(shown(row.label),generated.getAdUnitRefreshRule(row.code).minViewPct,`${name} ${row.code} (${row.label})`);
      assert.deepEqual(rows.map(row=>shown(row.label)),[billboard,p1],name);
      const p1Row=rows[1],note=NOTES[name]&&` No in-view percentage is saved for this position in Default, group or ad unit settings, so the script checks ${NOTES[name]} at refresh time.`;
      assert.equal(p1Row.detail,`Resolved from the selected script’s Default, group and ad unit settings.${note||''}`,`${name} P1 detail`);
    }
  }
  // Other script versions keep today's label (3.16.1 shows the editor baseline, and no
  // percentage on schedule labels).
  const atfOnly=LABELS['ATF-only 60 (no Default refresh)'][0],old=compiled('3.16.1',atfOnly),pin3161={runtimeId:'tessera-3.16.1',runtimeVersion:'3.16.1'};
  const row=(build,pin,code)=>refreshSummary(build.input,build.snapshot.units,pin,build.snapshot.rules).units.find(item=>item.code===code);
  assert.equal(row(old,pin3161,'P1').label,'30s · 50%');
  assert.equal(row(old,pin3161,'P1').detail,'Resolved from the selected script’s Default, group and ad unit settings.');
  assert.equal(row(compiled('3.16.1',LABELS['ATF-only 60 sequence schedule'][0]),pin3161,'Billboard').label,'Sequence schedule');
  // Only the percentage is asserted for 3.16.2: the "30s" interval text in this ATF-only case
  // (compiled P1 refreshes every 45 s) is the separately recorded interval-text task.
  assert.equal(shown(row(compiled('3.16.2',atfOnly),pins[0],'P1').label),60);
  assert.equal(row(compiled('3.16.1',{}),pin3161,'P1').label,'30s · 50%');
  // An interval note from Unit rules keeps the percentage note in 3.16.2 only.
  const snapshot=fixture(),config=JSON.parse(snapshot.config.config_json);
  snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:30}})},{rule_key:'P1',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:60}})}];
  config.advancedUnitRules={__DEFAULT__:{refresh:{enabled:true,minSeconds:20,schedule:{mode:'sequence',sequenceSeconds:[20,40,80]}}}};snapshot.config.config_json=JSON.stringify(config);
  const interval='Uses the inherited Default schedule (20s, 40s, 80s…); the 60s interval saved for P1 in Unit rules is not used.';
  for(const [pin,label,detail] of [[pins[0],'Sequence schedule · 50%',interval+' No in-view percentage is saved for this position in Default, group or ad unit settings, so the script checks its default 50% at refresh time.'],[pin3161,'Sequence schedule',interval]]){
    const input=previewInput(structuredClone(snapshot),{...descriptor,id:pin.runtimeId,version:pin.runtimeVersion},stamp);
    const p1=refreshSummary(input,snapshot.units,pin,snapshot.rules).units.find(item=>item.code==='P1');
    assert.deepEqual([p1.label,p1.detail],[label,detail],pin.runtimeVersion);
  }
});

/** The real generated dwell timer, tryRefresh and schedule with the compiled constants
 * (the cap is raised for long runs); GPT dispatch is a stub that sends after `sendAfter`
 * ms the way the visibility gate counts actual requests. */
function dwell(source,schedule,{sendAfter=2000,send=()=>true}={}){
  const c=clock(),slot={setConfig(){}},accepted=[],sent=[];
  const ctx=vm.createContext({...constants(source),MAX_REFRESHES_PER_SLOT:100,AD_UNIT_RULES:{__DEFAULT__:{refresh:{enabled:true,minViewPct:50,schedule}}},TESSERA_OUTSTREAM:{disabledRefreshCodes:[]},getUnitConfigById:()=>({type:'BTF'}),
    isMobile:()=>false,_refreshCounts:{},_lastRefreshAt:{},_tesseraRefreshPending:Object.create(null),_tesseraLastRefreshSentAt:Object.create(null),_slotState:{},_slotMeta:{},
    getSlotViewPct:()=>100,STICKY_TARGET_ID:'Sticky',STICKY_TOP_TARGET_ID:'',_sticky:{closed:false},_stickyTop:{closed:true},document:{getElementById:()=>null},
    pageActive:()=>true,REFRESH_EXCLUDE_IDS:[],GAM_NOREFRESH_ADVERTISER_IDS:[],slotHasCurrentViewportSizes:()=>true,_gamReporting:{plan(){}},
    scheduleRefreshGuardRetry(){},log(){},now:c.now,setTimeout:c.setTimeout,clearTimeout:c.clearTimeout,window:{adSlots:{P1:slot}},fetchBidsAndRefresh(){throw Error('content uses the queue');}});
  ctx.enqueueRefresh=(id,s)=>{
    accepted.push({at:c.now(),count:ctx._refreshCounts[id]||0});
    const dispatch=()=>{if(!send(accepted.length))return;sent.push(c.now());ctx._tesseraLastRefreshSentAt[id]=c.now();
      if(ctx._tesseraRefreshPending[id]===s){delete ctx._tesseraRefreshPending[id];ctx._refreshCounts[id]=(ctx._refreshCounts[id]||0)+1;}};
    if(sendAfter===0)dispatch();else if(sendAfter!==Infinity)c.setTimeout(dispatch,sendAfter);
  };
  vm.runInContext([...RULE_FUNCTIONS,'canRefreshSlotNow','tryRefresh','ensureState','getMinGapSec','startDwell'].map(name=>fn(source,name)).join('\n'),ctx);
  return {c,ctx,slot,accepted,sent,start(){const st=ctx.ensureState('P1');st.inView=true;ctx.startDwell('P1');},
    gaps:()=>accepted.slice(1).map((item,i)=>(item.at-accepted[i].at)/1000)};
}
// schedule, 3.16.0 refresh-to-refresh gaps, 3.16.1 gaps (the longer step repeats once)
const SEQUENCES={
  'sequence 30/90/45':[{mode:'sequence',sequenceSeconds:[30,90,45]},[90,45,45,45],[90,90,45,45]],
  'sequence 60/30/30':[{mode:'sequence',sequenceSeconds:[60,30,30]},[30,30,30,30],[60,30,30,30]],
  'sequence 120/20':[{mode:'sequence',sequenceSeconds:[120,20]},[20,20,20,20],[120,20,20,20]],
  '60 s, then 30 s':[{mode:'firstThenFixed',firstSeconds:60,nextSeconds:30},[30,30,30,30],[60,30,30,30]],
};
const stepOf=schedule=>{const resolver=rules(compiled('3.16.2'),{adUnitRules:{__DEFAULT__:{refresh:{enabled:true,minViewPct:50,schedule}}}});return count=>{resolver._refreshCounts.P1=count;return resolver.getAdUnitRefreshRule('P1').minSeconds;};};

test('R3-09: a shorter next step follows a queued refresh at the 3.16.0 times; non-decreasing schedules are unchanged',()=>{
  const run=(source,schedule,options)=>{const d=dwell(source,schedule,options);d.start();d.c.tick(600000);return d;};
  for(const [name,[schedule,expected,previous]] of Object.entries(SEQUENCES)){
    const first=schedule.sequenceSeconds?.[0]??schedule.firstSeconds;
    const old=run(before,schedule),next=run(after,schedule);
    assert.equal(next.accepted[0].at-1000000,first*1000,name);
    assert.deepEqual(next.gaps().slice(0,4),expected,name+' 3.16.2');
    assert.deepEqual(run(older,schedule).gaps().slice(0,4),expected,name+' 3.16.0');
    assert.deepEqual(old.gaps().slice(0,4),previous,name+' 3.16.1 reproduces R3-09');
    assert.deepEqual(next.sent.map((t,i)=>t-next.accepted[i].at),next.sent.map(()=>2000),'every accepted request is still sent after the batch window');
    assert.deepEqual(next.accepted.map(a=>a.count),next.accepted.map((_,i)=>i),'counts still advance only on actual requests');
    for(const options of [{sendAfter:0},{sendAfter:1}])assert.deepEqual(run(after,schedule,options).gaps().slice(0,4),expected,name+' send after '+options.sendAfter+' ms matches 3.16.0');
  }
  for(const schedule of [{mode:'fixed',fixedSeconds:30},{mode:'firstThenFixed',firstSeconds:30,nextSeconds:60},{mode:'percentage',firstSeconds:30,growthPercent:50,maxSeconds:120},{mode:'sequence',sequenceSeconds:[20,40,80]},{mode:'sequence',sequenceSeconds:[30,30,120]}]){
    const times=d=>d.accepted.map(a=>a.at),reference=times(run(older,schedule));
    assert.deepEqual(times(run(after,schedule)),times(run(before,schedule)),JSON.stringify(schedule));
    // A send that completes before the dwell timer picks the next step is already counted, so
    // the look-ahead must not add the same request again (the exact-pending-request guard).
    for(const sendAfter of [0,1,2000])assert.deepEqual(times(run(after,schedule,{sendAfter})),reference,`${JSON.stringify(schedule)} send after ${sendAfter} ms matches 3.16.0`);
  }
});

test('R3-09 boundary: never earlier than the counted step; 3.16.0 times when the send is within the next step, 3.16.1 times when it is slower',()=>{
  const times=d=>d.accepted.map(a=>a.at-1000000);
  const run=(source,schedule,sendAfter)=>{const d=dwell(source,schedule,{sendAfter});d.start();d.c.tick(400000);return d;};
  // schedule, sends within the next (shorter) step, sends slower than that step but faster than the longer step before it
  const CASES=[
    [{mode:'sequence',sequenceSeconds:[30,5,5]},[1,2000,4000,5000],[5001,6000,12000,29000]],
    [{mode:'sequence',sequenceSeconds:[60,10]},[1,2000,9000,10000],[10001,12000,30000,59000]],
    [{mode:'firstThenFixed',firstSeconds:30,nextSeconds:8},[1,2000,8000],[8001,12000,29000]],
    [{mode:'sequence',sequenceSeconds:[30,90,45]},[1,2000,12000,29000],[]],
  ];
  for(const [schedule,within,slower] of CASES){
    const name=JSON.stringify(schedule),step=stepOf(schedule),reference=times(run(older,schedule,2000));
    assert(reference.length>4,name);
    for(const sendAfter of [...within,...slower]){
      const next=run(after,schedule,sendAfter);
      assert(next.accepted.length>4,name);
      next.accepted.slice(1).forEach((a,i)=>assert(a.at-next.accepted[i].at>=step(a.count)*1000,`${name} send after ${sendAfter} ms: accepted ${a.at-next.accepted[i].at} ms after the previous, counted step ${step(a.count)} s`));
      if(within.includes(sendAfter))assert.deepEqual(times(next),reference,`${name} send after ${sendAfter} ms matches 3.16.0`);
      else{
        const old=times(run(before,schedule,sendAfter));
        assert.deepEqual(times(next),old,`${name} send after ${sendAfter} ms matches 3.16.1`);
        assert.notDeepEqual(old.slice(0,3),reference.slice(0,3),`${name}: the documented limit, the longer step repeats once`);
      }
    }
  }
});

test('R3-09: a request that is not sent never advances the schedule, and no request is accepted before its counted step',()=>{
  for(const [name,[schedule]] of Object.entries(SEQUENCES)){
    const step=stepOf(schedule);
    // Never sent (for example held or skipped by dispatch): the count stays 0 and
    // the dwell timer looks at most one step ahead.
    const held=dwell(after,schedule,{sendAfter:Infinity});held.start();held.c.tick(600000);
    assert(held.accepted.length>3&&held.accepted.every(a=>a.count===0),name);
    assert(held.gaps().every(g=>g===Math.max(step(0),step(1))),name+' '+held.gaps());
    // Some requests are skipped: spacing from the previous accepted request never
    // undercuts the step that the actual count gives (the unchanged gap check).
    for(const send of [n=>n%2===0,n=>n%3!==1,()=>false,()=>true]){
      const d=dwell(after,schedule,{send});d.start();d.c.tick(900000);
      assert(d.accepted.length>3,name);
      d.accepted.slice(1).forEach((a,i)=>assert(a.at-d.accepted[i].at>=step(a.count)*1000,`${name}: accepted ${a.at-d.accepted[i].at} ms after the previous, step ${step(a.count)} s`));
    }
  }
});

test('R3-09: tryRefresh reports a queued request only on its accept path',()=>{
  const d=dwell(after,{mode:'fixed',fixedSeconds:30});
  const call=()=>d.ctx.tryRefresh('P1',d.slot,30);
  d.ctx._lastRefreshAt.P1=0;
  assert.equal(call(),true);assert.equal(d.ctx._tesseraRefreshPending.P1,d.slot);
  assert.equal(call(),undefined,'gap refusal');assert(d.ctx._slotState.P1.gapRemainingMs>0);
  const refusals={
    'disabled video position':ctx=>{ctx.TESSERA_OUTSTREAM.disabledRefreshCodes=['P1'];},
    'inactive page':ctx=>{ctx.pageActive=()=>false;},
    'excluded position':ctx=>{ctx.REFRESH_EXCLUDE_IDS=['P1'];},
    'cap reached':ctx=>{ctx.AD_UNIT_RULES.__DEFAULT__.refresh.maxRefreshes=0;},
    'view below threshold':ctx=>{ctx.getSlotViewPct=()=>10;},
    'advertiser block':ctx=>{ctx._slotMeta.P1={advertiserId:7};ctx.GAM_NOREFRESH_ADVERTISER_IDS=[7];},
    'no current viewport sizes':ctx=>{ctx.slotHasCurrentViewportSizes=()=>false;},
  };
  for(const [name,refuse] of Object.entries(refusals)){
    const r=dwell(after,{mode:'fixed',fixedSeconds:30});refuse(r.ctx);r.ctx._lastRefreshAt.P1=0;
    assert.equal(r.ctx.tryRefresh('P1',r.slot,30),undefined,name);assert.equal(r.accepted.length,0,name);
    assert.equal(r.ctx._tesseraRefreshPending.P1,undefined,name);
  }
  const r=dwell(after,{mode:'fixed',fixedSeconds:30});assert.equal(r.ctx.tryRefresh('P1',null,30),undefined,'missing slot');
  // 3.16.1 returned nothing on the accept path, so the signal is new in 3.16.2.
  const old=dwell(before,{mode:'fixed',fixedSeconds:30});old.ctx._lastRefreshAt.P1=0;assert.equal(old.ctx.tryRefresh('P1',old.slot,30),undefined);assert.equal(old.accepted.length,1);
});

test('R3-09: a still-pending earlier request does not advance a refused attempt',()=>{
  const d=dwell(after,{mode:'sequence',sequenceSeconds:[30,90,45]},{sendAfter:Infinity});
  d.start();d.c.tick(30000);assert.equal(d.accepted.length,1);assert.equal(d.ctx._tesseraRefreshPending.P1,d.slot);
  d.ctx.getSlotViewPct=()=>10;// the next attempt is refused by the view gate while the first is still pending
  const st=d.ctx._slotState.P1;d.c.tick(90000);
  assert.equal(d.accepted.length,1);assert.equal(st.dwellRemainingMs,null);
  assert.equal(st.dwellDeadline-d.c.now(),30000,'refused attempt keeps the counted step (30 s), not the pending next step');
});
