"""Actual minified Debug UI and downloaded commands; synthetic demand only."""
import gzip,json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parent.parent
fixture=root/'.generated/schain-debug-fixture'
out=root/'.generated/schain-debug-evidence';out.mkdir(parents=True,exist_ok=True)
errors=[];requests=[];fail_options=False
chain={'ver':'1.0','complete':1,'nodes':[{'asi':'seller.example','sid':'123','hp':1}]}
payload={'source':{'ext':{'schain':chain}},'imp':[{'id':'bid-P1'},{'id':'bid-P2'}]}
compressed=gzip.compress(json.dumps(payload).encode())

def route(route):
    req=route.request;url=urlsplit(req.url);requests.append({'url':req.url,'method':req.method})
    if url.netloc in ['rtb.openx.net','hbopenbid.pubmatic.com']:
        if req.method=='OPTIONS':
            route.fulfill(status=204,headers={'access-control-allow-origin':'*','access-control-allow-methods':'POST, GET','access-control-allow-headers':'content-type'});return
        if url.netloc=='hbopenbid.pubmatic.com':
            assert gzip.decompress(req.post_data_buffer)==json.dumps(payload).encode()
        elif req.method=='POST':
            assert json.loads(req.post_data)==payload
        route.fulfill(status=200,content_type='application/json',headers={'access-control-allow-origin':'*'},body='{}');return
    assert url.netloc=='tessera.fixture.invalid',req.url
    assert req.method=='GET',req.method
    if url.path.startswith('/api/'):
        if fail_options:
            route.fulfill(status=503,content_type='application/json',body='{"error":"Options temporarily unavailable"}');return
        if url.path.endswith('/ad-units'):
            data=[{'id':'p1','code':'P1','enabled':True,'type':'ATF','sortOrder':1},{'id':'p2','code':'P2','enabled':True,'type':'BTF','sortOrder':2}]
        elif url.path.endswith('/bidders'):
            data=[{'id':'b1','bidder':'openx','enabled':True},{'id':'b2','bidder':'pubmatic','enabled':True}]
        else:raise AssertionError(url.path)
        key='adUnits' if url.path.endswith('/ad-units') else 'bidders'
        route.fulfill(status=200,content_type='application/json',body=json.dumps({key:data}));return
    name='index.html' if url.path=='/' else url.path[1:]
    assert name in ['index.html','app.js','app.css'],name
    route.fulfill(path=str(fixture/name))

