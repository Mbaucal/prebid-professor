// Serialized only into the opt-in collected loader. No persistent browser IDs.
export function createAssignmentSender(current, receipt) {
  var types=[], acknowledged=[], attempts=0, busy=false, terminal=false, retry=null;
  var status=receipt ? 'pending' : 'disabled';
  var endpoint;
  try {
    endpoint=new URL('./collect',current.src);
    if(endpoint.origin!==window.location.origin)throw Error('Same origin required');
    if(!receipt)terminal=true;
    else if(!receipt.ticket || typeof window.fetch!=='function' || typeof AbortController!=='function')throw Error('Unavailable');
  }catch(_){status='unavailable';terminal=true;}
  function pending(){return types.some(function(t){return acknowledged.indexOf(t)<0;});}
  function flush() {
    if(terminal||busy||retry||!pending())return;
    if(attempts>=6){status='failed';terminal=true;return;}
    busy=true;attempts++;status='sending';
    var sent=types.slice(), controller=new AbortController();
    var timer=setTimeout(function(){controller.abort();},2000);
    Promise.resolve().then(function(){return window.fetch(endpoint.href,{method:'POST',credentials:'same-origin',
      cache:'no-store',keepalive:true,signal:controller.signal,headers:{'content-type':'application/json'},
      body:JSON.stringify({ticket:receipt.ticket,types:sent})});}).then(function(response){
      if(response.status!==204) {
        if(response.status>=400 && response.status<500 && response.status!==409 && response.status!==429)terminal=true;
        throw Error('Not acknowledged');
      }
      acknowledged=sent;status='acknowledged';
    }).catch(function(){status='failed';}).finally(function(){
      clearTimeout(timer);busy=false;
      if(!terminal&&pending()&&attempts<6){retry=setTimeout(function(){retry=null;flush();},250*attempts);}
      else if(pending()&&attempts>=6){status='failed';terminal=true;}
    });
  }
  return {
    record:function(type){
      if(['assigned','script-loaded','load-error','conflict'].indexOf(type)<0||terminal)return;
      if(types.indexOf(type)<0)types.push(type);
      flush();
    },
    snapshot:function(){return {profile:'assignment-collection-v1',status:status,attempts:attempts,
      acknowledgedTypes:acknowledged.slice(),pendingTypes:types.filter(function(t){return acknowledged.indexOf(t)<0;})};}
  };
}
