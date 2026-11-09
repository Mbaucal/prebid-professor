import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {countryResponse} from '../../worker/geo-country.mjs';
import {createCountrySignal, normalizeCountry, countryClientSource} from '../../shared/geo-country.mjs';

const endpoint = 'https://geo.example.invalid/geo/v1/country';
function request(country, options = {}) {
  const r = new Request(endpoint, options);
  if (country !== undefined) Object.defineProperty(r, 'cf', {value:{country, city:'private', latitude:'private'}});
  return r;
}
const payload = country => ({version:1, status:country ? 'known' : 'unknown', country, source:'cloudflare'});
const response = country => Response.json(payload(country));
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(fetch, extras = {}) {
  let time = 0; const timers = new Map(); let id = 0;
  const calls = [];
  const root = {performance:{now:() => time}, AbortController,
    setTimeout(fn, ms) { timers.set(++id, {fn, at:time+ms}); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(...args) { calls.push(args); return fetch(...args); }, ...extras};
  const api = createCountrySignal({root, endpoint, normalizeCountry});
  return {root, api, calls, timers,
    advance(ms) { time += ms; for (const [id,t] of timers) if (t.at <= time) {timers.delete(id); t.fn();} },
    setTime(value) {time = value;}};
}

test('edge country only; different visitors do not share server state', async () => {
  for (const code of ['RS','DE','AT','US','XK']) {
    const r = countryResponse(request(code, {headers:{'cf-ipcountry':'GB','x-country':'FR'}}));
    assert.deepEqual(await r.json(), payload(code));
    assert.equal(r.headers.get('set-cookie'), null);
    for (const key of ['cache-control','cdn-cache-control','cloudflare-cdn-cache-control']) assert.match(r.headers.get(key), /no-store/);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('access-control-allow-credentials'), null);
  }
});

test('unknown and special codes never become a guessed country', async () => {
  for (const value of [undefined,null,'','XX','T1','ZZ','EU','rs',' RS ','USA',123,{}]) {
    assert.deepEqual(await countryResponse(request(value, {headers:{'cf-ipcountry':'RS','accept-language':'sr'}})).json(), payload(null));
  }
});

test('GET/HEAD/OPTIONS only, no query overrides, unrelated paths fall through', async () => {
  assert.equal(countryResponse(new Request('https://geo.example.invalid/other')), null);
  const head = countryResponse(request('RS',{method:'HEAD'}));
  assert.equal(head.status,200); assert.equal(await head.text(),'');
  const options = countryResponse(request('RS',{method:'OPTIONS'}));
  assert.equal(options.status,204); assert.equal(await options.text(),'');
  const post = countryResponse(request('RS',{method:'POST',body:'country=DE'}));
  assert.equal(post.status,405); assert.equal(post.headers.get('allow'),'GET, HEAD, OPTIONS');
  const query = countryResponse(new Request(endpoint+'?country=DE'));
  assert.equal(query.status,400); assert.match(query.headers.get('cache-control'),/no-store/);
});

