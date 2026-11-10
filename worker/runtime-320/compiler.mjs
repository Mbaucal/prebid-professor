import {parse} from 'acorn';
import {compileRuntime319} from '../runtime-319/compiler.mjs';
import {once} from '../runtime-3161/compiler.mjs';
import {browserSources} from '../../.generated/runtime-320-browser-source.mjs';
export {idempotentStickyStyles} from '../runtime-319/compiler.mjs';

function replaceFunction(source, name, replacement) {
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(parse(source, {ecmaVersion: 2015}));
  if (matches.length !== 1) throw Error('Viewport size maps expected one ' + name);
  const node = matches[0];
  return source.slice(0, node.start) + replacement + source.slice(node.end);
}
export function compileRuntime320(input) {
  const result = compileRuntime319(input);
  let source = result.adsJs;
  const replacements = ['sizesFromSizeMapName', 'sizesFromPrebidConfigName', 'getUnitConfigById', 'startATF', 'requestInitialSticky'];
  for (const name of replacements) source = replaceFunction(source, name, browserSources[name]);
  const helpers = Object.entries(browserSources).filter(([name]) => !replacements.includes(name)).map(([, value]) => value).join('\n');
  source = once(source, 'var AD_CONDITIONAL_UNITS=', `var AD_VIEWPORT_MAP_NAMES=${JSON.stringify(input.viewportMapNames).replace(/</g, '\\u003c')};\nvar AD_VIEWPORT_INITIAL_LISTENER=null;\n${helpers}\nvar AD_CONDITIONAL_UNITS=`);
  source = once(source, 'if(Object.keys(AD_CONDITIONAL_UNITS).length){', 'if(AD_VIEWPORT_MAP_NAMES.length){');
  source = once(source, 'return (b.viewport[0]-a.viewport[0]);', 'return b.viewport[0]-a.viewport[0] || b.viewport[1]-a.viewport[1];');
  source = once(source, 'function init(){', 'function init(){\n    adViewportInstallInitialResume();');
  source = once(source, 'STICKY_TARGET_ID && window.adSlots[STICKY_TARGET_ID] &&\n          y >= STICKY_LAZY_SCROLL_PX',
    'STICKY_TARGET_ID && window.adSlots[STICKY_TARGET_ID] && !_sticky.closed && slotHasCurrentViewportSizes(STICKY_TARGET_ID) &&\n          y >= STICKY_LAZY_SCROLL_PX');
  parse(source, {ecmaVersion: 2015});
  return {...result, adsJs: source, adsMinJs: source, patches: [...result.patches,
    '3.20.0: GPT, Prebid and reserved CSS use width-then-height viewport selection, including Sticky, conditional and page-type maps',
    '3.20.0: no matching breakpoint explicitly disables sizes; missing empty baseline is normalized without changing saved configuration',
    '3.20.0: never-requested ATF Banner and bottom Sticky can start after an eligible viewport change through existing consent/lazy gates; served or closed positions are not refreshed by resize']};
}
