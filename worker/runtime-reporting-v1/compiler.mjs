import {parse} from 'acorn';
import {compilePositions} from '../runtime-next/compiler.mjs';
import {browserSources} from '../../.generated/runtime-reporting-browser-source.mjs';
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Reporting runtime insertion point changed: ' + before);
  return source.replace(before, () => after);
}
export function compileReporting(input) {
  const result = compilePositions(input);
  let source = result.adsJs;
  // Worker bundlers add name helpers/rename locals inside Function#toString.
  // Restore the inherited browser helpers from build-time source text, only in
  // this new runtime. The old compiler and its archived output stay untouched.
  const helpers=[];
  function restore(node){
    if(!node||typeof node!=='object')return;
    if(node.type==='FunctionDeclaration'&&browserSources[node.id?.name])helpers.push(node);
    for(const child of Object.values(node))if(Array.isArray(child))child.forEach(restore);else if(child&&typeof child==='object')restore(child);
  }
  restore(parse(source,{ecmaVersion:'latest'}));
  for(const node of helpers.sort((a,b)=>b.start-a.start))source=source.slice(0,node.start)+browserSources[node.id.name]+source.slice(node.end);
  const edits = [];
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed) {
      const {object, property} = node.callee;
      // Only replace the call prefix: callbacks can contain other instrumented calls.
      const end = node.arguments.length ? node.arguments[0].start : node.end - 1;
      if (object.type === 'Identifier' && object.name === 'pbjs' && property.name === 'requestBids') {
        edits.push({start: node.start, end, text: '_gamReporting.request(pbjs,'});
      } else if (property.name === 'refresh' && (object.type === 'Identifier' && object.name === 'pa' ||
          object.type === 'CallExpression' && source.slice(object.start, object.end) === 'googletag.pubads()')) {
        edits.push({start: node.start, end, text: `_gamReporting.dispatch(${source.slice(object.start, object.end)},`});
      }
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(walk); else if (child && typeof child === 'object') walk(child);
  }
  walk(parse(source, {ecmaVersion: 'latest'}));
  if (edits.length < 10) throw Error('Expected all owned GPT/Prebid request paths.');
  for (const edit of edits.sort((a,b) => b.start-a.start)) source = source.slice(0,edit.start)+edit.text+source.slice(edit.end);
  source = once(source, '  var _refreshCounts = {};', `  var _refreshCounts = {};
${browserSources.createGamReporting}
  var _gamReporting=createGamReporting({
    code:function(slot){return slot===_takeOverSlot&&TESSERA_OVERLAY?TESSERA_OVERLAY.code:slot.getSlotElementId();},
    owns:function(slot){return !!slot&&((window.adSlots&&window.adSlots[slot.getSlotElementId()]===slot)||slot===_takeOverSlot||slot===_takeOverCodelessGuardSlot);},
    prebid:function(slot){return HAS_PREBID&&slot!==_takeOverCodelessGuardSlot&&!(slot===_takeOverSlot&&(!TESSERA_OVERLAY||TESSERA_OVERLAY.demand!=='site'));}
  });`);
  source = once(source, '    _lastRefreshAt[id]=now(); _refreshCounts[id]=(_refreshCounts[id]||0)+1;',
    '    _gamReporting.plan(slot,effectiveMinGapSec);\n    _lastRefreshAt[id]=now(); _refreshCounts[id]=(_refreshCounts[id]||0)+1;');
  source = once(source, '          if (!allow.length) return; // sve blokirano',
    '          _gamReporting.discard(slots.filter(function(slot){return allow.indexOf(slot)<0;}));\n          if (!allow.length) return; // sve blokirano');
  source = once(source, '          return orig.call(pa, allow, opts);', '          return _gamReporting.send(orig,pa,allow,opts);');
  parse(source, {ecmaVersion:'latest'});
  return {...result, adsJs:source, adsMinJs:source, patches:[...result.patches, 'versioned per-request GAM refresh and current-auction reporting; GAM-only omits aq keys']};
}
