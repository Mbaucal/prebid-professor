import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import vm from 'node:vm';
import {templates,exportJson,gamTemplate,normalizeOptions,exportFilename} from '../../src/creative-templates/catalog.mjs';
const encodedFields={Image:'https://cdn.example.com/image.png',ClickURL:'https://example.com/landing',AltText:'Apostrophe \' Quote " slash \\ </script> & Unicode č',MobileImage:''};
function expand(formatter,fields=encodedFields){return formatter.replace(/\[%URI_ENCODE:(\w+)%\]/g,(_,key)=>encodeURIComponent(fields[key])).replace('%%CLICK_URL_ESC%%',encodeURIComponent('https://adclick.example.com/?adurl='));}
function script(html){return html.slice(html.indexOf('<script>')+8,html.indexOf('</script>'));}
test('four native GAM JSON exports use the observed UI schema and unique declared variables',()=>{
 for(const t of templates){
  const out=JSON.parse(exportJson(t.id));assert.equal(out.type,'USER_DEFINED');assert.equal(out.isInterstitial,false);assert.equal(out.isSafeFrameCompatible,t.safeFrame);
  assert.equal(typeof out.formatter,'string');assert(!('snippet' in out));assert.equal(out.variables.length,t.id==='responsive'?4:3);
  const macros=[...out.formatter.matchAll(/\[%URI_ENCODE:(\w+)%\]/g)].map(m=>m[1]);
  assert.deepEqual([...macros].sort(),out.variables.map(v=>v.uniqueName).sort());assert.equal(new Set(macros).size,macros.length);
  for(const v of out.variables){assert(['ASSET','STRING','URL'].includes(v.variableType));assert.equal(typeof v.isRequired,'boolean');if(v.variableType==='ASSET')assert.deepEqual(v.mimeTypes,['PNG','GIF','JPG']);}
  const rendered=expand(out.formatter);assert.equal(rendered.split('</script>').length,2);assert.doesNotThrow(()=>parse(script(rendered),{ecmaVersion:'latest'}));
  assert.match(exportFilename(t.id),/^tessera-[a-z]+-v1.0.0.json$/);
 }
});
test('export rejects malformed numbers and unknown settings rather than outputting broken creative code',()=>{
 for(const width of [NaN,Infinity,'300',0,-1,2001,1.5])assert.throws(()=>normalizeOptions('incorner',{width}));
 assert.throws(()=>normalizeOptions('branding',{side:'top'}));assert.throws(()=>normalizeOptions('image',{minViewport:0}));
 assert.equal(normalizeOptions('incorner',{side:'left',width:320}).width,320);
});
test('InCorner calls the publisher bridge once with safely decoded content and tracked click',()=>{
 const calls=[],bridge={mount:(source,cfg)=>calls.push({source,cfg})};const parent={__tesseraCreativesV1:bridge};parent.parent=parent;
 const window={parent},html=expand(gamTemplate('incorner').formatter);
 vm.runInNewContext(script(html),{window,URL,console});
 assert.equal(calls.length,1);assert.equal(calls[0].source,window);assert.equal(calls[0].cfg.alt,encodedFields.AltText);assert.equal(calls[0].cfg.click,'https://adclick.example.com/?adurl=https://example.com/landing');
});
test('missing bridge / cross-origin parent produces no overlay or close button',()=>{
 const window={};Object.defineProperty(window,'parent',{get(){throw Error('cross origin');}});
 assert.doesNotThrow(()=>vm.runInNewContext(script(expand(gamTemplate('incorner').formatter)),{window,URL,console:{warn(){}}}));
});
test('unsafe asset and destination protocols never acquire display ownership',()=>{
 for(const key of ['Image','ClickURL']){let calls=0;const window={__tesseraCreativesV1:{mount(){calls++;}}};window.parent=window;
  vm.runInNewContext(script(expand(gamTemplate('incorner').formatter,{...encodedFields,[key]:'javascript:alert(1)'})),{window,URL,console});assert.equal(calls,0);
 }
});
