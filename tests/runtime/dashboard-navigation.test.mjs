import test from 'node:test';
import assert from 'node:assert/strict';
import {readDashboardNavigation,resolveDashboardNavigation,dashboardURL,canonicalDashboardURL} from '../../src/dashboard-navigation.ts';

const publishers=[{id:'publisher-a',sites:[{id:'site-a1'},{id:'site-a2'}]},{id:'publisher-b',sites:[{id:'site-b1'}]},{id:'empty',sites:[]}];
const organization={agencies:[{id:'north'},{id:'south'}],memberships:[{publisherId:'publisher-a',agencyId:'north'},{publisherId:'publisher-b',agencyId:'south'}]};
const resolve=(query,accounts=publishers,org=organization)=>resolveDashboardNavigation(readDashboardNavigation(query),accounts,org);

test('only an initial URL without dashboard parameters chooses a default site',()=>{
  assert.equal(resolve('').site.id,'site-a1');
  assert.equal(resolve('?campaign=unrelated').site.id,'site-a1');
  assert.equal(resolve('?section=publishers&tab=overview').site,null);
  assert.equal(resolve('?publisher=empty').publisher.id,'empty');
  assert.equal(resolve('?publisher=empty').site,null);
  assert.equal(resolve('',[]).error,null);
});
test('a deep link resolves its real hierarchy identity and survives canonical serialization',()=>{
  const selected=resolve('?site=site-a2&tab=config');
  assert.equal(selected.error,null);assert.equal(selected.publisher.id,'publisher-a');assert.equal(selected.site.id,'site-a2');
  const url=dashboardURL('https://tessera.invalid/?campaign=keep#anchor',selected.navigation);
  assert.equal(url,'/?campaign=keep&section=publishers&publisher=publisher-a&site=site-a2&tab=config#anchor');
  assert.equal(resolve(new URL(url,'https://tessera.invalid').search).site.id,'site-a2');
  assert.equal(resolve(new URL(url,'https://tessera.invalid').search).navigation.tab,'Config');
});
test('unknown, deleted and mismatched identities cannot fall back to the first site',()=>{
  for(const query of ['?site=deleted&tab=config','?publisher=deleted','?publisher=publisher-b&site=site-a2','?tab=config']){
    const state=resolve(query);assert(state.error,query);assert.equal(state.site,null);assert.equal(state.publisher,null);
  }
  const reduced=publishers.map(p=>({...p,sites:p.sites.filter(s=>s.id!=='site-a2')}));
  assert.equal(resolve('?site=site-a2',reduced).site,null);
  assert.match(resolve('?site=site-a2',reduced).error,/no longer available/);
});
test('malformed or ambiguous parameters are rejected without activating a workspace',()=>{
  for(const query of ['?site=','?site=site-a1&site=site-a2','?section=unknown','?tab=unknown','?agency=','?site=%20','?publisher='+ 'x'.repeat(129)]){
    const state=resolve(query);assert.match(state.error,/invalid/,query);assert.equal(state.site,null);
  }
});
test('agency links validate both existence and membership, without choosing another site',()=>{
  assert.equal(resolve('?site=site-a2&agency=north').site.id,'site-a2');
  for(const query of ['?site=site-a2&agency=south','?site=site-a2&agency=none','?agency=deleted']){
    const state=resolve(query);assert(state.error,query);assert.equal(state.site,null);
  }
  assert.equal(resolve('?agency=south').site,null);
  assert.equal(resolve('?publisher=empty&agency=none').publisher.id,'empty');
});
test('global sections keep their site context and URL writer preserves direct entry paths',()=>{
  const state=resolve('?section=releases&site=site-a2&tab=config&agency=north');
  assert.equal(state.navigation.section,'Releases');assert.equal(state.site.id,'site-a2');
  const url=dashboardURL('https://tessera.invalid/dashboard?next=keep#anchor',state.navigation);
  assert(url.startsWith('/dashboard?next=keep&section=releases&'));assert(url.endsWith('&agency=north#anchor'));
  assert.equal(resolve(new URL(url,'https://tessera.invalid').search).navigation.tab,'Config');
});
test('canonicalization cannot overwrite a newer browser URL with a stale render',()=>{
  const settingsQuery='?campaign=keep&section=settings&publisher=publisher-a&site=site-a2&tab=config';
  const settings=readDashboardNavigation(settingsQuery);
  const backURL='https://tessera.invalid/?campaign=keep&section=publishers&publisher=publisher-a&site=site-a2&tab=config#anchor';
  const staleSelection=resolveDashboardNavigation(settings,publishers,organization);
  // The previous mismatch-only check would have replaced Back's Config URL with Settings.
  assert.equal(dashboardURL(backURL,staleSelection.navigation),'/' + settingsQuery + '#anchor');
  assert.equal(canonicalDashboardURL(backURL,settings,staleSelection.navigation),null);
  const incomplete='https://tessera.invalid/?site=site-a2&tab=config#anchor';
  const restored=readDashboardNavigation(new URL(incomplete).search);
  const selected=resolveDashboardNavigation(restored,publishers,organization);
  assert.equal(canonicalDashboardURL(incomplete,restored,selected.navigation),'/?section=publishers&publisher=publisher-a&site=site-a2&tab=config#anchor');
  assert.equal(canonicalDashboardURL(backURL,readDashboardNavigation(new URL(backURL).search),selected.navigation),null);
});
