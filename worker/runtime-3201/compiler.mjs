import {parse} from 'acorn';
import {compileRuntime320} from '../runtime-320/compiler.mjs';
import {compilationInput} from '../runtime-3191/identity.mjs';
import {restoreCodeLiterals} from '../runtime-3191/compiler.mjs';
export {idempotentStickyStyles} from '../runtime-320/compiler.mjs';
const literal=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
function walk(node,fn,parent=null){if(!node||typeof node!=='object')return;fn(node,parent);for(const value of Object.values(node))if(Array.isArray(value))value.forEach(child=>walk(child,fn,node));else if(value&&typeof value==='object')walk(value,fn,node);}
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

/** Apply the validated identity layer after the complete viewport compiler. */
export function compileRuntime3201(input) {
  const {safeInput, identity} = compilationInput(input);
  const previous = compileRuntime320({...safeInput, conditionalCss: input.conditionalCss});
  let source = restoreCodeLiterals(previous.adsJs, identity.reverse);
  source = replaceStickyHosts(source);
  if (source.includes(identity.prefix)) throw Error('Temporary GAM code identifier escaped the compiler.');
  parse(source, {ecmaVersion: 2015});
  return {...previous, adsJs: source, adsMinJs: source, patches: [...previous.patches,
    '3.20.1: preserve GAM code identity and escaped selectors together with viewport size-map selection, conditional rules and initial resize recovery']};
}
