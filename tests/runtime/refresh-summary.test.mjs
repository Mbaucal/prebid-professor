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
