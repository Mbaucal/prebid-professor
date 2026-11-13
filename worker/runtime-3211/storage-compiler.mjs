import {parse} from 'acorn';
import {once} from '../runtime-3161/compiler.mjs';
import * as browser from './browser-storage.mjs';

function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of Object.values(node)) {
    if (Array.isArray(child)) child.forEach(value => walk(value, visit));
    else if (child && typeof child === 'object') walk(child, visit);
  }
}
function replaceFunction(source, name, replacement) {
  const matches = [];
  walk(parse(source, {ecmaVersion: 2015}), node => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node);
  });
  if (matches.length !== 1) throw Error('3.21.1 storage expected one ' + name);
  const node = matches[0];
  return source.slice(0, node.start) + replacement + source.slice(node.end);
}

/** Patch the newly generated program, never any sealed historical source. */
export function applyStoragePrivacy(source, input) {
  // Debug opt-in is URL/page-memory only. Replace the complete native storage
  // calls, so even a throwing localStorage getter is never touched.
  const debugCalls = [];
  walk(parse(source, {ecmaVersion: 2015}), node => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.object.name === 'localStorage' &&
        ['getItem', 'setItem', 'removeItem'].includes(node.callee.property.name) &&
        node.arguments[0]?.value === 'ADOPS_DEBUG') debugCalls.push(node);
  });
  if (debugCalls.length !== 3) throw Error('3.21.1 expected the three ADOPS_DEBUG storage calls');
  for (const node of debugCalls.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, node.start) + 'void 0' + source.slice(node.end);
  }
  if (input.overlay) {
    source = once(source,
      '  var TAKEOVER_ACTIVE_FOR_PAGE = takeOverIsActiveForPage() && tesseraOverlayAllowed();',
      '  var _tesseraTakeOverEligible=takeOverIsActiveForPage() && !!tesseraOverlayDevice();\n  var TAKEOVER_ACTIVE_FOR_PAGE = _tesseraTakeOverEligible && !TESSERA_OVERLAY.frequencyMinutes;');
    source = once(source, '  var _tesseraReady=createTesseraReadiness(window,{',
      `${browser.createConsentStorage.toString()}\n  var _adStorage=createConsentStorage(window);\n  var _tesseraTakeOverWaiting=false;\n  var _tesseraReady=createTesseraReadiness(window,{\n    storageConsent:_adStorage.update,`);
    source = once(source,
      '    consent = {ready:!!ready, phase:phase, epoch:consent.epoch + (changed ? 1 : 0)};',
      '    consent = {ready:!!ready, phase:phase, epoch:consent.epoch + (changed ? 1 : 0)};\n    if(options.storageConsent)options.storageConsent(data,success,!!ready);');
    source = replaceFunction(source, 'tesseraOverlayAllowed', browser.tesseraOverlayAllowed.toString());
    source = replaceFunction(source, 'tesseraRecordOverlayView', browser.tesseraRecordOverlayView.toString());
    source = once(source, '  function initTakeOver(){',
      browser.initTakeOver.toString() + '\n  function initTakeOverReady(){');
  }
  parse(source, {ecmaVersion: 2015});
  return source;
}
