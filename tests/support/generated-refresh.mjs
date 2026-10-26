// Refresh intervals from the real generated scheduler of each script version: the
// compiled `_plainMerge`, `getAdUnitRuntimeRule` and `getAdUnitRefreshRule`, with every
// global constant they read exactly as the compiler emitted it, run in a VM for 0..3
// completed refreshes on desktop and mobile. Local SQLite snapshot only; no browser or network.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {parse} from 'acorn';
import {readPreviewSnapshot} from '../../worker/runtime/builtin-preview-service.mjs';
import {previewInput,runtimeCatalog} from '../../worker/test-workspace/runtime-catalog.mjs';
import {compileRuntime316} from '../../worker/runtime-316/compiler.mjs';
import {compileRuntime3161} from '../../worker/runtime-3161/compiler.mjs';
import {compileRuntime3162} from '../../worker/runtime-3162/compiler.mjs';
import {refreshSummary} from '../../worker/site-runtime/refresh-summary.mjs';

const COMPILERS={'3.16.0':compileRuntime316,'3.16.1':compileRuntime3161,'3.16.2':compileRuntime3162};
const SCHEDULER=['_plainMerge','getAdUnitRuntimeRule','getAdUnitRefreshRule'];
const CONSTANT=/^[A-Z][A-Z0-9_]*$/;

function walk(node,visit,parent=null){
 if(!node||typeof node!=='object')return;visit(node,parent);
 for(const value of Object.values(node))if(Array.isArray(value))value.forEach(item=>walk(item,visit,node));else if(value&&typeof value==='object')walk(value,visit,node);
}
// Upper-case global names an expression reads (not property names or object keys).
function constantsRead(node){
 const names=new Set();
 walk(node,(item,parent)=>{
  if(item.type!=='Identifier'||!CONSTANT.test(item.name))return;
  if(parent?.type==='MemberExpression'&&parent.property===item&&!parent.computed)return;
  if(parent?.type==='Property'&&parent.key===item&&!parent.computed&&!parent.shorthand)return;
  names.add(item.name);
 });
 return names;
}
/** The scheduler functions preceded by the declarations of every constant they read (directly or through another constant), in source order. */
function schedulerProgram(source,version){
 const functions={},declarations={};
 walk(parse(source,{ecmaVersion:'latest'}),node=>{
  if(node.type==='FunctionDeclaration'&&SCHEDULER.includes(node.id.name))(functions[node.id.name]??=[]).push(node);
  if(node.type==='VariableDeclarator'&&node.id.type==='Identifier'&&CONSTANT.test(node.id.name)&&node.init)(declarations[node.id.name]??=[]).push(node);
 });
 for(const name of SCHEDULER)assert.equal(functions[name]?.length,1,`${version} declares ${name} once`);
 const needed=new Set(),pending=SCHEDULER.flatMap(name=>[...constantsRead(functions[name][0])]);
 while(pending.length){
  const name=pending.pop();if(needed.has(name))continue;
  assert.equal(declarations[name]?.length,1,`${version} declares the scheduler constant ${name} once`);
  needed.add(name);pending.push(...constantsRead(declarations[name][0].init));
 }
 const constants=[...needed].map(name=>declarations[name][0]).sort((a,b)=>a.start-b.start)
  .map(node=>`var ${node.id.name} = ${source.slice(node.init.start,node.init.end)};`);
 return [...constants,...SCHEDULER.map(name=>source.slice(functions[name][0].start,functions[name][0].end))].join('\n');
}

/**
 * Per version: `<version> <code>` intervals after 0..3 refreshes on desktop, `<version>
 * <code> mobile` the same on mobile, `rules <version>` (the compiled adUnitRules),
 * `summary <version>` (refreshSummary) and `sticky <version>`.
 */
export async function generatedIntervals(f,codes,versions=['3.16.1','3.16.2'],siteId='audit-site'){
 const saved=await readPreviewSnapshot(f.env.DB,siteId),out={};
 const units=Object.fromEntries(saved.units.map(u=>[u.code,u.type]));
 for(const version of versions){
  const runtime=runtimeCatalog.find(r=>r.version===version),input=previewInput(saved,runtime,'20261024_120000');
  const program=schedulerProgram(COMPILERS[version](input).adsJs,version);
  for(const code of codes)for(const mobile of [false,true])out[version+' '+code+(mobile?' mobile':'')]=[0,1,2,3].map(completed=>{
   // Page state the scheduler reads at run time; every constant comes from the script itself.
   const context=vm.createContext({getUnitConfigById:id=>({type:units[id]}),isMobile:()=>mobile,_refreshCounts:{[code]:completed}});
   vm.runInContext(program,context);
   return vm.runInContext(`getAdUnitRefreshRule(${JSON.stringify(code)}).minSeconds`,context);
  });
  out['rules '+version]=input.core.adUnitRules;
  out['summary '+version]=refreshSummary(input,saved.units,runtime,saved.rules);
  out['sticky '+version]=input.options.sticky.refreshSeconds;
 }
 return out;
}

/** Per version: the CMP wait each generated script uses (input maxCmpTimeout, Prebid consentManagement timeout and actionTimeout). */
export async function generatedCmpTimeouts(f,versions=['3.16.1','3.16.2'],siteId='audit-site'){
 const saved=await readPreviewSnapshot(f.env.DB,siteId),out={};
 for(const version of versions){
  const input=previewInput(saved,runtimeCatalog.find(r=>r.version===version),'20261024_120000'),source=COMPILERS[version](input).adsJs;
  const start=source.indexOf('var gdprConsentConfig =');assert(start>0,`${version} consent configuration`);
  const block=source.slice(start,source.indexOf('try{',start));
  out[version]={maxCmpTimeout:input.core.maxCmpTimeout,timeout:Number(block.match(/\btimeout:\s*(\d+)/)?.[1]),actionTimeout:Number(block.match(/actionTimeout:\s*(\d+)/)?.[1])};
 }
 return out;
}
