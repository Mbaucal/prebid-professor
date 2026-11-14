import {conditionalFixture,mapping} from './conditional-maps-fixture.mjs';
export const onlySerbia = () => mapping({id:'only-rs',name:'Only Serbia',priority:10000,sizeMapKey:null,slotAction:'disable',match:'any',conditions:[{id:'not-rs',key:'geo_country',operator:'notEquals',value:'RS'},{id:'unknown',key:'geo_country',operator:'notExists',value:''}]});
export function countryRulesFixture(prebid=false){
 const s=conditionalFixture({prebid});
 s.units.push(...['P1','P3','P4'].map(code=>({...s.units[0],code})));
 s.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:true,minSeconds:30,minViewPct:0}})},
 {rule_key:'P2',rule_json:JSON.stringify({conditionalMappings:[mapping({conditions:[{key:'geo_country',operator:'equals',value:'DE'}]})]})},
 {rule_key:'P3',rule_json:JSON.stringify({conditionalMappings:[onlySerbia()]})},
 {rule_key:'P4',rule_json:JSON.stringify({conditionalMappings:[mapping()]})}];
 return s;
}
