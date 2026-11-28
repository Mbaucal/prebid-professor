import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOutstream,buildOutstreamInput,hasEnabledOutstream} from '../../shared/outstream/settings.mjs';
import {applyOutstreamUnit,installOutstreamRenderGuard} from '../../worker/runtime-outstream-v1/browser-functions.mjs';
const settings={format:'banner-outstream',playerSize:[640,360],minDuration:5,maxDuration:30,playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'synthetic-renderer',activationConfirmed:true},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache'};
const context={units:[{code:'P1',media_type:'banner',type:'BTF',enabled:1,size_map_key:'display'}],maps:[{name:'display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[640,360]]}])}],bidders:[{bidder:'pubmatic',enabled:1}],enablePrebid:true,prebidVersion:'11.34.0',modules:['pubmaticBidAdapter']};
const saved=()=>({schemaVersion:1,units:{P1:structuredClone(settings)}});
test('explicit pilot requires actual build, module, enabled partner and activated renderer',()=>{
  assert.deepEqual(normalizeOutstream(saved(),context),saved());
  for(const patch of [{prebidVersion:'11.35.0'},{modules:[]},{enablePrebid:false},{bidders:[]},{blockedCodes:['P1']},{maps:[{name:'display',map_json:JSON.stringify([{viewport:[0,0],sizes:[[300,250]]}])}]}])assert.throws(()=>normalizeOutstream(saved(),{...context,...patch}));
  for(const patch of [{partner:{...settings.partner,activationConfirmed:false}},{partner:{...settings.partner,bidder:'alias'}},{cacheUrl:'https://unapproved.example/cache'},{playerSize:[0,360]},{maxDuration:3}]){const value=saved();Object.assign(value.units.P1,patch);assert.throws(()=>normalizeOutstream(value,context));}
});
test('GAM only emits no video and verified selected build metadata supplies context',()=>{
  const snapshot={...context,config:{config_json:JSON.stringify({enablePrebid:true,builtinRuntimeSelection:{prebid:{version:'11.34.0',modules:['pubmaticBidAdapter']}},runtimeControls:{outstream:saved()}})}};
  assert.deepEqual(buildOutstreamInput(snapshot).disabledRefreshCodes,['P1']);
  const config=JSON.parse(snapshot.config.config_json);assert.equal(hasEnabledOutstream(config),true);config.enablePrebid=false;snapshot.config.config_json=JSON.stringify(config);
  assert.deepEqual(buildOutstreamInput(snapshot),{units:{},disabledRefreshCodes:[],cacheUrl:null});
});
test('mixed native unit preserves original banner sizes/params and isolates unverified bidders',()=>{
  const unit={code:'P1',mediaTypes:{banner:{sizes:[[300,250],[300,600]]}},bids:[{bidder:'pubmatic',params:{publisherId:'1',adSlot:'display'}},{bidder:'other',params:{placement:'old'}}]};
  const before=structuredClone(unit),next=applyOutstreamUnit(unit,settings);
  assert.deepEqual(unit,before);assert.deepEqual(next.mediaTypes.banner,before.mediaTypes.banner);
  assert.equal(next.bids[0].params.adSlot,'display');assert.equal(next.bids[0].params.outstreamAU,'synthetic-renderer');
  assert.deepEqual(next.bids[1].mediaTypes,{banner:before.mediaTypes.banner});
  assert.equal(next.mediaTypes.video.context,'outstream');assert.deepEqual(next.mediaTypes.video.playerSize,[[640,360]]);
  const video=applyOutstreamUnit(unit,{...settings,format:'outstream'});assert.equal(video.bids.length,1);assert.equal(video.mediaTypes.banner,undefined);
  assert.strictEqual(applyOutstreamUnit(unit,{format:'banner'}),unit);
});
function fixture(){let handler,scope={ready:true,epoch:1},target=true,calls=0,played=0,queue=[];const pb={onEvent:(name,fn)=>handler=fn,offEvent(){},getBidResponses:()=>({}),renderAd(doc,id){calls++;if(id==='video1')queue[0]?.();return id;}};
 const guard=installOutstreamRenderGuard(pb,{codes:['P1'],consent:()=>scope,authorized:()=>target});
 const bid={adId:'video1',adUnitCode:'P1',mediaType:'video',ttl:30,responseTimestamp:Date.now(),renderer:{push(fn){queue.push(fn);}}};
 handler(bid);bid.renderer.push(()=>played++);
 return {pb,bid,guard,setScope:x=>scope=x,setTarget:x=>target=x,play:()=>queue[0](),counts:()=>({calls,played})};}
test('selected creative only; duplicate, changed epoch, expired and untargeted render denied',()=>{
 const f=fixture();assert.deepEqual(f.counts(),{calls:0,played:0});assert.equal(f.pb.renderAd({},'video1'),'video1');f.pb.renderAd({},'video1');assert.deepEqual(f.counts(),{calls:1,played:1});
 for(const change of [f=>f.setScope({ready:false,epoch:2}),f=>f.setScope({ready:true,epoch:2}),f=>f.setTarget(false)]){const x=fixture();change(x);x.pb.renderAd({},'video1');assert.deepEqual(x.counts(),{calls:0,played:0});}
 const x=fixture();x.setScope({ready:true,epoch:2});x.play();assert.equal(x.counts().played,0);
});
test('native banner render semantics preserved and queued video rechecks authorization',()=>{
 const f=fixture();assert.equal(f.pb.renderAd({},'banner'),'banner');f.setTarget(false);f.play();assert.equal(f.counts().played,0);
 f.guard.dispose();assert.equal(f.pb.renderAd({},'video1'),'video1');
});

test('disposing guard invalidates an already queued renderer callback',()=>{const f=fixture();f.guard.dispose();f.play();assert.equal(f.counts().played,0);});

test('disabled banner intent does not block a later rename/delete',()=>{assert.deepEqual(normalizeOutstream({schemaVersion:1,units:{OldCode:{format:'banner'}}},context),{schemaVersion:1,units:{}});assert.throws(()=>normalizeOutstream({schemaVersion:1,units:{OldCode:settings}},context));});
