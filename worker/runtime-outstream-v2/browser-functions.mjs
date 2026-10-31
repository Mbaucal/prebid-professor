/** Serialized into the explicitly selected revenue runtime. No module closures. */
export function outstreamPlayerSize(settings,mapName) {
  if(!settings)return null;
  if(settings.playerSizing!=='size-map')return settings.playerSize;
  var map=settings.playerSizeMaps.find(function(item){return item.name===mapName;});
  if(!map)return null;
  var width=window.innerWidth||document.documentElement.clientWidth||0;
  var height=window.innerHeight||document.documentElement.clientHeight||0;
  var row=map.rows.slice().sort(function(a,b){return b.viewport[0]-a.viewport[0]||b.viewport[1]-a.viewport[1];})
    .find(function(item){return width>=item.viewport[0]&&height>=item.viewport[1];});
  return row&&row.playerSize?row.playerSize.slice():null;
}
export function applyOutstreamUnit(unit, settings, mapName) {
  if(!unit || !settings || settings.format==='banner') return unit;
  const size=outstreamPlayerSize(settings,mapName);
  if(!size)return null;
  const video={context:'outstream',playerSize:[size.slice()],mimes:['video/mp4'],
    minduration:settings.minDuration,maxduration:settings.maxDuration,playbackmethod:[settings.playbackMethod],
    protocols:[2,3,5,6],linearity:1,placement:settings.placement,plcmt:settings.plcmt};
  const mediaTypes=settings.format==='outstream'?{video}:{...unit.mediaTypes,video};
  const bids=(unit.bids||[]).filter(bid=>settings.format!=='outstream'||bid.bidder===settings.partner.bidder).map(bid=>
    bid.bidder===settings.partner.bidder?{...bid,mediaTypes:{...mediaTypes},params:{...bid.params,outstreamAU:settings.partner.outstreamAU}}:
      {...bid,mediaTypes:{banner:{...unit.mediaTypes.banner}}});
  return {...unit,mediaTypes,bids};
}

/** PUC's iframe path calls pbjs.renderAd(document, adId). Keep native rendering;
 * only veto unsafe video IDs. Consent snapshot contains no TC string. */
export function installOutstreamRenderGuard(pb, options) {
  if(!pb || typeof pb.renderAd!=='function' || typeof pb.onEvent!=='function') throw Error('Native Prebid rendering is unavailable.');
  var original=pb.renderAd, records=Object.create(null), used=Object.create(null), disposed=false;
  function capture(bid) {
    if(!bid || bid.mediaType!=='video' || options.codes.indexOf(bid.adUnitCode)<0) return;
    var scope=options.consent();
    var record=records[bid.adId]={epoch:scope&&scope.ready?scope.epoch:-1,code:bid.adUnitCode,
      expires:Number(bid.responseTimestamp)+Number(bid.ttl)*1000,size:[Number(bid.width),Number(bid.height)]};
    // The vendor renderer may defer its bootstrap until its remote script loads.
    // Recheck at execution of the native queued callback, not only renderAd entry.
    if(bid.renderer && typeof bid.renderer.push==='function') {
      var push=bid.renderer.push;
      bid.renderer.push=function(fn){return push.call(this,function(){if(valid(record,bid.adId))return fn.apply(this,arguments);});};
    }
  }
  function valid(record,id) {
    var scope=options.consent();
    return !disposed&&scope&&scope.ready&&scope.epoch===record.epoch&&Number.isFinite(record.expires)&&Date.now()<record.expires&&options.authorized(record.code,id)&&(!options.sizeMatches||options.sizeMatches(record.code,record.size));
  }
  function guarded(doc,id) {
    var record=records[id];
    if(record) {
      if(used[id] || !valid(record,id)) return;
      used[id]=true;
    } else {
      // Fail closed if native Prebid knows a video bid we did not authorize.
      var responses=typeof pb.getBidResponses==='function'?pb.getBidResponses():{};
      if(Object.keys(responses).some(function(code){return (responses[code].bids||[]).some(function(bid){return bid.adId===id&&bid.mediaType==='video'&&options.codes.indexOf(code)>=0;});})) return;
    }
    return original.apply(this,arguments);
  }
  pb.onEvent('bidResponse',capture);pb.renderAd=guarded;
  return {dispose:function(){disposed=true;if(pb.renderAd===guarded)pb.renderAd=original;if(pb.offEvent)pb.offEvent('bidResponse',capture);records=Object.create(null);}};
}
