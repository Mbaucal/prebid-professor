import {runtime324Site} from './runtime324-site.mjs';

/** Synthetic multi-SSP configuration used only by the reporting QA fixture. */
export function runtime325BrowserSite({cache=true,kind='standard'}={}) {
  const snapshot=runtime324Site({cache,prebid:kind!=='gam'});
  snapshot.site={id:'reporting-site',name:'Reporting QA',domain:'reporting.example.invalid',gam_path:'/999/reporting/'};
  snapshot.bidders=snapshot.bidders.filter(row=>row.bidder!=='pm_no');
  const config=JSON.parse(snapshot.config.config_json);
  config.runtimeControls.contextualSignals.enabled=false;
  config.runtimeControls.bidderRules.enabled=false;
  config.runtimeControls.deals.entries=[];
  snapshot.maps=snapshot.maps.filter(row=>row.name==='display');
  snapshot.maps[0].map_json=JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}]);
  snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({
    lazy:{enabled:false,fetchMarginPx:0,renderMarginPx:0},timeout:800,cmpTimeout:kind==='timeout'?1000:10000,
    refresh:{enabled:true,minSeconds:30,minViewPct:0,requirePreviousViewable:false,checkEveryMs:1000},
  })}];
  if(kind==='lazy') {
    snapshot.units=snapshot.units.filter(row=>row.code==='P1');
    snapshot.units[0].type='BTF';
    snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:JSON.stringify({
      lazy:{enabled:true,fetchMarginPx:200,renderMarginPx:0},timeout:800,cmpTimeout:10000,refresh:{enabled:false},
    })}];
  }
  if(kind==='late-lazy') {
    snapshot.units.find(row=>row.code==='P1').type='BTF';
    snapshot.rules.push({rule_key:'P1',rule_json:JSON.stringify({lazy:{enabled:true,fetchMarginPx:200,renderMarginPx:0},refresh:{enabled:false}})});
  }
  if(kind==='mixed-gam') {
    snapshot.units.find(row=>row.code==='P1').size_map_key='fluid';
    snapshot.maps.push({name:'fluid',map_json:JSON.stringify([{viewport:[0,0],sizes:['fluid']}])});
  }
  snapshot.config.config_json=JSON.stringify(config);
  return snapshot;
}
