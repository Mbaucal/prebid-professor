import test from 'node:test';
import assert from 'node:assert/strict';
import {installCreativeBridge} from '../../worker/runtime-creative-v1/browser-bridge.mjs';
import {buildArtifactCandidate,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {positionFixture} from '../support/position-runtime-fixture.mjs';
import {pinRuntime} from '../../worker/runtime/version-pin.mjs';
class Element {
 constructor(tag,doc){this.tag=tag;this.doc=doc;this.children=[];this.attrs={};this.style={};this.events={};this.isConnected=false;this.id='';}
 appendChild(n){n.parentElement=this;this.children.push(n);n.isConnected=this.isConnected;return n;}
 setAttribute(k,v){this.attrs[k]=v;} removeAttribute(k){delete this.attrs[k];}
 contains(n){return n===this||this.children.some(c=>c.contains(n));}
 closest(){let n=this;while(n&&!n.id)n=n.parentElement;return n;}
 querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.querySelectorAll(tag)]);}
 addEventListener(k,fn){this.events[k]=fn;}removeEventListener(k){delete this.events[k];}
 remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(c=>c!==this);}
}
function fixture(){
 const doc={createElement:tag=>new Element(tag,doc),getElementById:id=>[doc.head,doc.body,...doc.head.querySelectorAll('style'),...doc.body.querySelectorAll('div')].find(n=>n.id===id)};
 doc.head=new Element('head',doc);doc.body=new Element('body',doc);doc.head.isConnected=doc.body.isConnected=true;doc.documentElement={};
 const events={},observers=[],win={innerWidth:1440,innerHeight:900,addEventListener(k,fn){(events[k]??=[]).push(fn);},removeEventListener(k,fn){events[k]=events[k]?.filter(f=>f!==fn);},MutationObserver:class{constructor(fn){this.fn=fn;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}}};
 const host=doc.createElement('div');host.id='Sticky';doc.body.appendChild(host);const frame=doc.createElement('iframe');host.appendChild(frame);
 const source={frameElement:frame,parent:win,document:{},addEventListener(){},removeEventListener(){}};frame.contentWindow=source;frame.contentDocument=source.document;
 const claimed=[],released=[];const bridge=installCreativeBridge({window:win,document:doc,stickyId:'Sticky',getSlot:id=>id===host.id?{}:null,canClaim:()=>true,onClaim:id=>claimed.push(id),onRelease:(id,why)=>released.push([id,why])});
 const cfg={kind:'incorner',image:'https://cdn.example.com/ad.png',click:'https://example.com/campaign',alt:'Ad',width:300,height:250,side:'right',offset:16,minViewport:0};
 return {doc,win,host,frame,source,bridge,cfg,claimed,released,observers,events,mount:()=>win.__tesseraCreativesV1.mount(source,cfg)};
}
test('InCorner claims sticky, shows only after image load, and user close cleans everything once',()=>{
 const f=fixture();assert(f.mount());assert(f.bridge.owns('Sticky'));assert.equal(f.host.attrs['data-tessera-creative-owner'],'v1');assert.deepEqual(f.claimed,['Sticky']);
 const overlay=f.doc.body.children.at(-1);assert.equal(overlay.style.display,undefined);assert.equal(overlay.querySelectorAll('button').length,1);
 const image=overlay.querySelectorAll('img')[0];image.onload();assert.equal(overlay.style.display,'block');assert.equal(overlay.style.width,'300px');
 overlay.querySelectorAll('button')[0].events.click();assert(!f.bridge.owns('Sticky'));assert(!overlay.isConnected);assert.deepEqual(f.released,[['Sticky','close']]);assert(!f.mount());assert.equal(f.events.resize.length,0);assert(f.observers[0].disconnected);
});
test('refresh cleans old creative, rejects its late callback and accepts new iframe document',()=>{
 const f=fixture();f.mount();const old=f.doc.body.children.at(-1),late=old.querySelectorAll('img')[0].onload;
 f.bridge.requested('Sticky');late();assert(!old.isConnected);assert(!f.mount());
 f.source.document={};f.frame.contentDocument=f.source.document;assert(f.mount());assert.equal(f.doc.body.querySelectorAll('button').length,1);f.bridge.requested('Sticky');
});
test('image error and removed source frame clean overlay and report a distinct release reason',()=>{
 for(const reason of ['error','removed']){const f=fixture();f.mount();const node=f.doc.body.children.at(-1);if(reason==='error')node.querySelectorAll('img')[0].onerror();else{f.frame.remove();f.observers[0].fn();}assert(!f.bridge.owns('Sticky'));assert(!node.isConnected);assert.deepEqual(f.released,[['Sticky',reason]]);}
});
test('foreign / detached frames and invalid payloads cannot hide a slot',()=>{
 for(const change of [f=>f.frame.remove(),f=>f.source.parent={},f=>f.cfg.image='data:text/html,x',f=>f.cfg.width=Infinity,f=>f.cfg.kind='html',f=>f.cfg.kind='branding']){const f=fixture();change(f);assert(!f.mount());assert.equal(f.claimed.length,0);assert.equal(f.doc.body.children.length,1);}
});
test('branding does not claim sticky and adapts to available space on resize',()=>{
 const f=fixture();f.host.id='Branding_Left';Object.assign(f.cfg,{kind:'branding',side:'left',width:160,height:600,minViewport:1366,contentWidth:1000});
 assert(f.mount());const overlay=f.doc.body.children.at(-1);overlay.querySelectorAll('img')[0].onload();assert.equal(overlay.style.display,'block');
 f.win.innerWidth=800;f.events.resize[0]();assert.equal(overlay.style.display,'none');f.bridge.requested('Branding_Left');
});
test('new exact runtime generates complete bridge package and retains old selectable engines',async()=>{
 const descriptor=runtimeCatalog.find(r=>r.capabilities.includes('creative-bridge-v1'));assert(descriptor);assert.equal(runtimeCatalog[0].version,'3.10.0-tessera.preview.1');
 const s=positionFixture(false),cfg=JSON.parse(s.config.config_json);cfg.runtimeControls.sticky.bottomAdUnitId='Billboard';s.config.config_json=JSON.stringify(cfg);
 const result=await buildArtifactCandidate({snapshot:s,pin:pinRuntime(descriptor,{allowPreview:true}),buildTimestamp:'20260922_120000'});
 for(const file of ['ads.js','ads.min.js']){const js=new TextDecoder().decode(result.files[file]);assert(js.includes('__tesseraCreativesV1'));assert(js.includes('slotRequested'));}
 const readable=new TextDecoder().decode(result.files['ads.js']);assert(readable.indexOf('var googletag =')<readable.indexOf('var TESSERA_CREATIVES ='));
 assert.equal(result.manifest.runtime.runtimeVersion,'3.11.0-tessera.preview.1');assert(result.manifest.patches.some(p=>p.includes('creative display ownership')));
});