test('many consumers share one lookup and immutable terminal result', async () => {
  const h = harness(() => response('RS'));
  assert.equal(h.api.getSnapshot().status,'idle');
  const promises = Array.from({length:20}, () => h.api.ready());
  assert(promises.every(p => p === promises[0]));
  assert.equal(h.api.getSnapshot().status,'pending');
  const values = await Promise.all(promises);
  assert(values.every(v => v === values[0]));
  assert.equal(values[0].country,'RS'); assert.equal(values[0].source,'cloudflare');
  assert(Object.isFrozen(values[0])); assert(Object.isFrozen(h.api));
  assert.equal(h.calls.length,1); assert.equal(h.timers.size,0);
  assert.equal(h.calls[0][0],endpoint);
  assert.deepEqual(Object.fromEntries(Object.entries(h.calls[0][1]).filter(([k])=>k!=='signal')),
    {method:'GET',mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
});

test('deadline covers a hanging fetch and late success cannot replace unknown', async () => {
  let deliver; const h = harness(() => new Promise(resolve => {deliver=resolve;}));
  const p = h.api.ready(); h.advance(1500);
  assert.equal((await p).reason,'timeout'); assert.equal(h.calls[0][1].signal.aborted,true);
  deliver(response('DE')); await tick();
  assert.equal(h.api.getSnapshot().country,null); assert.equal(h.api.ready(),p);
  assert.equal(h.calls.length,1); assert.equal(h.timers.size,0);
});

test('deadline also covers response body; timer scheduling delay cannot accept stale data', async () => {
  let deliver;
  const h = harness(() => ({ok:true,headers:new Headers({'content-type':'application/json'}),text:()=>new Promise(resolve=>{deliver=resolve;})}));
  const p = h.api.ready(); await tick(); h.advance(1500); assert.equal((await p).reason,'timeout');
  deliver(JSON.stringify(payload('AT'))); await tick(); assert.equal(h.api.getSnapshot().country,null);
  const delayed = harness(() => ({ok:true,headers:new Headers({'content-type':'application/json'}),text:async()=>{delayed.setTime(1600);return JSON.stringify(payload('RS'));}}));
  assert.equal((await delayed.api.ready()).reason,'timeout');
});

test('network failure, sync throw, unavailable fetch and missing AbortController all settle', async () => {
  for (const f of [()=>Promise.reject(Error('offline')),()=>{throw Error('blocked');}]) {
    const h = harness(f); assert.equal((await h.api.ready()).reason,'network-error'); assert.equal(h.timers.size,0);
  }
  const missing = harness(null,{fetch:undefined}); assert.equal((await missing.api.ready()).reason,'unsupported');
  const noAbort = harness(()=>new Promise(()=>{}),{AbortController:undefined});
  const p=noAbort.api.ready(); noAbort.advance(1500); assert.equal((await p).reason,'timeout');
});

test('HTTP errors and malformed/oversized data resolve unknown without retrying', async () => {
  const invalid = [new Response('no',{status:503}),new Response('<html>login</html>',{headers:{'content-type':'text/html'}}),
    new Response('{',{headers:{'content-type':'application/json'}}),Response.json({...payload('RS'),version:2}),
    Response.json({...payload('RS'),source:'header'}),Response.json({...payload('RS'),country:'XX'}),
    Response.json({...payload('RS'),status:'unknown'}),Response.json({...payload(null),status:'known'}),
    Response.json(null),Response.json({...payload('RS'),extra:'x'.repeat(3000)})];
  for(const r of invalid) {const h=harness(()=>r);const v=await h.api.ready();assert.equal(v.status,'unknown');assert.equal(v.country,null);assert.equal(h.calls.length,1);assert.equal(h.timers.size,0);}
  const h=harness(()=>response(null)); assert.equal((await h.api.ready()).reason,'unavailable');
});

test('reentrant fetch consumers still receive the same promise', async () => {
  let again; const h=harness(()=>{again=h.api.ready();return response('RS');});
  const first=h.api.ready();assert.equal(first,again);assert.equal((await first).country,'RS');
});

test('emitted helper is opt-in, duplicate-safe and touches no consent, ads or storage', async () => {
  const h=harness(()=>response('DE'));
  const root=h.root;
  for(const key of ['localStorage','sessionStorage','document','navigator','pbjs','googletag','__tcfapi']) {
    Object.defineProperty(root,key,{get(){throw Error('Forbidden access: '+key);}});
  }
  const source=countryClientSource(endpoint);
  const context=vm.createContext({window:root,Promise,Object,Date,JSON});
  vm.runInContext(source,context);const api=root.__AD_GEO;
  vm.runInContext(source,context);
  assert.equal(root.__AD_GEO,api); assert.equal(h.calls.length,1);
  assert.equal((await api.ready()).country,'DE');
  const occupied={__AD_GEO:{owner:'other'}};
  vm.runInNewContext(source,{window:occupied});assert.equal(occupied.__AD_GEO.owner,'other');
});

test('client route contains no per-visitor country or private metadata', async () => {
  const r=new Request('https://geo.example.invalid/geo/v1/client.js');
  Object.defineProperty(r,'cf',{value:{country:'RS',city:'SECRET_CITY'}});
  const out=countryResponse(r);assert.match(out.headers.get('content-type'),/javascript/);
  const text=await out.text();assert(!text.includes('SECRET_CITY'));assert(text.includes(endpoint));
});
