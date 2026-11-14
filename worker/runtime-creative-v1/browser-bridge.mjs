/** Serialized into the versioned wrapper. Only the actual friendly creative
 * frame of a configured GPT slot can acquire its display. No postMessage API,
 * selectors, arbitrary HTML, scripts or publisher URLs accepted from creatives. */
export function installCreativeBridge(ctx) {
  var win=ctx.window,doc=ctx.document,leases=new Map(),retired=new WeakMap(),closed=new Set();
  function findHost(source){
    try{
      if(!source||source===win||retired.get(source)===source.document)return null;
      var cursor=source,frame;
      for(var i=0;i<10&&cursor!==win;i++){if(retired.get(cursor)===cursor.document)return null;frame=cursor.frameElement;if(!frame)return null;if(cursor.parent===win)break;cursor=cursor.parent;}
      if(!frame||!frame.isConnected||cursor.parent!==win)return null;
      var host=frame.closest('[id]');
      while(host){if(ctx.getSlot(host.id)&&host.contains(frame))return host;host=host.parentElement;}
    }catch(_){}
    return null;
  }
  function https(value){try{var u=new URL(value);return u.protocol==='https:'&&value.length<=8192;}catch(_){return false;}}
  function stop(id,reason){
    var item=leases.get(id);if(!item)return;
    leases.delete(id);retired.set(item.source,item.sourceDocument);clearTimeout(item.timeout);
    item.image.onload=null;item.image.onerror=null;
    win.removeEventListener('resize',item.resize);item.observer.disconnect();item.node.remove();
    try{item.source.removeEventListener('pagehide',item.unload);}catch(_){}
    item.host.removeAttribute('data-tessera-creative-owner');
    ctx.onRelease(id,reason);
  }
  function requested(id){
    var host=doc.getElementById(id);
    if(host)host.querySelectorAll('iframe').forEach(function(frame){if(frame.contentWindow)retired.set(frame.contentWindow,frame.contentDocument);});
    stop(id,'refresh');
  }
  function mount(source,cfg){
    var host=findHost(source);if(!host||!cfg||typeof cfg!=='object'||closed.has(host.id)||!ctx.canClaim(host.id))return false;
    if(!['incorner','branding'].includes(cfg.kind)||!['left','right'].includes(cfg.side))return false;
    if(cfg.kind==='incorner'&&host.id!==ctx.stickyId)return false;
    if(cfg.kind==='branding'&&host.id===ctx.stickyId)return false;
    if(!https(cfg.image)||!https(cfg.click)||typeof cfg.alt!=='string'||cfg.alt.length>1000)return false;
    if(!Number.isInteger(cfg.width)||cfg.width<1||cfg.width>2000||!Number.isInteger(cfg.height)||cfg.height<1||cfg.height>2000)return false;
    if(!Number.isInteger(cfg.offset)||cfg.offset<0||cfg.offset>100||!Number.isInteger(cfg.minViewport)||cfg.minViewport<0||cfg.minViewport>4000)return false;
    if(cfg.kind==='branding'&&(!Number.isInteger(cfg.contentWidth)||cfg.contentWidth<0||cfg.contentWidth>4000))return false;
    if(leases.has(host.id))return leases.get(host.id).source===source;
    var node=doc.createElement('div'),link=doc.createElement('a'),image=doc.createElement('img'),button=doc.createElement('button');
    node.setAttribute('data-tessera-creative',cfg.kind);node.setAttribute('role','region');node.setAttribute('aria-label','Advertisement');
    node.style.cssText='position:fixed;z-index:2147483001;display:none;box-sizing:border-box;line-height:0;';
    link.href=cfg.click;link.target='_blank';link.rel='noopener noreferrer';
    image.alt=cfg.alt;image.style.cssText='display:block;width:100%;height:auto;border:0;';
    image.width=cfg.width;image.height=cfg.height;
    button.type='button';button.textContent='×';button.setAttribute('aria-label','Close ad');
    button.style.cssText='position:absolute;right:4px;top:4px;width:32px;height:32px;min-width:32px;padding:0;border:1px solid #777;border-radius:50%;background:#fff;color:#222;font:26px/28px Arial;cursor:pointer;z-index:1;';
    link.appendChild(image);node.appendChild(link);node.appendChild(button);
    var item={source:source,sourceDocument:source.document,host:host,node:node,image:image,ready:false,timeout:null,resize:null,observer:null,unload:null};
    function isCurrent(){return leases.get(host.id)===item&&host.isConnected&&findHost(source)===host;}
    function resize(){
      if(!isCurrent()){stop(host.id,'removed');return;}
      var viewport=win.innerWidth,height=win.innerHeight;
      var room=cfg.kind==='branding'?(viewport-cfg.contentWidth)/2-cfg.offset*2:viewport-cfg.offset*2;
      var width=Math.min(cfg.width,room,(height-cfg.offset*2)*cfg.width/cfg.height);
      var visible=item.ready&&viewport>=cfg.minViewport&&width>=Math.min(cfg.width,120)&&height>cfg.offset*2;
      node.style.display=visible?'block':'none';node.style.width=Math.max(0,width)+'px';
      node.style[cfg.side]='max('+cfg.offset+'px, env(safe-area-inset-'+cfg.side+'))';
      if(cfg.kind==='incorner')node.style.bottom='max('+cfg.offset+'px, env(safe-area-inset-bottom))';
      else node.style.top=Math.max(cfg.offset,(height-width*cfg.height/cfg.width)/2)+'px';
    }
    item.resize=resize;item.unload=function(){stop(host.id,'removed');};
    item.observer=new win.MutationObserver(function(){if(!isCurrent())stop(host.id,'removed');});
    leases.set(host.id,item);
    if(!doc.getElementById('tessera-creative-owner-css')){var style=doc.createElement('style');style.id='tessera-creative-owner-css';style.textContent='[data-tessera-creative-owner="v1"]{display:none!important;min-height:0!important;height:0!important;padding:0!important;border:0!important}';doc.head.appendChild(style);}
    ctx.onClaim(host.id);host.setAttribute('data-tessera-creative-owner','v1');
    doc.body.appendChild(node);win.addEventListener('resize',resize);source.addEventListener('pagehide',item.unload);
    item.observer.observe(doc.documentElement,{childList:true,subtree:true});
    button.addEventListener('click',function(){closed.add(host.id);stop(host.id,'close');});
    image.onload=function(){if(!isCurrent())return;clearTimeout(item.timeout);item.ready=true;resize();};
    image.onerror=function(){if(leases.get(host.id)===item)stop(host.id,'error');};
    item.timeout=setTimeout(function(){if(leases.get(host.id)===item)stop(host.id,'error');},15000);
    image.src=cfg.image;
    return true;
  }
  win.addEventListener('pagehide',function(){Array.from(leases.keys()).forEach(function(id){stop(id,'pagehide');});});
  var publicApi=Object.freeze({version:1,mount:mount});
  Object.defineProperty(win,'__tesseraCreativesV1',{value:publicApi,configurable:true});
  return {owns:function(id){return leases.has(id);},requested:requested,empty:function(id){stop(id,'empty');}};
}
