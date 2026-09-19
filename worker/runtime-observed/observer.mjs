// Serialized into the new runtime only. Local diagnostics; never sends telemetry.
export function observeRuntime(metadata, ownsSlot) {
  var registry=window.__tesseraRuntimeDiagnostics||(window.__tesseraRuntimeDiagnostics=Object.create(null));
  var previous=registry[metadata.siteId];
  if(previous){previous.attempt();return {start:function(){return false;}};}
  var attempts=1,started=0,stopped=false,origin=Date.now(),events=[],dropped=0;
  var totals={requests:0,renders:0,empty:0,filled:0,iframeLoads:0,viewableEvents:0,ambiguousRenders:0};
  var cycles=new WeakMap(),listeners=[],service=null,firstFilledRenderMs=null;
  var elapsed=function(){return Math.max(0,Date.now()-origin);};
  function record(type,slot,latency){
    if(events.length>=500){dropped++;return;}
    events.push({type:type,slot:slot||null,elapsedMs:elapsed(),requestToRenderMs:latency===undefined?null:latency});
  }
  var diagnostic={
    attempt:function(){attempts=Math.min(attempts+1,Number.MAX_SAFE_INTEGER);},
    snapshot:function(){return {schemaVersion:1,siteId:metadata.siteId,runtimeVersion:metadata.runtimeVersion,
      attempts:attempts,initializations:started,blockedDuplicates:attempts-1,stopped:stopped,
      firstFilledRenderMs:firstFilledRenderMs,totals:Object.assign({},totals),events:events.map(function(e){return Object.assign({},e);}),droppedEvents:dropped};},
    stop:function(){stopped=true;listeners.forEach(function(pair){try{service.removeEventListener(pair[0],pair[1]);}catch(_){}});listeners=[];}
  };
  registry[metadata.siteId]=diagnostic;
  function install(){
    if(stopped)return;
    try{
      service=window.googletag.pubads();
      ['slotRequested','slotRenderEnded','slotOnload','impressionViewable'].forEach(function(type){
        var listener=function(event){
          try{
            if(stopped||!event)return;
            var id=ownsSlot(event.slot);
            if(typeof id!=='string')return;
            if(metadata.units.indexOf(id)<0)return;
            var cycle=cycles.get(event.slot);
            if(type==='slotRequested'){
              totals.requests++;
              cycles.set(event.slot,{time:elapsed(),rendered:false,ambiguous:!!(cycle&&!cycle.rendered)});
              record('requested',id);
            }else if(type==='slotRenderEnded'){
              if(cycle&&cycle.rendered)return; // duplicate callback, not a refresh
              var latency=null;
              if(cycle&&!cycle.ambiguous)latency=Math.max(0,elapsed()-cycle.time);
              else totals.ambiguousRenders++;
              if(cycle)cycle.rendered=true;
              else cycles.set(event.slot,{rendered:true,ambiguous:true,time:elapsed()});
              totals.renders++;
              if(event.isEmpty===true){totals.empty++;record('empty',id,latency);}
              else if(event.isEmpty===false){totals.filled++;if(firstFilledRenderMs===null)firstFilledRenderMs=elapsed();record('filled-render',id,latency);}
              else record('render-unknown',id,latency);
            }else if(type==='slotOnload'){totals.iframeLoads++;record('iframe-load',id);}
            else{totals.viewableEvents++;record('viewable-event',id);}
          }catch(_){record('observer-event-error');}
        };
        service.addEventListener(type,listener);listeners.push([type,listener]);
      });
      record('gpt-listeners-ready');
    }catch(_){record('observer-setup-error');diagnostic.stop();}
  }
  return {start:function(){
    if(started||stopped)return false;
    if(window.__TESSERA_RUNTIME_STARTED){record('legacy-conflict');return false;}
    started=1;record('runtime-entered');
    // Installation precedes this new runtime's own GPT setup queue.
    try{window.googletag=window.googletag||{cmd:[]};window.googletag.cmd=window.googletag.cmd||[];window.googletag.cmd.push(install);}
    catch(_){record('observer-setup-error');}
    return true;
  }};
}
