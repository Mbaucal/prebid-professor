/** Data-only editor validation; no execution, network or database access. */
import { WorkspaceError } from './boundary.mjs';
export const SUPPORTED_BIDDERS = Object.freeze(['adform','connectad','criteo','eskimi','ix','magnite','ogury','openx','pubmatic','richaudience','rtbhouse','smartadserver','teads']);
const blocked = new Set(['__proto__', 'constructor', 'prototype']);
const fail = (message) => { throw new WorkspaceError(422, message); };
export function fields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value))
      || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== keys.length
      || Object.keys(value).some((key) => !keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'))) fail(`Check ${label} fields.`);
}
function params(input) {
  let count = 0;
  const visit = (value, depth) => {
    if (++count > 1500 || depth > 8) fail('Bidder parameters are too complex.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
    if (!value || typeof value !== 'object') fail('Bidder parameters must contain JSON data only.');
    const array = Array.isArray(value);
    if (![array ? Array.prototype : Object.prototype, ...(array ? [] : [null])].includes(Object.getPrototypeOf(value))
        || Object.getOwnPropertySymbols(value).length) fail('Bidder parameters must be plain JSON.');
    const out = array ? [] : {};
    for (const key of Object.keys(value)) {
      if (blocked.has(key) || key.length > 128 || !Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value')
          || (array && !/^(0|[1-9][0-9]*)$/.test(key))) fail('Unsupported bidder parameter key.');
      out[key] = visit(value[key], depth+1);
    }
    if (array && Object.keys(value).length !== value.length) fail('Use a complete JSON array.');
    return out;
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Bidder parameters must be a JSON object, not a list or text.');
  const result = visit(input,0);
  if (new TextEncoder().encode(JSON.stringify(result)).length > 12000) fail('One parameter object must be no larger than 12 KB.');
  return result;
}
export function normalizePrebidDraft(input, units) {
  fields(input,['enablePrebid','buildId','bidders','overrides'],'Prebid settings');
  if (typeof input.enablePrebid !== 'boolean' || (input.buildId !== null && !/^test-pb-[a-f0-9]{64}$/.test(input.buildId))) fail('Choose a stored TEST build and an explicit Prebid mode.');
  if (!Array.isArray(input.bidders) || input.bidders.length > SUPPORTED_BIDDERS.length || !Array.isArray(input.overrides) || input.overrides.length > 200) fail('Too many bidder rows.');
  const names = new Set(), keys = new Set();
  const bidders = input.bidders.map((row) => {
    fields(row,['bidder','params','enabled'],'bidder');
    if (!SUPPORTED_BIDDERS.includes(row.bidder) || names.has(row.bidder) || typeof row.enabled !== 'boolean') fail('Choose each supported bidder once.');
    names.add(row.bidder);
    return {bidder:row.bidder, params:params(row.params), enabled:row.enabled};
  }).sort((a,b) => a.bidder < b.bidder ? -1 : 1);
  const overrides = input.overrides.map((row) => {
    fields(row,['bidder','scopeType','scopeKey','params','enabled'],'override');
    if (!names.has(row.bidder) || !['slot','device','adunit'].includes(row.scopeType) || typeof row.enabled !== 'boolean' || typeof row.scopeKey !== 'string') fail('Each override needs a configured bidder and a scope.');
    const allowed = row.scopeType === 'slot' ? ['ATF','BTF'] : row.scopeType === 'device' ? ['desktop','tablet','mobile'] : units.filter((u)=>!row.enabled||u.enabled===1).map((u)=>u.code);
    if (!allowed.includes(row.scopeKey)) fail('Choose a valid device, ATF/BTF type or enabled ad position for the override.');
    const key = [row.bidder,row.scopeType,row.scopeKey].join('|');
    if (keys.has(key)) fail('Only one override per bidder and scope is allowed.');
    keys.add(key);
    return {bidder:row.bidder,scopeType:row.scopeType,scopeKey:row.scopeKey,params:params(row.params),enabled:row.enabled};
  }).sort((a,b) => { const x=[a.bidder,a.scopeType,a.scopeKey].join('|'), y=[b.bidder,b.scopeType,b.scopeKey].join('|'); return x<y?-1:x>y?1:0; });
  if (input.enablePrebid) {
    if (!input.buildId || !bidders.some((b)=>b.enabled)) fail('Choose a Prebid file and enable at least one bidder.');
    for (const bidder of bidders.filter((b)=>b.enabled)) {
      if (!Object.keys(bidder.params).length && !overrides.some((o)=>o.enabled&&o.bidder===bidder.bidder&&Object.keys(o.params).length)) fail('Each enabled bidder needs partner parameters, either globally or in an override.');
    }
  }
  return {enablePrebid:input.enablePrebid,buildId:input.buildId,bidders,overrides};
}
