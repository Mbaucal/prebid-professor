import {parse} from 'acorn';
import {normalizeBidderAccounts, normalizeBidderAccount} from './settings.mjs';
const literal = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function once(source, before, after) {
  if (source.split(before).length !== 2) throw Error('Bidder-account insertion point changed: ' + before);
  return source.replace(before, () => after);
}
function visit(node, callback) {
  if (!node || typeof node !== 'object') return;
  callback(node);
  for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(child => visit(child, callback)); else if (value && typeof value === 'object') visit(value, callback);
}
function siteChain(input) {
  const value = input.options?.schain;
  if (!value || value.enabled === false) return null;
  const config = value.config || value;
  return config.nodes?.length ? {ver: config.ver || config.version || '1.0', complete: config.complete, nodes: config.nodes, ...(config.ext ? {ext: config.ext} : {})} : null;
}
/** Browser text must be sliced from the repository source by runtime preparation. */
export function applyBidderAccounts(source, input, browserSource) {
  const accounts = normalizeBidderAccounts(input.bidderAccounts);
  if (!input.options?.enablePrebid || !accounts.some(account => account.baseAdapter !== account.bidder || account.schain.mode !== 'inherit')) return source;
  const known = new Set(accounts.map(account => account.bidder));
  // Legacy enabled bidders that have no account metadata still inherit the site.
  for (const bid of input.core?.bidders || []) if (!known.has(bid.bidder)) {
    accounts.push(normalizeBidderAccount({}, {bidder: bid.bidder})); known.add(bid.bidder);
  }
  if (typeof browserSource !== 'string' || !browserSource.startsWith('function createBidderAccounts(')) throw Error('Missing canonical bidder-account browser source.');
  source = once(source, "if(bid.bidder!=='pubmatic')return bid;", "if((" + literal(Object.fromEntries(accounts.map(account => [account.bidder, account.baseAdapter]))) + "[bid.bidder]||bid.bidder)!=='pubmatic')return bid;");
  source = once(source, "return e.bidder==='pubmatic';", "return e.bidder===bid.bidder;");
  const adapterForRoute = '(' + literal(Object.fromEntries(accounts.map(account => [account.bidder, account.baseAdapter]))) + '[route.bidder]||route.bidder)';
  source = once(source, "['teads', 'richaudience'].indexOf(route.bidder)", "['teads', 'richaudience'].indexOf(" + adapterForRoute + ')');
  source = once(source, "(route.bidder === 'rubicon' || route.bidder === 'magnite')", '(' + adapterForRoute + " === 'rubicon' || " + adapterForRoute + " === 'magnite')");
  const ast = parse(source, {ecmaVersion: 2015}), configs = [];
  visit(ast, node => {
    if (node.type !== 'FunctionDeclaration' || node.id?.name !== 'configurePrebidReady') return;
    visit(node.body, child => {
      if (child.type === 'CallExpression' && child.callee.type === 'MemberExpression' && child.callee.object.name === 'pbjs' && child.callee.property.name === 'setConfig' && child.arguments[0]?.type === 'ObjectExpression') {
        const config = child.arguments[0];
        if (config.properties.some(property => property.key?.name === 'floors')) configs.push(config);
      }
    });
  });
  if (configs.length !== 1) throw Error('Bidder-account global configuration boundary changed.');
  const config = configs[0], properties = config.properties.filter(property => property.key?.name === 'ortb2');
  if (properties.length > 1) throw Error('Duplicate wrapper OpenRTB configuration.');
  if (properties.length) {
    const node = properties[0], index = config.properties.indexOf(node);
    // This wrapper property contains only its site upstream chain. Preserve
    // external global FPD by omitting the property rather than writing {}.
    const value = node.value;
    if (value.type !== 'ObjectExpression' || value.properties.length !== 1 || value.properties[0].key?.name !== 'source') throw Error('Wrapper OpenRTB now contains additional data; review account compiler.');
    const sourceNode = value.properties[0].value;
    if (sourceNode.type !== 'ObjectExpression' || sourceNode.properties.length !== 1 || sourceNode.properties[0].key?.name !== 'schain') throw Error('Wrapper source now contains additional data; review account compiler.');
    const start = index === config.properties.length - 1 ? config.properties[index - 1].end : node.start;
    const end = index === config.properties.length - 1 ? node.end : config.properties[index + 1].start;
    source = source.slice(0, start) + source.slice(end);
  }
  const raw = [];
  visit(parse(source, {ecmaVersion: 2015}), node => {
    if (node.type === 'VariableDeclarator' && node.id?.name === '_tesseraReady') {
      const properties = node.init?.arguments?.[1]?.properties || [];
      for (const property of properties) if (property.key?.name === 'rawRequest') raw.push(property.value);
    }
  });
  if (raw.length !== 1) throw Error('Bidder-account request boundary changed.');
  const request = source.slice(raw[0].start, raw[0].end);
  source = source.slice(0, raw[0].start) + '_adBidderAccounts.request' + source.slice(raw[0].end);
  source = once(source, '  var _tesseraReady=createTesseraReadiness(window,{', `${browserSource}\n  var _adBidderAccounts=createBidderAccounts(window,${literal(accounts)},${literal(siteChain(input))},{request:${request}});\n  var _tesseraReady=createTesseraReadiness(window,{`);
  source = once(source, '    if(_tesseraConfiguredPb===pbjs)return;', '    if(_tesseraConfiguredPb===pbjs)return;\n    _adBidderAccounts.preparePrebid(pbjs);');
  source = once(source, '    _adContext.configurePrebid(pbjs);', '    _adBidderAccounts.configurePrebid(pbjs);\n    _adContext.configurePrebid(pbjs);');
  parse(source, {ecmaVersion: 2015});
  return source;
}
