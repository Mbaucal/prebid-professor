// These functions are compiled into the reference IIFE, where its existing
// consent, bidder-override and GPT helpers are in scope. Never runtime eval.
export function tesseraOverlayDevice() {
  var width=window.innerWidth||document.documentElement.clientWidth||0;
  var height=window.innerHeight||document.documentElement.clientHeight||0;
  var rows=TESSERA_OVERLAY.maps.slice().sort(function(a,b){return b.viewport[0]-a.viewport[0]||b.viewport[1]-a.viewport[1];});
  var row=rows.find(function(r){return width>=r.viewport[0]&&height>=r.viewport[1];});
  if(!row||!row.sizes.length)return null;
  var desktop=width>=TESSERA_OVERLAY.desktopMinWidth;
  return {device:desktop?'desktop':'mobile',size:row.sizes[0].slice(),autoCloseSec:desktop?TESSERA_OVERLAY.desktopSeconds:TESSERA_OVERLAY.mobileSeconds};
}
export function tesseraOverlayAllowed() {
  if(!tesseraOverlayDevice())return false;
  if(!TESSERA_OVERLAY.frequencyMinutes)return true;
  try{
    var last=Number(sessionStorage.getItem('tessera:takeover:'+takeOverMainAdUnitPath()));
    return !last||Date.now()-last>=TESSERA_OVERLAY.frequencyMinutes*60000;
  }catch(_){return true;}
}
export function tesseraRecordOverlayView() {
  if(!TESSERA_OVERLAY.frequencyMinutes)return;
  try{sessionStorage.setItem('tessera:takeover:'+takeOverMainAdUnitPath(),String(Date.now()));}catch(_){}
}
export function tesseraStopOverlayAuction() {
  var state=window.__tesseraOverlayAuction;
  if(!state)return;
  state.closed=true;
  clearTimeout(state.timer);
  if(state.renderHandler&&window.pbjs&&pbjs.offEvent)try{pbjs.offEvent('adRenderSucceeded',state.renderHandler);}catch(_){}
}
export function tesseraRequestOverlay(slot) {
  var code=TESSERA_OVERLAY.code;
  var state={settled:false,closed:false,timer:null,renderHandler:null,renderedBid:null,pendingRender:null};
  window.__tesseraOverlayAuction=state;
  function alive(){return !state.closed&&_takeOverSlot===slot;}
  function requestGam(withBids){
    if(state.settled||!alive())return;
    state.settled=true;clearTimeout(state.timer);
    if(withBids){
      try{clearPrebidTargetingFromSlot(slot);applyTargetingMapToSlot(slot,pbjs.getAdserverTargetingForAdUnitCode(code)||{});}catch(_){}
    }
    _takeOver.status='requested';
    _takeOver.requestTimer=setTimeout(function(){if(alive())closeTakeOver('request-timeout');},TAKEOVER_REQUEST_TIMEOUT_MS);
    paRefresh();
  }
  function paRefresh(){googletag.pubads().refresh([slot]);takeOverEvent('request-sent',{path:takeOverMainAdUnitPath(),size:_takeOver.requestedSize});}
  var unit=HAS_PREBID&&TESSERA_OVERLAY.demand==='site'?adUnitFromCode(code):null;
  if(!unit||!unit.bids||!unit.bids.length){requestGam(false);return;}
  // Lock the sizes at initialization; a resize never starts another auction.
  unit.mediaTypes.banner={sizes:[_takeOver.requestedSize.slice()]};
  var timeout=getAdUnitTimeoutMs(code);
  state.timer=setTimeout(function(){requestGam(false);},timeout+100);
  _takeOver.status='bidding';
  pbjs.que.push(function(){
    if(state.settled||!alive())return;
    try{
      state.renderHandler=function(event){
        var bid=event&&event.bid;
        if(!alive()||!bid||bid.adUnitCode!==code)return;
        var ids=[];
        (slot.getTargetingKeys?slot.getTargetingKeys():[]).forEach(function(key){if(key.indexOf('hb_adid')===0)ids=ids.concat(slot.getTargeting(key)||[]);});
        if(!ids.some(function(id){return String(id)===String(bid.adId);}))return;
        if(!takeOverSizeMatches([Number(bid.width),Number(bid.height)],_takeOver.requestedSize))return;
        state.renderedBid=bid;
        tesseraConfirmOverlayRender();
      };
      if(pbjs.onEvent)pbjs.onEvent('adRenderSucceeded',state.renderHandler);
      pbjs.requestBids({adUnits:[unit],timeout:timeout,bidsBackHandler:function(){requestGam(true);}});
    }catch(_){requestGam(false);}
  });
}
export function tesseraConfirmOverlayRender() {
  var state=window.__tesseraOverlayAuction;
  if(!state||state.closed||!state.pendingRender||!state.renderedBid)return;
  var ev=state.pendingRender;state.pendingRender=null;
  // A 1x1 universal creative needs a matching successful Prebid render and
  // numeric dimensions. Merely having hb_bidder on the slot is insufficient.
  takeOverOnSlotRenderEnded(Object.assign({},ev,{size:[Number(state.renderedBid.width),Number(state.renderedBid.height)]}));
}
export function tesseraLazyRule(code) {
  var cfg=getUnitConfigById(code)||{};
  var layers=[TESSERA_LAZY.__DEFAULT__,TESSERA_LAZY[String(cfg.type).toUpperCase()==='ATF'?'__ATF__':'__BTF__'],TESSERA_LAZY[code]];
  var rule=null;
  layers.forEach(function(layer){if(layer)rule=Object.assign(rule||{},layer);});
  return rule;
}
export function tesseraWireConfiguredLazy() {
  Object.keys(window.adSlots||{}).forEach(function(code){
    var slot=window.adSlots[code],cfg=getUnitConfigById(code)||{},rule=tesseraLazyRule(code);
    if(!rule||slot.__tesseraLazyWired)return;
    slot.__tesseraLazyWired=true;
    if(!rule.enabled&&String(cfg.type).toUpperCase()==='ATF')return;
    var dom=document.getElementById(code);
    if(!dom||!slotHasCurrentViewportSizes(code))return;
    var started=false,ready=false,wantsRender=false,displayed=false,timer=null,fetchIO=null,renderIO=null;
    function render(){
      if(displayed||!ready||!wantsRender)return;
      displayed=true;if(fetchIO)fetchIO.disconnect();if(renderIO)renderIO.disconnect();
      googletag.cmd.push(function(){if(window.adSlots[code]===slot&&slotHasCurrentViewportSizes(code))googletag.pubads().refresh([slot]);});
    }
    function done(withBids){
      if(ready)return;ready=true;clearTimeout(timer);
      if(withBids)applyPrebidTargetingToSlots([code]);render();
    }
    function fetch(){
      if(started)return;started=true;
      var unit=HAS_PREBID?adUnitFromCode(code):null;
      if(!unit||!unit.bids||!unit.bids.length){done(false);return;}
      var timeout=getAdUnitTimeoutMs(code);
      timer=setTimeout(function(){done(false);},timeout+100);
      pbjs.que.push(function(){
        if(ready)return;
        try{pbjs.requestBids({adUnits:[unit],timeout:timeout,bidsBackHandler:function(){done(true);}});}catch(_){done(false);}
      });
    }
    if(!rule.enabled||typeof IntersectionObserver!=='function'){wantsRender=true;fetch();return;}
    fetchIO=new IntersectionObserver(function(entries){if(entries.some(function(e){return e.isIntersecting;})){fetchIO.disconnect();fetch();}},{rootMargin:rule.fetchMarginPx+'px',threshold:0});
    renderIO=new IntersectionObserver(function(entries){if(entries.some(function(e){return e.isIntersecting;})){wantsRender=true;renderIO.disconnect();fetch();render();}},{rootMargin:rule.renderMarginPx+'px',threshold:0});
    fetchIO.observe(dom);renderIO.observe(dom);
  });
}
