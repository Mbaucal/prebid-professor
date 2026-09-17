"""Pinned real Prebid; synthetic bids/GPT only. No runtime activation or live ads."""
import hashlib, json, urllib.parse
from pathlib import Path
from playwright.sync_api import sync_playwright
bundle=Path('vendor/prebid/tanjug-11.34.0/prebid.js').read_bytes()
assert hashlib.sha256(bundle).hexdigest()=='384daae36c4fb334e16229d7f3e4b7a2c2caf9c0344580bdca7b185c756bb10b'
policy=Path('worker/runtime-cache/policy.mjs').read_text().replace('export function createBidCachePolicy','function createBidCachePolicy',1)
fixture=Path('tests/runtime/cache-browser-fixture.js').read_text()
checks=[];errors=[];external=[];adapter_calls=[]
def bid(cpm,ttl=300,**extra): return {'cpm':cpm,'ttl':ttl,**extra}
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    def fresh(mode='auction-with-cache',age=30):
        page=browser.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        def route(r):
            if not r.request.url.startswith('https://cache-fixture.invalid/bid?'):
                external.append(r.request.url);r.abort();return
            adapter_calls.append(1)
            rows=json.loads(urllib.parse.parse_qs(urllib.parse.urlparse(r.request.url).query)['payload'][0])
            rows=[{**x,'creativeId':'synthetic','currency':'USD','netRevenue':True,'ad':'<div>Synthetic cache test</div>','meta':{'advertiserDomains':['example.invalid']}} for x in rows if x.get('cpm',0)>0]
            r.fulfill(status=200,headers={'content-type':'application/json','access-control-allow-origin':'*'},body=json.dumps({'bids':rows}))
        page.route('**/*',route)
        page.set_content('<!doctype html><title>Prebid cache fixture</title>')
        page.add_script_tag(content=bundle.decode());page.add_script_tag(content=policy);page.add_script_tag(content=fixture)
        page.evaluate('([mode,age])=>setupCacheFixture(mode,age)',[mode,age]);return page
    def auction(page,a,b,code='P1'):
        before=len(adapter_calls)
        page.evaluate('([next,code])=>fixtureAuction(next,code)',[{'a':a,'b':b},code])
        assert len(adapter_calls)==before+2, 'Every auction calls both synthetic bidders'
    def seed(page,b=bid(4)):
        auction(page,bid(10),b)
        r=page.evaluate('fixtureTarget()');assert r['ok'] and r['cpm']==10 and r['status']=='targetingSet',r
        assert r['publisher']==['preserved'] and r['foreign']==[],r
        return r
    try:
        page=fresh();seed(page);auction(page,bid(2),bid(3));r=page.evaluate('fixtureTarget()')
        assert r['ok'] and r['cpm']==4 and r['snapshot']['lastSelection']['origin']=='cache',r
        assert not page.evaluate('fixtureTarget().ok')
        page.close();checks.append('Unused valid old bid beats lower new bids; bidders are still called; duplicate submission is blocked')
        page=fresh();seed(page);auction(page,bid(8),bid(3));r=page.evaluate('fixtureTarget()')
        assert r['ok'] and r['cpm']==8 and r['snapshot']['lastSelection']['origin']=='fresh',r
        page.close();checks.append('Better new bid wins; targeted old winner cannot be reused')
        page=fresh('fresh-only');seed(page);auction(page,bid(2),bid(3));r=page.evaluate('fixtureTarget()')
        assert r['ok'] and r['cpm']==3 and r['snapshot']['lastSelection']['origin']=='fresh',r
        page.close();checks.append('Fresh-only control never selects a prior-auction bid')
        page=fresh();seed(page,bid(4,ttl=2));page.wait_for_timeout(1200);auction(page,bid(2),bid(3));r=page.evaluate('fixtureTarget()')
        assert r['ok'] and r['cpm']==3,r
        page.close();checks.append('Native Prebid TTL buffer excludes expired cached offers')
        page=fresh(age=1);seed(page);page.wait_for_timeout(1100);auction(page,bid(2),bid(3));r=page.evaluate('fixtureTarget()')
        assert r['ok'] and r['cpm']==3 and r['snapshot']['checks']['rejected'].get('expired',0)>0,r
        page.close();checks.append('Policy maximum age is additional to, never an extension of bidder TTL')
        for change in ['fixtureState.epoch++','fixtureState.sizes=[[728,90]]']:
            page=fresh();seed(page);page.evaluate(change);auction(page,bid(2),bid(3));r=page.evaluate('fixtureTarget()')
            assert r['ok'] and r['cpm']==3,r
            page.close()
        checks.append('Consent/eligibility epoch and viewport-size changes invalidate older cached offers')
        page=fresh();seed(page);auction(page,bid(2),bid(3),'P2');r=page.evaluate("fixtureTarget('P2')")
        assert r['ok'] and r['cpm']==3,r
        page.close();checks.append('Cached offers stay with their own ad unit and owned GPT slot')
        page=fresh();seed(page)
        page.evaluate("{const b=pbjs.getBidResponsesForAdUnitCode('P1').bids.find(b=>b.cpm===4);pbjs.markWinningBidAsUsed({adId:b.adId});}")
        auction(page,bid(2),bid(3));r=page.evaluate('fixtureTarget()');assert r['ok'] and r['cpm']==3,r
        page.close();checks.append('Offers marked used through the public Prebid API cannot reenter targeting')
        page=fresh();seed(page,bid(4,dealId='fixture-deal'))
        assert page.evaluate("fixtureSlots.P1.getTargeting('hb_adid_cachefixtureb').length")==1
        auction(page,bid(2),bid(3));r=page.evaluate('fixtureTarget()');assert r['ok'] and r['cpm']==3,r
        page.close();checks.append('Secondary deal offers sent to GAM are excluded too, even when not the primary winner')
        page=fresh();auction(page,bid(0),bid(0));r=page.evaluate('fixtureTarget()')
        assert r['ok'] and r['cpm'] is None and r['snapshot']['selections']['none']==1,r
        page.close();checks.append('Empty cache/no-bid returns no Prebid targeting, not a fabricated ad')
        page=fresh();auction(page,bid(2),bid(3));page.evaluate('fixtureState.epoch++');r=page.evaluate('fixtureTarget()')
        assert not r['ok'] and r['cpm'] is None,r
        page.close();checks.append('Context changed during an auction blocks submission until a new eligible auction')
        assert not errors,errors
        assert not external,external
        checks.append('No external requests, no JavaScript errors, and no real GAM or SSP traffic')
    finally: browser.close()
out=Path('.generated/cache-evidence');out.mkdir(parents=True,exist_ok=True)
report={'scope':'Standalone policy + exact vendored Prebid 11.34.0; synthetic bids and GPT, not a released runtime','prebidSha256':hashlib.sha256(bundle).hexdigest(),'checks':checks,'passed':len(checks)}
(out/'browser.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
