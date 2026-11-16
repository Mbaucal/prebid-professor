import {parse} from 'acorn';
import {browserSources} from '../../.generated/runtime-3212-browser-source.mjs';

export const BOOT_HELPERS = ['tesseraTakeOverPending', 'resolveTakeOverCap', 'tesseraTakeOverDecision',
  'tesseraBootHoldServices', 'tesseraBootQueueDisplay', 'init', 'tesseraBootRelease'];

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(value => walk(value, visit));
    else if (child && typeof child === 'object' && typeof child.type === 'string') walk(child, visit);
  }
}
function only(list, label) {
  if (list.length !== 1) throw Error(`3.21.2 boot expected one ${label}, found ${list.length}`);
  return list[0];
}
/** Exact text anchor: a missing or repeated anchor fails generation. */
function once(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw Error(`3.21.2 boot expected one anchor, found ${count}: ${before.trim()}`);
  return source.replace(before, () => after);
}
function fn(source, name) {
  const found = [];
  walk(parse(source, {ecmaVersion: 2015}), node => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) found.push(node);
  });
  return only(found, 'function ' + name);
}
function browser(name) {
  if (typeof browserSources[name] !== 'string') throw Error('3.21.2 boot missing browser helper ' + name);
  return browserSources[name];
}
const calls = (node, name) => {
  let hit = false;
  walk(node, inner => {
    if (inner.type === 'CallExpression' && inner.callee.type === 'Identifier' && inner.callee.name === name) hit = true;
  });
  return hit;
};
const tryCalling = (node, name) => node?.type === 'TryStatement' && node.block.body.length === 1 && calls(node.block, name);
const isServicesGate = node => node.type === 'IfStatement' && node.test.type === 'UnaryExpression' &&
  node.test.operator === '!' && node.test.argument.type === 'MemberExpression' &&
  node.test.argument.object.name === 'window' && node.test.argument.property.name === '__ADS_GPT_SERVICES_ENABLED';
const isDisplayLoop = node => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' &&
  node.expression.callee.type === 'MemberExpression' && node.expression.callee.object.name === 'newlyDefinedSlots' &&
  node.expression.callee.property.name === 'forEach' && JSON.stringify(node).includes('"name":"display"');
const replaceNode = (source, node, text) => source.slice(0, node.start) + text + source.slice(node.end);

/** Locate the GPT start in defineAllSlots by syntax, not by whitespace. */
function bootStatements(source) {
  const define = fn(source, 'defineAllSlots');
  const blocks = [];
  walk(define, node => { if (node.type === 'BlockStatement' && node.body.some(isServicesGate)) blocks.push(node); });
  const body = only(blocks, 'GPT start block in defineAllSlots').body;
  const gate = only(body.map((node, index) => isServicesGate(node) ? index : -1).filter(index => index >= 0), 'services gate');
  const guardFirst = only(body.filter(node => tryCalling(node, 'takeOverEnsureCodelessGuard')), 'pre-enable guard');
  if (body.indexOf(guardFirst) !== 0) throw Error('3.21.2 boot expected the codeless guard first');
  const guardDisplay = body[gate + 1], sweep = body[gate + 2];
  if (!tryCalling(guardDisplay, 'takeOverDisplayCodelessGuard') || !tryCalling(sweep, 'takeOverScheduleCodelessSweep'))
    throw Error('3.21.2 boot expected guard display and sweep right after enableServices');
  const display = only(body.filter(isDisplayLoop), 'slot display loop');
  if (body.indexOf(display) <= gate + 2) throw Error('3.21.2 boot expected slot display after enableServices');
  return {guardFirst, gate: body[gate], guardDisplay, sweep, display};
}

/** 3.21.2 patch. Frequency 0 and pages without a TakeOver keep the exact 3.21.1 program. */
export function applyBootAtLoad(source, input) {
  if (!input.overlay || !(Number(input.overlay.frequencyMinutes) > 0)) return source;
  const s = bootStatements(source), text = node => source.slice(node.start, node.end);
  // The held start replays the original 3.21.1 statements verbatim.
  const held = `function tesseraBootEnableHeldServices(){
    if (!_tesseraBootHeld) return;
    _tesseraBootHeld = false;
    var newlyDefinedSlots = _tesseraBootPendingDisplay.filter(function(slot){
      var id = slot && slot.getSlotElementId && slot.getSlotElementId();
      return !!id && !!window.adSlots && window.adSlots[id] === slot;
    });
    _tesseraBootPendingDisplay = [];
    ${text(s.guardFirst)}
    ${text(s.gate)}
    ${text(s.guardDisplay)}
    ${text(s.sweep)}
    ${text(s.display)}
  }`;
  // Two edits inside defineAllSlots, applied back to front so offsets stay valid.
  source = source.slice(0, s.display.start) +
    `if (_tesseraHold) tesseraBootQueueDisplay(newlyDefinedSlots); else ${text(s.display)}` + source.slice(s.display.end);
  source = source.slice(0, s.gate.start) +
    `var _tesseraHold = tesseraBootHoldServices();\n    if (!_tesseraHold) {\n    ${source.slice(s.gate.start, s.sweep.end)}\n    }` +
    source.slice(s.sweep.end);
  // STO-3: an eligible TakeOver with an interval is unknown, not inactive, until the decision.
  // The link-block gate stays !TAKEOVER_ACTIVE_FOR_PAGE: nothing is blocked while undecided.
  source = once(source,
    '  var TAKEOVER_ACTIVE_FOR_PAGE = _tesseraTakeOverEligible && !TESSERA_OVERLAY.frequencyMinutes;',
    '  var TAKEOVER_ACTIVE_FOR_PAGE = _tesseraTakeOverEligible ? (TESSERA_OVERLAY.frequencyMinutes ? null : true) : false;');
  source = once(source, "    status: TAKEOVER_ACTIVE_FOR_PAGE ? 'waiting' : 'inactive',",
    "    status: TAKEOVER_ACTIVE_FOR_PAGE ? 'waiting' : TAKEOVER_ACTIVE_FOR_PAGE === null ? 'waiting-consent' : 'inactive',");
  // Defer only the initial start (viewability, ATF scan, resolveConsent) of a pending page.
  const start = only(fn(source, 'initAfterTakeOverCap').body.body.filter(node =>
    node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' &&
    node.expression.callee.name === 'startAfterGptAndConsent'), 'initial start call');
  source = replaceNode(source, start, 'if (!_tesseraBootStartDeferred) startAfterGptAndConsent();');
  for (const name of ['resolveTakeOverCap', 'init']) source = replaceNode(source, fn(source, name), browser(name));
  source = once(source, '  var _tesseraTakeOverBootWaiting=false;\n',
    '  var _tesseraTakeOverBootWaiting=false;\n  var _tesseraBootHeld=false, _tesseraBootPendingDisplay=[], _tesseraBootStartDeferred=false;\n' +
    ['tesseraTakeOverPending', 'tesseraTakeOverDecision', 'tesseraBootHoldServices', 'tesseraBootQueueDisplay', 'tesseraBootRelease']
      .map(browser).join('\n') + '\n' + held + '\n');
  // First readiness waiter: registered before adGeoStart() and init().
  source = once(source, '  window.__tesseraReadiness={snapshot:_tesseraReady.snapshot};',
    '  window.__tesseraReadiness={snapshot:_tesseraReady.snapshot};\n  _tesseraReady.whenConsent(tesseraBootRelease);');
  parse(source, {ecmaVersion: 2015});
  return source;
}
