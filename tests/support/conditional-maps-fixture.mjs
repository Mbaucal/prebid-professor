import {fixture,configure} from '../runtime/artifact-fixture.mjs';
export const mapping = (overrides={}) => ({id:'home',name:'Homepage',enabled:true,priority:100,match:'all',
  conditions:[{id:'category',key:'category',operator:'equals',value:'Naslovna'}],sizeMapKey:'naslovna_P2',slotAction:'inherit',...overrides});
export function conditionalFixture({prebid=false,disabled=false,sticky=false}={}) {
  const snapshot=configure(fixture(),c=>{c.enablePrebid=prebid;c.runtimeControls.sticky.bottomAdUnitId=sticky?'Sticky':'';c.runtimeControls.currencyConversion={enabled:false};});
  snapshot.units=[{code:'P2',type:'ATF',media_type:'banner',enabled:1,size_map_key:'P2'}];
  if(sticky)snapshot.units.push({code:'Sticky',type:'ATF',media_type:'banner',enabled:1,size_map_key:'P2'});
  snapshot.overrides=[];
  snapshot.bidders=[{bidder:'ix',enabled:1,params_json:'{"siteId":"fixture"}'}];
  const mobile=[[300,250],[250,250],[200,200],[300,100],[300,50],[320,100],[320,50]];
  snapshot.maps=[{name:'P2',map_json:JSON.stringify([{viewport:[0,0],sizes:mobile},{viewport:[768,0],sizes:[[300,600],[300,300],[300,250],[250,250],[160,600],[120,600]]}])},
    {name:'naslovna_P2',map_json:JSON.stringify([{viewport:[0,0],sizes:mobile},{viewport:[768,0],sizes:[[300,250],[250,250]]}])}];
  snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({refresh:{enabled:false}})},
    {rule_key:sticky?'__ATF__':'P2',rule_json:JSON.stringify({conditionalMappings:[mapping(disabled?{slotAction:'disable'}:{})]})}];
  return snapshot;
}
