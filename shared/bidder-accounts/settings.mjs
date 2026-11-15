const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw Object.assign(new Error(message), {status: 422}); };
const unsafe = new Set(['__proto__', 'prototype', 'constructor']);
function keys(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`${label}: use the displayed fields only.`);
}
function text(value, label, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(`${label}: enter a non-empty value of at most ${max} characters.`);
  return value.trim();
}
function code(value, label) {
  const result = text(value, label, 64);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(result) || unsafe.has(result)) fail(`${label}: use a lower-case Prebid code starting with a letter.`);
  return result;
}
function jsonExtension(value, label, depth = 0) {
  if (depth > 12) fail(`${label}: nested data is too deep.`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => jsonExtension(item, label, depth + 1));
  if (!record(value) || Object.keys(value).some(key => unsafe.has(key))) fail(`${label}: use JSON data without reserved object keys.`);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonExtension(item, label, depth + 1)]));
}
export function normalizeAccountSchain(value) {
  keys(value, ['ver', 'complete', 'nodes', 'ext'], 'Custom SChain');
  if (value.ver !== '1.0') fail('Custom SChain: supported version is 1.0.');
  if (value.complete !== 0 && value.complete !== 1) fail('Custom SChain: complete must be 0 or 1.');
  if (!Array.isArray(value.nodes) || !value.nodes.length || value.nodes.length > 50) fail('Custom SChain: add between 1 and 50 ordered nodes.');
  const nodes = value.nodes.map((node, index) => {
    const label = `SChain node ${index + 1}`;
    keys(node, ['asi', 'sid', 'hp', 'rid', 'name', 'domain', 'ext'], label);
    const asi = text(node.asi, `${label} ASI`).toLowerCase();
    if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(asi)) fail(`${label}: ASI must be an advertising-system domain without a URL path.`);
    const sid = text(node.sid, `${label} SID`);
    if (node.hp !== 1) fail(`${label}: SChain 1.0 requires HP 1 for every payment node.`);
    const result = {asi, sid, hp: node.hp};
    for (const key of ['rid', 'name', 'domain']) if (own(node, key) && node[key] !== '') result[key] = text(node[key], `${label} ${key}`);
    if (result.domain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(result.domain)) fail(`${label}: domain must be a canonical business domain without a URL path.`);
    if (own(node, 'ext')) { if (!record(node.ext)) fail(`${label}: ext must be a JSON object.`); result.ext = jsonExtension(node.ext, label); }
    return result;
  });
  const result = {ver: '1.0', complete: value.complete, nodes};
  if (own(value, 'ext')) { if (!record(value.ext)) fail('Custom SChain: ext must be a JSON object.'); result.ext = jsonExtension(value.ext, 'Custom SChain'); }
  return result;
}

/** Persisted account metadata is independent from the exact auction bidder code. */
export function normalizeBidderAccount(value = {}, context = {}) {
  keys(value, ['bidder', 'baseAdapter', 'displayName', 'schain'], 'Bidder account');
  const bidder = code(context.bidder ?? value.bidder, 'Bidder code');
  if (value.bidder !== undefined && value.bidder !== bidder) fail('Bidder account identity does not match its saved bidder code.');
  const baseAdapter = code(value.baseAdapter || bidder, 'Base adapter');
  const displayName = value.displayName == null || value.displayName === '' ? '' : text(value.displayName, 'Account name', 100);
  const settings = value.schain ?? {mode: 'inherit'};
  keys(settings, ['mode', 'config'], 'Account SChain');
  if (!['inherit', 'custom', 'none'].includes(settings.mode)) fail('Choose site SChain, custom SChain or no upstream SChain.');
  const schain = {mode: settings.mode};
  // Preserve an operator's custom values while switching modes; only custom is emitted.
  if (own(settings, 'config')) schain.config = normalizeAccountSchain(settings.config);
  if (settings.mode === 'custom' && !schain.config) fail(`${bidder}: add the custom SChain nodes.`);
  return {bidder, baseAdapter, displayName, schain};
}

export function normalizeBidderAccounts(value = []) {
  if (!Array.isArray(value) || value.length > 500) fail('Bidder accounts: use at most 500 accounts.');
  const seen = new Set();
  const result = value.map(item => {
    const account = normalizeBidderAccount(item);
    if (seen.has(account.bidder)) fail(`Bidder account ${account.bidder} is duplicated.`);
    seen.add(account.bidder);
    return account;
  });
  const aliases = new Set(result.filter(item => item.bidder !== item.baseAdapter).map(item => item.bidder));
  for (const account of result) if (aliases.has(account.baseAdapter)) fail(`${account.bidder}: choose the original base adapter, not another account alias.`);
  return result;
}
