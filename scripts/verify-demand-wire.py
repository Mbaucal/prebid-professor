"""CI: full pinned Prebid build, unmodified SSP adapters, intercepted requests.
All responses are synthetic empty auctions. No SSP, ID5 or GAM traffic leaves
the browser. This proves client serialization, not server acceptance or uplift.
"""
import gzip, hashlib, json, os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent
out=root/'.generated/demand-evidence'
pb_path=Path(os.environ['PREBID_WIRE_BUILD'])
prebid=pb_path.read_text()
mock=(root/'tests/runtime/mock-ad-libraries.js').read_text()
a=mock.index('  window.pbjs = {');b=mock.index('  window.__tcfapi =',a)
mock=mock[:a]+mock[b:]
html='<!doctype html><link rel="icon" href="data:,"><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:2400px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay" class="wrapperAd"></div></body>'
origin='https://demand-fixture.invalid'
endpoints={'hbopenbid.pubmatic.com':'pubmatic','htlb.casalemedia.com':'ix','fastlane.rubiconproject.com':'rubicon'}
expected=json.loads((out/'wire-prebid.json').read_text())['placements']

def check(value,message):
    if not value: raise AssertionError(message)

def summarize(req):
    url=urlsplit(req.url);bidder=endpoints[url.hostname]
    if bidder=='rubicon':
        query=parse_qs(url.query)
        # Default banner requests are per slot, not Rubicon single-request mode.
        return [{'bidder':bidder,'gpid':query.get('p_gpid',[''])[0],
                 'adslot':query.get('tg_i.dfp_ad_unit_code',[''])[0],
                 'id5':query.get('eid_id5-sync.com',[''])[0].split('^')[0]=='synthetic-id5-wire-test'}]
    body=req.post_data_buffer or b'{}'
    if body[:2]==b'\x1f\x8b': body=gzip.decompress(body)
    payload=json.loads(body)
    user=payload.get('user',{})
    eids=user.get('eids',[])+user.get('ext',{}).get('eids',[])
    id5=any(e.get('source')=='id5-sync.com' and any(u.get('id')=='synthetic-id5-wire-test' for u in e.get('uids',[])) for e in eids)
    return [{'bidder':bidder,'gpid':imp.get('ext',{}).get('gpid'),
             'adslot':imp.get('ext',{}).get('dfp_ad_unit_code'),'id5':id5} for imp in payload.get('imp',[])]

results=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
    for width in [1280,390]:
      for ids in [True,False]:
       for extension in ['.js','.min.js']:
        name=('wire-' if ids else 'wire-noids-')+'prebid'
        label=f'{name}{extension}@{width}'
        page=browser.new_page(viewport={'width':width,'height':900})
        rows=[];errors=[];blocked=[];parse_errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        def route(r):
            u=urlsplit(r.request.url)
            headers={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'*'}
            if r.request.url==origin+'/fixture':
                r.fulfill(status=200,content_type='text/html',body=html)
            elif u.hostname in endpoints:
                if r.request.method!='OPTIONS':
                    try: rows.extend(summarize(r.request))
                    except Exception as e: parse_errors.append(type(e).__name__+': '+str(e))
                r.fulfill(status=204,headers=headers,body='')
            elif r.request.url.startswith('https://cdn.jsdelivr.net/gh/prebid/currency-file@1/latest.json'):
                r.fulfill(status=200,headers=headers,content_type='application/json',body=json.dumps({'conversions':{'EUR':{'EUR':1,'USD':1},'USD':{'USD':1,'EUR':1}}}))
            else:
                blocked.append(u.hostname);r.abort()
        page.route('**/*',route)
        try:
            page.clock.install(time=1790164800000);page.goto(origin+'/fixture')
            page.add_script_tag(content=mock)
            page.evaluate('googletag.apiReady=true;googletag.pubadsReady=true')
            page.add_script_tag(content=prebid)
            check(page.evaluate('pbjs.installedModules.includes("gptPreAuction")'),'Missing real GPT pre-auction module')
            page.add_script_tag(content=(out/(name+extension)).read_text())
            page.wait_for_function('__testAds.observations.requests.length>0')
            page.wait_for_timeout(700)
            if page.locator('#adsx-takeover-close').is_visible():page.locator('#adsx-takeover-close').click()
            page.evaluate('scrollTo(0,2600)');page.wait_for_timeout(900)
            before=len(rows)
            page.evaluate('scrollTo(0,0)')
            page.evaluate("__testAds.emit('slotVisibilityChanged',{slot:adSlots.Billboard,inViewPercentage:100})")
            for _ in range(40):
                page.evaluate("document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true}))")
                page.clock.run_for(1000);page.wait_for_timeout(100)
            check(not parse_errors,'Request parsing failed: '+str(parse_errors))
            check(not errors,'Page errors: '+str(errors))
            check(not blocked,'Unexpected attempted external hosts: '+str(blocked))
            for bidder in endpoints.values():
                actual=[r for r in rows if r['bidder']==bidder]
                for code,placement in expected.items():
                    found=[r for r in actual if r['gpid']==placement['gpid']]
                    check(found,f'Missing {bidder}/{code}: '+str(actual))
                    check(all(r['adslot']==placement['adslot'] for r in found),f'MCM adslot lost for {bidder}/{code}')
                refreshed=[r for r in rows[before:] if r['bidder']==bidder and r['gpid']==expected['Billboard']['gpid']]
                check(refreshed,f'No real adapter refresh request for {bidder}')
                check(all(r['id5']==ids for r in actual),f'EID presence mismatch for {bidder}')
            check(page.evaluate('pbjs.getConfig("enableSendAllBids")') is True,'Send All Bids disabled')
            results.append({'case':label,'passed':True,'requests':len(rows),'bidders':sorted(endpoints.values()),'id5Present':ids})
            print('PASS '+label,flush=True)
        except Exception as e:
            results.append({'case':label,'passed':False,'error':str(e),'rows':rows,'errors':errors,'blocked':blocked,'parseErrors':parse_errors})
            print('FAIL '+label+': '+str(e),flush=True)
        finally: page.close()
    browser.close()
report={'prebidVersion':'11.34.0','sourceCommit':'195e0c6069928ed906bde550cb4e4183d1dc8474','buildSha256':hashlib.sha256(pb_path.read_bytes()).hexdigest(),'scope':'Unmodified client adapter serialization; synthetic ID and empty responses; no external traffic','cases':results}
(out/'wire-results.json').write_text(json.dumps(report,indent=2))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
