import {bidCacheSite,OUTSTREAM} from './bid-cache323-site.mjs';

/** One synthetic publisher exercises the feature intersection, never a real account. */
export function runtime324Site({cache=true,prebid=true,formats=false,lazy=false,sticky=false,floor=null,maxAge=60}={}) {
  const snapshot=bidCacheSite({cache:{enabled:cache,maxBidAgeSeconds:maxAge},takeOver:formats,outstream:formats});
  snapshot.site={id:'combined-site',name:'Combined runtime fixture',domain:'combined.example.invalid',gam_path:'/999/combined/'};
  const config=JSON.parse(snapshot.config.config_json);
  config.enablePrebid=prebid;
  config.userSync={syncEnabled:false,syncsPerBidder:0,syncDelay:0,auctionDelay:0,userIds:[]};
  config.runtimeControls.schain={enabled:true,version:'1.0',complete:1,nodes:[{asi:'site.example.invalid',sid:'site',hp:1}]};
  config.runtimeControls.bidderRules={schemaVersion:1,enabled:true,rules:[
    {id:'agency',name:'Agency in Serbia',enabled:true,bidder:'pm_ag',positions:[],countries:{mode:'include',values:['RS'],unknown:'skip'},devices:['desktop','tablet','mobile']},
    {id:'direct',name:'Direct device selection',enabled:true,bidder:'pm_no',positions:[],countries:{mode:'all',values:[],unknown:'allow'},devices:['desktop']},
  ]};
  config.runtimeControls.contextualSignals={schemaVersion:1,enabled:true,sourceKey:'category',gam:{enabled:true},
    bidders:[{bidder:'pubmatic',taxonomy:'iab-content-2.2'},{bidder:'pm_ag',taxonomy:'iab-content-3.0'},{bidder:'openx',taxonomy:'iab-content-2.2'}],
    mappings:[{value:'Sports',taxonomies:{'iab-content-2.2':['483'],'iab-content-3.0':['VK7KD0']}}]};
  config.runtimeControls.deals={schemaVersion:1,entries:[{id:'agency-deal',name:'Agency deal',bidder:'pm_ag',dealId:'D-999',positions:['Billboard','P1'],
    startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',enabled:true,mode:'price'}]};
  snapshot.bidders=[
    {bidder:'pubmatic',params_json:'{"publisherId":"1","adSlot":"site"}',enabled:1,account_json:'{}'},
    {bidder:'pm_ag',params_json:'{"publisherId":"2","adSlot":"agency"}',enabled:1,account_json:JSON.stringify({baseAdapter:'pubmatic',displayName:'Agency',schain:{mode:'custom',config:{ver:'1.0',complete:1,nodes:[{asi:'agency.example.invalid',sid:'agency',hp:1}]}}})},
    {bidder:'pm_no',params_json:'{"publisherId":"3","adSlot":"direct"}',enabled:1,account_json:JSON.stringify({baseAdapter:'pubmatic',displayName:'Direct',schain:{mode:'none'}})},
    {bidder:'openx',params_json:'{"unit":"1","delDomain":"synthetic.example.invalid"}',enabled:1,account_json:'{}'},
  ];
  snapshot.maps[0].map_json=JSON.stringify([{viewport:[0,0],sizes:[[300,250]]},{viewport:[1024,0],sizes:[[300,250],[970,250],[160,600]]}]);
  snapshot.maps.push({name:'sports_display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]},{viewport:[1024,0],sizes:[[300,250],[970,250]]}])});
  if(lazy){
    snapshot.units=snapshot.units.filter(unit=>unit.code==='P1');snapshot.units[0].type='BTF';
    snapshot.rules=[{rule_key:'__DEFAULT__',rule_json:'{"refresh":{"enabled":false}}'}];
    config.runtimeControls.deals.entries[0].positions=['P1'];
  }
  if(formats){
    config.prebidBidCache.positionOverrides={Overlay:true,P2:true};
    config.runtimeControls.outstream.units.P2={...OUTSTREAM};
    snapshot.prebidBuilds=[{id:'native',publisher_id:snapshot.site.id,version:'11.34.0',file_key:'native',modules_json:'["pubmaticBidAdapter"]',status:'current'}];
  }
  if(sticky){
    config.runtimeControls.sticky.bottomAdUnitId='Sticky';
    snapshot.units.push({code:'Sticky',type:'ATF',media_type:'banner',size_map_key:'sticky',enabled:1,sort_order:4});
    snapshot.maps.push({name:'sticky',map_json:JSON.stringify([{viewport:[0,0],sizes:[[320,100]]}])});
  }
  if(floor!==null){
    const rules={};for(const device of ['desktop','mobile','tablet']){rules[`banner|*|${device}|*|morning`]=floor==='zero'?0:2;rules[`banner|*|${device}|*|afternoon`]=floor==='zero'?0:floor==='valid'?3:10;}
    config.runtimeControls.floors={enabled:true,currency:'EUR',hardFloor:floor==='zero'?0:0.04,bidderFloors:{},rules};
  }
  snapshot.config.config_json=JSON.stringify(config);
  return snapshot;
}
