import { defaultOverlay } from '../../worker/runtime-next/position-settings.mjs';
export function positionFixture(prebid=true){
  return {
    site:{id:'test-site',name:'Position test',domain:'example.invalid',gam_path:'/123/test/'},
    config:{config_json:JSON.stringify({enablePrebid:prebid,runtimeControls:{sticky:{bottomAdUnitId:''},floors:{enabled:false},currencyConversion:{enabled:false},
      adPositions:{Overlay:{...defaultOverlay(),demand:prebid?'site':'gam',desktopSeconds:0,mobileSeconds:0}}}})},
    units:[{code:'Billboard',type:'ATF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:0},
      {code:'P1',type:'BTF',media_type:'banner',size_map_key:'display',enabled:1,sort_order:1},
      {code:'Overlay',type:'ATF',media_type:'banner',size_map_key:'modal',enabled:1,sort_order:2}],
    bidders:prebid?[{bidder:'pubmatic',params_json:'{"publisherId":"test-publisher","adSlot":"default"}',enabled:1}]:[],
    overrides:prebid?[{bidder:'pubmatic',scope_type:'adunit',scope_key:'Overlay',params_json:'{"adSlot":"overlay-slot"}',enabled:1}]:[],
    maps:[{name:'display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])},
      {name:'modal',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]},{viewport:[768,0],sizes:[[640,480]]},{viewport:[1200,0],sizes:[[800,600]]}])}],
    rules:[{rule_key:'__ATF__',rule_json:'{"lazy":{"enabled":false,"fetchMarginPx":0,"renderMarginPx":0},"timeout":300}'},
      {rule_key:'__BTF__',rule_json:'{"lazy":{"enabled":true,"fetchMarginPx":500,"renderMarginPx":0},"timeout":300}'}],prebidBuilds:[]
  };
}
