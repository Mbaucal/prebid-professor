import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshSummary} from '../../worker/site-runtime/refresh-summary.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {runtimeCatalog,previewInput} from '../../worker/test-workspace/runtime-catalog.mjs';
const old=runtimeCatalog.find(r=>r.version==='3.16.0');
const make=()=>{const snapshot=positionFixture(false),config=JSON.parse(snapshot.config.config_json);delete config.runtimeControls.adPositions;snapshot.units=snapshot.units.filter(u=>u.code!=='Overlay');snapshot.rules=[];snapshot.config.config_json=JSON.stringify(config);return snapshot;};
const summarize=(s,r=old)=>refreshSummary(previewInput(s,r,'20261024_120000'),s.units,r);
test('older script shows Disabled when a content override cannot bypass the global refresh switch',()=>{
 const s=make();s.rules=[{rule_key:'P1',rule_json:JSON.stringify({timeout:1200,refresh:{enabled:true,minSeconds:15,minViewPct:75}})}];const before=JSON.stringify(s),summary=summarize(s);assert.equal(summary.units.find(u=>u.code==='P1').label,'Disabled');assert.equal(summary.units.find(u=>u.code==='P1').timeout,1200);assert.match(summary.warnings[0],/global switch.*P1/);assert.match(summary.units.find(u=>u.code==='P1').detail,/not applied/);assert.equal(JSON.stringify(s),before);
});
test('Default refresh workaround reflects actual compiled intervals and removes the warning',()=>{
 const s=make();s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:30,minViewPct:50}})},{rule_key:'P1',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:60,minViewPct:75}})}];const summary=summarize(s);assert.equal(summary.units.find(u=>u.code==='P1').label,'60s · 75%');assert.equal(summary.warnings.length,0);
});
test('a partial global refresh object follows the compiler enabled-not-false rule',()=>{
 const s=make();s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{minSeconds:60}})}];const summary=summarize(s);assert.equal(summary.units.find(u=>u.code==='P1').enabled,true);assert.equal(summary.warnings.length,0);
});
test('video and TakeOver positions remain disabled and do not produce misleading global warning',()=>{
 const input={core:{adUnitRules:{},atfTimeout:2500,btfTimeout:2500,globalRefresh:{enabled:false}},options:{sticky:{bottomAdUnitId:''}},outstream:{disabledRefreshCodes:['Video']},overlay:{code:'Overlay'}};
 const summary=refreshSummary(input,[{code:'Video',type:'BTF',enabled:1},{code:'Overlay',type:'ATF',enabled:1}],old);assert(summary.units.every(u=>u.label==='Disabled'));assert.equal(summary.warnings.length,0);assert.match(summary.units[0].detail,/video/);assert.match(summary.units[1].detail,/TakeOver/);
});
test('wall-clock gap warning follows the selected capability, not editable form defaults',()=>{
 const s=make(),c=JSON.parse(s.config.config_json);c.advancedUnitRules={__DEFAULT__:{refresh:{enabled:true,minSeconds:30,minGapSeconds:15}}};s.config.config_json=JSON.stringify(c);let summary=summarize(s);assert.match(summary.warnings.join(' '),/Minimum wall-clock gap.*does not enforce/);summary=refreshSummary(previewInput(s,old,'20261024_120000'),s.units,{capabilities:['refresh-wall-clock-gap']});assert.equal(summary.warnings.length,0);
});
test('Sticky uses its own timer description and a disabled unit never reports active refresh',()=>{
 const s=make(),c=JSON.parse(s.config.config_json);c.runtimeControls.sticky.bottomAdUnitId='P1';s.config.config_json=JSON.stringify(c);s.units[0].enabled=0;const summary=summarize(s);assert.equal(summary.units.find(u=>u.code==='P1').label,'Sticky timer');assert.equal(summary.units.find(u=>u.code==='Billboard').label,'Disabled');assert.equal(summary.warnings.length,0);
});
test('registered 3.16.1 reports independent position refresh and supported wall-clock gaps',()=>{
 const runtime=runtimeCatalog.find(r=>r.version==='3.16.1');assert(runtime);
 const s=make(),c=JSON.parse(s.config.config_json);c.advancedUnitRules={__DEFAULT__:{refresh:{enabled:false}},P1:{refresh:{enabled:true,minSeconds:30,minGapSeconds:120}}};s.config.config_json=JSON.stringify(c);
 for(const r of [runtime,{runtimeId:runtime.id,runtimeVersion:runtime.version,capabilities:runtime.capabilities}]){
  const summary=refreshSummary(previewInput(s,runtime,'20261024_120000'),s.units,r);assert.equal(summary.units.find(u=>u.code==='P1').enabled,true);assert.equal(summary.units.find(u=>u.code==='Billboard').enabled,false);assert.deepEqual(summary.warnings,[]);
 }
});
const advice='If the inherited schedule is intended, remove the refresh override from that rule in Unit rules. To use the saved interval, edit and save the rule in Unit rules, or set “Same every time” for it in Refresh schedules.';
const rule=(key,minSeconds,extra={})=>({rule_key:key,rule_json:JSON.stringify({refresh:{enabled:true,minSeconds,minViewPct:50,...extra}})});
test('labels and Unit rules notes follow the generated scheduler, not the saved minimum time',()=>{
 const runtime=runtimeCatalog.find(r=>r.version==='3.16.1');
 const s=make(),c=JSON.parse(s.config.config_json);
 s.rules=[rule('__DEFAULT__',20),rule('__BTF__',45),rule('P1',60),rule('Billboard',15)];
 c.advancedUnitRules={__DEFAULT__:{refresh:{enabled:true,minSeconds:20,schedule:{mode:'sequence',sequenceSeconds:[20,40,80]}}},Billboard:{refresh:{enabled:true,minSeconds:15,schedule:{mode:'fixed',fixedSeconds:25}}}};s.config.config_json=JSON.stringify(c);
 for(const r of [old,runtime]){
  const summary=refreshSummary(previewInput(s,r,'20261024_120000'),s.units,r,s.rules);
  assert.equal(summary.units.find(u=>u.code==='P1').label,'Sequence schedule');assert.equal(summary.units.find(u=>u.code==='Billboard').label,'25s · 50%');
  assert.deepEqual(summary.warnings,[`The refresh interval saved in Unit rules is not used for: Billboard (15s; the script uses its Refresh schedule: 25s), P1 (60s; the script uses the inherited Default schedule: 20s, 40s, 80s…). ${advice}`]);
  assert.equal(summary.units.find(u=>u.code==='P1').detail,'Uses the inherited Default schedule (20s, 40s, 80s…); the 60s interval saved for P1 in Unit rules is not used.');
 }
 // A group interval (usually a base-rule preset) under the site schedule is explained per position, not a warning.
 s.rules=[rule('__DEFAULT__',20),rule('__BTF__',45)];
 for(const r of [old,runtime]){const summary=refreshSummary(previewInput(s,r,'20261024_120000'),s.units,r,s.rules);assert.deepEqual(summary.warnings,[]);assert.equal(summary.units.find(u=>u.code==='P1').detail,'Uses the inherited Default schedule (20s, 40s, 80s…); the 45s interval saved for BTF group in Unit rules is not used.');assert.equal(summary.units.find(u=>u.code==='Billboard').detail,'Resolved from the selected script’s Default, group and ad unit settings.');}
 // First/next schedules were labelled with the stale saved minimum before.
 c.advancedUnitRules={__DEFAULT__:{refresh:{enabled:true,minSeconds:20,schedule:{mode:'firstThenFixed',firstSeconds:20,nextSeconds:45}}}};s.config.config_json=JSON.stringify(c);s.rules=[];
 assert.equal(summarize(s,runtime).units.find(u=>u.code==='P1').label,'20s, then 45s · 50%');
});
test('Refresh-owned schedules, consistent intervals, video and older Sticky timers are not reported',()=>{
 const runtime=runtimeCatalog.find(r=>r.version==='3.16.1');
 const s=make(),c=JSON.parse(s.config.config_json);c.runtimeControls.sticky.bottomAdUnitId='Billboard';
 c.advancedUnitRules={__DEFAULT__:{refresh:{enabled:true,minSeconds:30,schedule:{mode:'fixed',fixedSeconds:30}}},P1:{refresh:{enabled:true,minSeconds:15,schedule:{mode:'sequence',sequenceSeconds:[15,30]}}}};s.config.config_json=JSON.stringify(c);
 s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:30}})},{rule_key:'P1',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:15}})},{rule_key:'Billboard',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:60}})}];
 assert.deepEqual(refreshSummary(previewInput(s,old,'20261024_120000'),s.units,old,s.rules).warnings,[],'3.16.0 times Sticky from its own minimum time');
 assert.deepEqual(refreshSummary(previewInput(s,runtime,'20261024_120000'),s.units,runtime,s.rules).warnings,[`The refresh interval saved in Unit rules is not used for: Billboard (60s; the script uses the inherited Default schedule: 30s). ${advice}`],'3.16.1 Sticky follows the inherited schedule');
 const video={core:{adUnitRules:{__DEFAULT__:{refresh:{schedule:{mode:'fixed',fixedSeconds:30}}},Video:{refresh:{enabled:true,minSeconds:60}}},atfTimeout:2500,btfTimeout:2500,globalRefresh:{enabled:true}},options:{sticky:{bottomAdUnitId:''}},outstream:{disabledRefreshCodes:['Video']},overlay:null};
 assert.deepEqual(refreshSummary(video,[{code:'Video',type:'BTF',enabled:1}],runtime,[{rule_key:'Video',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:60}})}]).warnings,[]);
});
test('positions the script does not refresh and groups without positions add no interval note',()=>{
 const runtime=runtimeCatalog.find(r=>r.version==='3.16.1');
 // Default refresh switched off in Refresh schedules (fixed 30), P1 60 in Unit rules, an ATF interval while the only ATF unit is disabled.
 const s=make(),c=JSON.parse(s.config.config_json);s.units.find(u=>u.code==='Billboard').enabled=0;
 c.advancedUnitRules={__DEFAULT__:{refresh:{enabled:false,minSeconds:30,schedule:{mode:'fixed',fixedSeconds:30}}}};s.config.config_json=JSON.stringify(c);
 s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:false,minSeconds:30}})},rule('P1',60),rule('__ATF__',45)];
 const older=refreshSummary(previewInput(s,old,'20261024_120000'),s.units,old,s.rules);
 assert.equal(older.warnings.length,1);assert.match(older.warnings[0],/global switch for: P1/);assert.match(older.units.find(u=>u.code==='P1').detail,/global refresh switch is off/);
 // 3.16.1 refreshes P1 under its own enabled rule, with the inherited Default schedule.
 const current=refreshSummary(previewInput(s,runtime,'20261024_120000'),s.units,runtime,s.rules);
 assert.deepEqual(current.warnings,[`The refresh interval saved in Unit rules is not used for: P1 (60s; the script uses the inherited Default schedule: 30s). ${advice}`]);
 assert(!current.warnings.join(' ').includes('ATF group'));
});
test('a position whose own Refresh schedule disagrees with Unit rules is not told to remove its override',()=>{
 const s=make(),c=JSON.parse(s.config.config_json);
 c.advancedUnitRules={P1:{refresh:{enabled:true,minSeconds:15,schedule:{mode:'fixed',fixedSeconds:25}}}};s.config.config_json=JSON.stringify(c);s.rules=[rule('P1',15)];
 const runtime=runtimeCatalog.find(r=>r.version==='3.16.1');
 assert.deepEqual(refreshSummary(previewInput(s,runtime,'20261024_120000'),s.units,runtime,s.rules).warnings,['The refresh interval saved in Unit rules is not used for: P1 (15s; the script uses its Refresh schedule: 25s). To use the saved interval, edit and save the rule in Unit rules, or set “Same every time” for it in Refresh schedules.']);
});