with sync_playwright() as p:
    browser=p.chromium.launch()
    context=browser.new_context(viewport={'width':1440,'height':1000},accept_downloads=True)
    page=context.new_page();page.set_default_timeout(10000);page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
    page.add_init_script("""window.__copied=[];Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{if(window.__blockCopy)throw Error('blocked');window.__copied.push(text)}}});""")
    page.goto('https://tessera.fixture.invalid/')
    page.get_by_role('heading',name='Debug Console',exact=True).wait_for()
    page.get_by_label('Find command').fill('SChain')
    card=page.locator('.debug-command-card').filter(has=page.get_by_role('heading',name='SChain and full requests',exact=True))
    wire=page.locator('.debug-command-card').filter(has=page.get_by_role('heading',name='SChain network capture',exact=True))
    compact=page.locator('.debug-command-card').filter(has=page.get_by_role('heading',name='SChain position report',exact=True))
    assert compact.get_by_role('button',name='Copy command',exact=True).is_disabled()
    assert compact.get_by_role('button',name='Download .js',exact=True).is_disabled()
    card.get_by_role('button',name='Copy command',exact=True).click()
    all_code=page.evaluate('window.__copied.at(-1)')
    # Running a copied command in the minified production-style UI must be standalone.
    empty=page.evaluate(all_code)
    assert empty['requests']==[] and any('not loaded' in x for x in empty['warnings'])
    page.evaluate("""chain=>{window.__events=[{eventType:'bidRequested',elapsedTime:20,args:{bidderCode:'openx',auctionId:'a1',bidderRequestId:'br1',schain:null,bids:['P1','P2'].map(code=>({adUnitCode:code,bidId:'bid-'+code,schain:chain}))}}];window.__handlers=new Set();window.pbjs={version:'9.18.0',getConfig:()=>({schain:{config:chain}}),getBidderConfig:()=>({}),getEvents:()=>window.__events,onEvent:(n,f)=>window.__handlers.add(f),offEvent:(n,f)=>window.__handlers.delete(f),requestBids:()=>{throw Error('Forbidden auction')},setConfig:()=>{throw Error('Forbidden write')}};}""",chain)
    assert len(page.evaluate(all_code)['requests'][0]['filteredBids'])==2
    page.locator('label').filter(has=page.get_by_text('Ad unit scope',exact=True)).locator('select').select_option('P1')
    page.locator('label').filter(has=page.get_by_text('Bidder scope',exact=True)).locator('select').select_option('openx')
    with page.expect_download() as d:
        card.get_by_role('button',name='Download .js',exact=True).click()
    d.value.save_as(out/'debug-schain.js')
    single_code=(out/'debug-schain.js').read_text()
    report=page.evaluate(single_code)
    assert len(report['requests'][0]['filteredBids'])==1 and len(report['requests'][0]['originalRequest']['bids'])==2
    assert report['requests'][0]['filteredBids'][0]['schain'][0]['value']==chain
    page.evaluate('window.__AD_REQUEST_DEBUG.copy()')
    assert json.loads(page.evaluate('window.__copied.at(-1)'))['scope']['adUnit']=='P1'
    with page.expect_download() as d:
        page.evaluate('window.__AD_REQUEST_DEBUG.download()')
    d.value.save_as(out/'report.json');assert json.loads((out/'report.json').read_text())['requests']
    # The compact command supports both the existing selector and an explicit GAM path.
    compact.get_by_role('button',name='Copy command',exact=True).click()
    selected_code=page.evaluate('window.__copied.at(-1)')
    assert page.evaluate(selected_code) is None
    selected=page.evaluate('window.__AD_REQUEST_DEBUG.snapshot()')
    assert selected['request']['adUnitCode']=='P1' and 'requests' not in selected
    page.get_by_label('Ad unit name or GAM path',exact=True).fill('/123/site/P1')
    page.evaluate("window.__events[0].args.bids[0].ortb2Imp={ext:{gpid:'/123/site/P1'}}")
    with page.expect_download() as d:
        compact.get_by_role('button',name='Download .js',exact=True).click()
    d.value.save_as(out/'debug-schain-position.js')
    compact_code=(out/'debug-schain-position.js').read_text()
    assert 'tessera' not in compact_code.lower()
    assert page.evaluate(compact_code) is None
    short=page.evaluate('window.__AD_REQUEST_DEBUG.snapshot()')
    assert short['request']['matchedBy']=='exact recorded GPID/adslot'
    assert short['schainCheck']['status']=='basic-fields-pass' and short['evidence']=='prebid-only'
    page.evaluate("""async payload=>{await fetch('https://rtb.openx.net/openrtbb/prebidjs',{method:'POST',body:JSON.stringify(payload)});} """,payload)
    short=page.evaluate('window.__AD_REQUEST_DEBUG.ready()')
    assert short['evidence']=='captured-http-call' and not short['capture']['active']
    assert short['request']['impression']['id']=='bid-P1' and short['request']['originalBatchImpressions']==2
    assert len(json.dumps(short))<3000 and 'P2' not in json.dumps(short)
    page.evaluate('window.__AD_REQUEST_DEBUG.copy()')
    assert json.loads(page.evaluate('window.__copied.at(-1)'))['evidence']=='captured-http-call'
    with page.expect_download() as d:
        page.evaluate('window.__AD_REQUEST_DEBUG.download()')
    assert d.value.suggested_filename=='ad-request.json'
    d.value.save_as(out/'position-report.json')
    detail=json.loads((out/'position-report.json').read_text())
    assert detail['request']['adUnitCode']=='P1' and detail['originalRequest']['body']['value']==payload
    assert 'tessera' not in json.dumps(detail).lower()
    page.evaluate('window.__AD_REQUEST_DEBUG.copySummary()')
    summary=page.evaluate('window.__copied.at(-1)')
    assert '| SChain | Present |' in summary and 'seller.example' in summary and 'bid-P2' not in summary
    (out/'position-summary.txt').write_text(summary)
    # Actual iframe context (including an opaque sandbox) must fail clearly without capture.
    for sandbox in [False,True]:
        page.evaluate("sandbox=>{const f=document.createElement('iframe');f.id='context-check';if(sandbox)f.setAttribute('sandbox','allow-scripts');f.srcdoc='<p>Ad iframe fixture</p>';document.body.appendChild(f);}",sandbox)
        frame=page.locator('#context-check').element_handle().content_frame()
        frame.wait_for_selector('p')
        assert frame.evaluate(compact_code) is None
        wrong=frame.evaluate('window.__AD_REQUEST_DEBUG.snapshot()')
        assert wrong['status']=='wrong-console-context' and not wrong['capture']['active']
        assert wrong['schainCheck']['status']=='not-checked' and wrong['request'] is None
        assert any('Choose top' in x for x in wrong['warnings'])
        page.locator('#context-check').evaluate('(el)=>el.remove()')
    card.get_by_text('Preview command',exact=True).click()
    assert 'inspect' in card.locator('pre').inner_text().lower()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
    page.screenshot(path=str(out/'mobile.png'),full_page=True)
    # Clipboard failure has manual preview recovery; option loading error has retry.
    page.evaluate('window.__blockCopy=true')
    card.get_by_role('button',name='Copy command',exact=True).click()
    page.get_by_text('Clipboard access was blocked.',exact=False).wait_for()
    page.evaluate('window.__blockCopy=false')
    fail_options=True
    page.get_by_role('button',name='Reload options',exact=True).click()
    page.locator('.debug-console-error').filter(has_text='temporarily unavailable').wait_for()
    fail_options=False
    page.get_by_role('button',name='Reload options',exact=True).click()
    page.locator('label').filter(has=page.get_by_text('Ad unit scope',exact=True)).locator('select').select_option('__all__')
    page.locator('label').filter(has=page.get_by_text('Bidder scope',exact=True)).locator('select').select_option('__all__')
    wire.get_by_role('button',name='Copy command',exact=True).click()
    capture_code=page.evaluate('window.__copied.at(-1)')
    page.evaluate('()=>{window.__originalFetch=window.fetch;window.__originalOpen=XMLHttpRequest.prototype.open;window.__originalSend=XMLHttpRequest.prototype.send;}')
    page.evaluate(capture_code)
    page.evaluate("""async payload=>{await fetch('https://rtb.openx.net/openrtbb/prebidjs',{method:'POST',body:JSON.stringify(payload)});} """,payload)
    page.evaluate("""async bytes=>{await new Promise((resolve,reject)=>{let x=new XMLHttpRequest();x.open('POST','https://hbopenbid.pubmatic.com/translator?source=prebid-client&gzip=1');x.onload=resolve;x.onerror=reject;x.send(new Uint8Array(bytes));});}""",list(compressed))
    captured=page.evaluate('window.__AD_REQUEST_DEBUG.ready()')
    assert len(captured['network'])==2
    assert captured['network'][0]['mapping']=='exact bid ID match'
    assert captured['network'][1]['body']['status']=='decoded gzip'
    assert captured['network'][1]['schain'][0]['value']==chain
    page.evaluate('window.__AD_REQUEST_DEBUG.stop()')
    assert page.evaluate('fetch===window.__originalFetch && XMLHttpRequest.prototype.open===window.__originalOpen && XMLHttpRequest.prototype.send===window.__originalSend && window.__handlers.size===0')
    assert not errors,errors
    browser.close()
(out/'result.json').write_text(json.dumps({'passed':True,'browser':'Chromium','requests':requests,'errors':errors,'checks':['minified copied script','one/all filters','original batch preserved','copy/download JSON','desktop/mobile','clipboard fallback','options retry','fetch JSON','XHR gzip bytes preserved','stop restores APIs','iframe top guidance','neutral summary table','complete selected payload']},indent=2))
print('PASS SChain Debug: actual minified UI, standalone commands, desktop/mobile, local HTTP JSON/gzip, cleanup')
