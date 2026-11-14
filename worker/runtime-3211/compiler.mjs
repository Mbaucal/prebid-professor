import {parse} from 'acorn';
import {compileRuntime321} from '../runtime-321/compiler.mjs';
import {browserSources} from '../../.generated/runtime-3211-browser-source.mjs';
import {applyStoragePrivacy} from './storage-compiler.mjs';
export {idempotentStickyStyles} from '../runtime-321/compiler.mjs';

export function replaceRuntimeFunction(source, name, replacement) {
  const matches = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) matches.push(node);
    for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') visit(value);
  }
  visit(parse(source, {ecmaVersion: 2015}));
  if (matches.length !== 1 || typeof replacement !== 'string') throw Error('3.21.1 expected one browser function: ' + name);
  const node = matches[0];
  return source.slice(0, node.start) + replacement + source.slice(node.end);
}

/** Patch only newly generated 3.21.1 output; previous runtime sources stay sealed. */
export function compileRuntime3211(input) {
  const previous = compileRuntime321(input);
  let source = replaceRuntimeFunction(previous.adsJs, 'adConditionalConfig', browserSources.adConditionalConfig);
  source = replaceRuntimeFunction(source, 'createContextualSignals', browserSources.createContextualSignals);
  source = applyStoragePrivacy(source, input);
  parse(source, {ecmaVersion: 2015});
  const exclusions = (input.conditionalRuleExclusions || []).map(item => `${item.code}: ${item.scopes.join(', ')} conditional rules apply only to Banner and Sticky; ${item.format} keeps its saved map and serving behavior.`);
  return {...previous, adsJs: source, adsMinJs: source, warnings: [...previous.warnings, ...exclusions], patches: [...previous.patches,
    '3.21.1: preserve selected page/category GPT and Prebid size maps when no conditional map override matches',
    '3.21.1: Default and group conditional rules apply to Banner and Sticky; excluded formats are explicitly reported',
    '3.21.1: preserve native RTD ownership and diagnose unactivated providers and missing modules',
    '3.21.1: defer TakeOver cap storage to current CMP permission and remove debug localStorage access']};
}
