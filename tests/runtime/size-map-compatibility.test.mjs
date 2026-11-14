import test from 'node:test';
import assert from 'node:assert/strict';
import {assertSizeMapCompatibility} from '../../worker/site-runtime/size-map-compatibility.mjs';

const old = {version:'3.19.0', capabilities:['country-rules']};
const current = {version:'3.20.0', capabilities:['country-rules','viewport-height-size-maps']};
function fixture() {
  return {config:{config_json:JSON.stringify({enablePrebid:true})},
    units:[{code:'P2',type:'ATF',enabled:1,size_map_key:'P2'},{code:'Sticky',type:'ATF',enabled:1,size_map_key:'Sticky'}],
    maps:[{name:'P2',map_json:JSON.stringify([{minViewPort:[0,0],sizes:[[300,250]]}])},
      {name:'Sticky',map_json:JSON.stringify([{viewport:[0,0],sizes:[[320,50]]},{viewport:[768,1000],sizes:[[728,90]]}])}], rules:[]};
}
test('old script reports exact map, position and viewport value before generation without changing input',()=>{
  const s=fixture(),before=JSON.stringify(s);
  assert.throws(()=>assertSizeMapCompatibility(s,old),/Sticky: map Sticky, row 2 requires browser height 1000px/);
  assert.equal(JSON.stringify(s),before);
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,current));
});
test('reserved numeric ad height is never treated as a browser-height condition',()=>{
  const s=fixture();s.units.pop();
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,old));
});
test('only assigned and inherited active conditional maps affect enabled inventory',()=>{
  const s=fixture();s.units.pop();
  s.rules.push({rule_key:'__ATF__',rule_json:JSON.stringify({conditionalMappings:[{enabled:false,sizeMapKey:'Sticky'}]})});
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,old));
  s.rules[0].rule_json=JSON.stringify({conditionalMappings:[{enabled:true,sizeMapKey:'Sticky'}]});
  assert.throws(()=>assertSizeMapCompatibility(s,old),/P2: map Sticky/);
  s.config.config_json=JSON.stringify({advancedUnitRules:{__ATF__:{conditionalMappings:[]}}});
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,old));
  s.units[0].enabled=0;
  s.config.config_json='{}';
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,old));
});
test('legacy prefixed maps receive the same review and unused maps do not block',()=>{
  const s=fixture();s.units.pop();
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,old));
  s.maps[1].name='naslovna_P2';
  assert.throws(()=>assertSizeMapCompatibility(s,old),/P2: map naslovna_P2/);
});
test('supported TakeOver height mapping is retained on old scripts',()=>{
  const s=fixture();s.config.config_json=JSON.stringify({runtimeControls:{adPositions:{Sticky:{}}}});
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,old));
});
test('responsive Outstream retains explicit width-only constraint in the new version',()=>{
  const s=fixture();s.config.config_json=JSON.stringify({enablePrebid:true,runtimeControls:{outstream:{units:{Sticky:{format:'outstream',playerSizing:'size-map'}}}}});
  assert.throws(()=>assertSizeMapCompatibility(s,current),/responsive Outstream supports width conditions only/);
  s.config.config_json=JSON.stringify({enablePrebid:false,runtimeControls:{outstream:{units:{Sticky:{format:'outstream',playerSizing:'size-map'}}}}});
  assert.doesNotThrow(()=>assertSizeMapCompatibility(s,current));
});
