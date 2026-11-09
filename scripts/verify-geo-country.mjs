/** Verify the actual built Worker and the helper it emits. Local workerd only. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {Miniflare} from './local-miniflare.mjs';
const config=JSON.parse(await readFile('dist/prebid_professor/wrangler.json','utf8'));
const mf=new Miniflare({modules:true,script:await readFile('dist/prebid_professor/index.js','utf8'),
  compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,
  cf:false,host:'127.0.0.1',port:0,
  outboundService:()=>{throw Error('GEO verification forbids outbound traffic');}});
const origin='https://geo.example.invalid';
const records=[];
try {
  const call=(path,init={})=>mf.dispatchFetch(origin+path,{redirect:'manual',...init});
  for(const country of ['RS','DE','AT','XX','T1',null]) {
    const result=await call('/geo/v1/country',{cf:{country},headers:{'cf-ipcountry':'US'}});
    assert.equal(result.status,200);
    const body=await result.json();
    assert.equal(body.country,['XX','T1',null].includes(country)?null:country);
    assert.equal(result.headers.get('access-control-allow-origin'),'*');
    assert.match(result.headers.get('cache-control'),/no-store/);
    records.push({injectedTestCountry:country,result:body});
  }
  assert.equal((await call('/geo/v1/country',{method:'OPTIONS'})).status,204);
  assert.equal((await call('/geo/v1/country',{method:'POST',body:'RS'})).status,405);
  assert.equal((await call('/geo/v1/country?country=RS')).status,400);
  assert.equal((await call('/api/publishers/synthetic/builtin-site-settings')).status,401);
  const code=await (await call('/geo/v1/client.js')).text();
  let fetchCount=0;
  const root={performance,AbortController,setTimeout,clearTimeout,
    fetch:async(url,init)=>{fetchCount++;assert.equal(url,origin+'/geo/v1/country');assert.equal(init.credentials,'omit');return call('/geo/v1/country',{cf:{country:'RS'}});}};
  const context=vm.createContext({window:root,Promise,Object,JSON,Date});
  vm.runInContext(code,context);
  const pending=root.__AD_GEO.ready();
  vm.runInContext(code,context);
  assert.equal(root.__AD_GEO.ready(),pending);
  assert.equal((await pending).country,'RS');assert.equal(fetchCount,1);
  // A separate document gets a fresh lookup, not the previous visitor's value.
  const second={performance,AbortController,setTimeout,clearTimeout,fetch:()=>call('/geo/v1/country',{cf:{country:'DE'}})};
  vm.runInNewContext(code,{window:second,Promise,Object,JSON,Date});
  assert.equal((await second.__AD_GEO.ready()).country,'DE');
  await mkdir('.generated/geo-evidence',{recursive:true});
  await writeFile('.generated/geo-evidence/compiled-results.json',JSON.stringify({mode:'local workerd with synthetic cf metadata; no external requests',records,helperFetches:fetchCount,authBoundary:'401',result:'PASS'},null,2)+'\n');
  console.log('PASS: compiled Worker country isolation, no-store/CORS, public metadata/private settings, emitted helper and per-document lookup.');
} finally {await mf.dispose();}
