import {parse} from 'acorn';
import {compileRuntime319} from '../runtime-319/compiler.mjs';
import {compilationInput} from './identity.mjs';
export {idempotentStickyStyles} from '../runtime-319/compiler.mjs';
const literal=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const dictionaryNames=new Set(['_slotMeta','_lastRefreshAt','_refreshCounts','_slotState','_auctionLock',
  'AD_UNIT_RULES','UNIT_OVERRIDES','TESSERA_LAZY','AD_CONDITIONAL_UNITS','AD_CONDITIONAL_DECISIONS',
  'prefetched','bidsReady','pendingDisplay','displayed','lastCallAt','S','seen','setMap','clearMap']);
const nestedDictionaryNames=new Set(['BIDDER_ADUNIT_PARAMS','BIDDER_SLOT_PARAMS']);
function walk(node,fn,parent=null){if(!node||typeof node!=='object')return;fn(node,parent);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(child=>walk(child,fn,node));else if(value&&typeof value==='object')walk(value,fn,node);}
function isMember(node,object,name){return node?.type==='MemberExpression'&&node.object?.name===object&&!node.computed&&node.property?.name===name;}
function replaceStickyHosts(source) {
  const edits=[];
  for(const name of ['getStickyHost','getStickyTopHost']) {
    const found=[];walk(parse(source,{ecmaVersion:2015}),node=>{if(node.type==='FunctionDeclaration'&&node.id?.name===name)found.push(node);});
    if(found.length!==1)throw Error(`GAM code compiler expected one ${name}.`);
    const id=name==='getStickyHost'?'STICKY_TARGET_ID':'STICKY_TOP_TARGET_ID';
    const classes=name==='getStickyHost'?'.cvj-sticky, .cvj_sticky, .stickyBottom, .sticky-bottom':'.cvj-sticky-top, .cvj_sticky_top, .stickyTop, .sticky-top';
    const body=`function ${name}(){
      var id=${id};if(!id)return null;
      var exact=document.getElementById(id);if(exact)return exact;
      var nodes=document.querySelectorAll('[data-ad], [data-slot]');
      for(var i=0;i<nodes.length;i++)if(nodes[i].getAttribute('data-ad')===id||nodes[i].getAttribute('data-slot')===id)return nodes[i];
      return document.querySelector(${literal(classes)});
    }`;
    edits.push({start:found[0].start,end:found[0].end,text:body});
  }
  for(const edit of edits.sort((a,b)=>b.start-a.start))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source;
}
/** Restore only known build sentinels, preserving JS strings and dictionary keys. */
export function restoreCodeLiterals(source,reverse) {
  const edits=[],wrapped=new Set();
  function wrap(node){if(wrapped.has(node))return;wrapped.add(node);edits.push({start:node.start,end:node.start,text:'Object.assign(Object.create(null), '},{start:node.end,end:node.end,text:')'});}
  walk(parse(source,{ecmaVersion:2015}),(node,parent)=>{
    if(node.type==='Literal'&&typeof node.value==='string'){
      const restored=reverse.get(node.value);
      if(restored!==undefined)edits.push({start:node.start,end:node.end,text:parent?.type==='Property'&&parent.key===node&&!parent.computed&&restored==='__proto__'?'['+literal(restored)+']':literal(restored)});
    }
    if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&node.init){
      if(dictionaryNames.has(node.id.name)&&node.init.type==='ObjectExpression')wrap(node.init);
      if(nestedDictionaryNames.has(node.id.name)&&node.init.type==='ObjectExpression'){
        wrap(node.init);for(const property of node.init.properties)if(property.value?.type==='ObjectExpression')wrap(property.value);
      }
      if(node.id.name==='TESSERA_OUTSTREAM'&&node.init.type==='ObjectExpression')for(const property of node.init.properties)if((property.key?.name??property.key?.value)==='units'&&property.value?.type==='ObjectExpression')wrap(property.value);
    }
    if(node.type==='AssignmentExpression'&&(isMember(node.left,'window','adSlots')||isMember(node.left,'window','__ADS_DWELL_VERIFIED')))wrap(node.right);
    if(node.type==='CallExpression'&&isMember(node.callee,'extra','hasOwnProperty')&&node.arguments.length===1){
      edits.push({start:node.callee.start,end:node.callee.end,text:'Object.prototype.hasOwnProperty.call'});
      edits.push({start:node.arguments[0].start,end:node.arguments[0].start,text:'extra, '});
    }
  });
  for(const edit of edits.sort((a,b)=>b.start-a.start||b.end-a.end))source=source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  return source;
}
export function compileRuntime3191(input) {
  const {safeInput,identity}=compilationInput(input);
  // CSS has its own grammar; never substitute a raw identifier into CSS source.
  const encoded={...safeInput,conditionalCss:input.conditionalCss};
  const previous=compileRuntime319(encoded);
  let source=restoreCodeLiterals(previous.adsJs,identity.reverse);
  source=replaceStickyHosts(source);
  if(source.includes(identity.prefix))throw Error('Temporary GAM code identifier escaped the compiler.');
  parse(source,{ecmaVersion:2015});
  return {...previous,adsJs:source,adsMinJs:source,patches:[...previous.patches,
    '3.19.1: preserve GAM punctuation/Unicode/leading-digit codes, escape generated CSS/HTML, and isolate code-keyed dictionaries']};
}
