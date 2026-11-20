/** Local rules only. Neither this policy nor its diagnostics grant consent or install RTD. */
export function createAdaptiveAuctionTimeout(win, policy) {
  var history=[],sequence=0;
  function finite(value){return typeof value==='number'&&Number.isFinite(value);}
  function copy(row){return Object.assign({},row,{codes:row.codes.slice(),reasons:row.reasons.slice()});}
  function resolve(input,baseMs) {
    var configured=baseMs===undefined?input.timeout:baseMs;
    var base=finite(configured)&&configured>=1?Math.round(configured):1000;
    var units=input.adUnits||[],codes=[],video=false,banner=false;
    (units.length?units.map(function(u){return u.code;}):input.adUnitCodes||[]).forEach(function(code){if(codes.indexOf(code)<0)codes.push(code);});
    units.forEach(function(unit){if(unit.mediaTypes&&unit.mediaTypes.video)video=true;if(unit.mediaTypes&&unit.mediaTypes.banner)banner=true;});
    var device='unknown',connection='unknown',format=video?(banner?'mixed':'video'):(banner?'banner':'unknown');
    try{if(win.navigator&&win.navigator.userAgentData&&typeof win.navigator.userAgentData.mobile==='boolean')device=win.navigator.userAgentData.mobile?'mobile':'desktop';
      else if(typeof win.matchMedia==='function'&&finite(win.innerWidth)&&win.innerWidth>0)device=win.matchMedia('(max-width: 767px)').matches?'mobile':'desktop';}catch(_){}
    try{var c=win.navigator&&(win.navigator.connection||win.navigator.mozConnection||win.navigator.webkitConnection);
      if(c){if(['slow-2g','2g','3g'].indexOf(c.effectiveType)>=0)connection='slow';else if(c.effectiveType==='4g')connection='fast';
        else if(finite(c.downlink)&&c.downlink>0)connection=c.downlink<=1.5?'slow':'fast';}}catch(_){}
    var reasons=[],value=base,extra=0;
    if(policy.enabled){
      reasons.push('configured-position-timeout');
      if(device==='mobile'){value+=policy.mobileAdjustmentMs;reasons.push('mobile');}else reasons.push(device==='unknown'?'device-unknown-fallback':'desktop');
      if(connection==='slow'){value+=policy.slowConnectionAdjustmentMs;reasons.push('slow-connection');}else reasons.push(connection==='unknown'?'connection-unknown-fallback':'fast-connection');
      if(video){value+=policy.videoAdjustmentMs;reasons.push('video');}else reasons.push(format==='unknown'?'format-unknown-fallback':'banner');
      extra=Math.min(policy.maxPositionAdjustmentMs,Math.max(0,codes.length-1)*policy.additionalPositionMs);
      if(extra){value+=extra;reasons.push('additional-positions');}
      if(value<policy.minMs)reasons.push('minimum');if(value>policy.maxMs)reasons.push('maximum');
      value=Math.max(policy.minMs,Math.min(policy.maxMs,value));
    }else reasons.push('disabled-configured-timeout');
    var row={id:++sequence,codes:codes,enabled:!!policy.enabled,baseMs:base,timeoutMs:value,nativeTimeoutMs:null,failsafeMs:null,device:device,connection:connection,format:format,positionCount:codes.length,reasons:reasons};
    history.push(row);if(history.length>50)history.shift();return row;
  }
  function started(row,event) {
    var actual=event&&event.timeout;
    if(!finite(actual)||actual<1||actual>30000){actual=row.timeoutMs;row.reasons.push('native-timeout-unknown-fallback');}
    else {actual=Math.ceil(actual);if(actual!==row.timeoutMs)row.reasons.push('native-rtd-override');}
    row.nativeTimeoutMs=actual;row.failsafeMs=actual+500;return {actualMs:actual,failsafeMs:row.failsafeMs};
  }
  return {resolve:resolve,started:started,snapshot:function(){return {enabled:!!policy.enabled,localBounds:{minMs:policy.minMs,maxMs:policy.maxMs},nativeSafetyMaxMs:30000,auctions:history.map(copy)};}};
}
