"""New ad-position runtime cases only. Offline Chromium; no real ad requests."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
out = root / '.generated/position-evidence'
mock = (root / 'tests/runtime/mock-ad-libraries.js').read_text()
html = '<!doctype html><html><body><div id="Billboard" class="wrapperAd" style="height:250px"></div><div style="height:2400px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay" class="wrapperAd"></div></body></html>'
results = []
def check(value, message):
    if not value:
        raise AssertionError(message)
def count(page, code):
    return page.evaluate('(id)=>__testAds.observations.requests.filter(r=>r.id===id).length', code)
def visible(page):
    page.wait_for_function('takeOverDebug.state().visible', timeout=3500)
def run(browser, name, callback, source='prebid', width=1280, options=None, hook=''):
    page = browser.new_page(viewport={'width':width,'height':900})
    errors, external = [], []
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda route:(external.append(route.request.url),route.abort()))
    try:
        page.set_content(html)
        page.evaluate('(v)=>window.__testOptions=v', options or {})
        page.add_script_tag(content=mock)
        page.add_script_tag(content='''
          window.__pbEvents={};
          pbjs.onEvent=(type,fn)=>(__pbEvents[type]??=[]).push(fn);
          pbjs.offEvent=(type,fn)=>__pbEvents[type]=(__pbEvents[type]||[]).filter(f=>f!==fn);
          pbjs.getAdserverTargetingForAdUnitCode=code=>code==='Overlay'?{hb_bidder:'pubmatic',hb_adid:'overlay-bid',hb_pb:'1.20'}:{};
        '''+hook)
        source_text=(out/(source+'.js')).read_text()
        page.add_script_tag(content=source_text)
        callback(page,source_text)
        check(not errors, str(errors))
        check(not external, 'External requests: '+str(external))
        results.append({'name':name,'passed':True})
    except Exception as error:
        results.append({'name':name,'passed':False,'error':str(error),'pageErrors':errors})
    finally:
        page.close()

def auction(page,source):
    visible(page)
    bids=page.evaluate('__testAds.observations.bids.flatMap(b=>b.adUnits).filter(u=>u.code==="Overlay")')
    check(len(bids)==1,'Exactly one TakeOver auction required')
    check(bids[0]['bids'][0]['params']['adSlot']=='overlay-slot','Position bidder override lost')
    check(bids[0]['mediaTypes']['banner']['sizes']==[[800,600]],'Wrong auction size')
    check(count(page,'adsx-takeover-slot')==1 and count(page,'Overlay')==0,'Duplicate normal/overlay request')
    check(page.evaluate('__testAds.slots.find(s=>s.id==="adsx-takeover-slot").targeting.hb_adid')=='overlay-bid','Bid targeting missing')
    page.set_viewport_size({'width':360,'height':740})
    page.add_script_tag(content=source)
    page.locator('#adsx-takeover-close').click()
    page.wait_for_timeout(200)
    check(count(page,'adsx-takeover-slot')==1,'Resize/duplicate script/close re-requested')
    check(page.evaluate('takeOverDebug.state().closeReason')=='manual-close','Close failed')

def mapped(size):
    def callback(page,source):
        visible(page)
        check(page.evaluate('takeOverDebug.state().requestedSize')==size,'Responsive map not applied')
    return callback
def gam_only(page,source):
    visible(page)
    check(page.evaluate('__testAds.observations.bids.length')==0,'GPT-only requested bids')
def skipped(page,source):
    page.wait_for_timeout(700)
    check(count(page,'adsx-takeover-slot')==0,'Disabled breakpoint requested TakeOver')
    check(page.evaluate('window.TAKEOVER_ACTIVE_FOR_PAGE') is False,'Disabled TakeOver blocks interstitial')
def late(page,source):
    visible(page)
    page.locator('#adsx-takeover-close').click()
    page.evaluate('window.__lateOverlay?.()')
    page.wait_for_timeout(80)
    check(count(page,'adsx-takeover-slot')==1,'Late bid callback duplicated GAM')
def nofill(page,source):
    page.wait_for_function('takeOverDebug.state().fallbackRequested', timeout=3500)
    check(count(page,'adsx-takeover-slot')==1,'No-fill requested overlay again')
    check(count(page,'interstitial-guard')==1,'No-fill fallback duplicated')
def universal(page,source):
    page.wait_for_function('window.__tesseraOverlayAuction?.pendingRender',timeout=3500)
    check(not page.evaluate('takeOverDebug.state().visible'),'hb_bidder falsely accepted a 1x1 creative')
    page.evaluate("(__pbEvents.adRenderSucceeded||[]).forEach(f=>f({bid:{adUnitCode:'Other',adId:'overlay-bid',width:800,height:600}}))")
    check(not page.evaluate('takeOverDebug.state().visible'),'Wrong unit render accepted')
    page.evaluate("(__pbEvents.adRenderSucceeded||[]).forEach(f=>f({bid:{adUnitCode:'Overlay',adId:'wrong-bid',width:800,height:600}}))")
    check(not page.evaluate('takeOverDebug.state().visible'),'Wrong bid render accepted')
    page.evaluate("(__pbEvents.adRenderSucceeded||[]).forEach(f=>f({bid:{adUnitCode:'Overlay',adId:'overlay-bid',width:800,height:600}}))")
    visible(page)
def lazy(page,source):
    visible(page);page.locator('#adsx-takeover-close').click()
    page.wait_for_timeout(1100)
    check(count(page,'P1')==0,'BTF rendered before configured margin')
    top=page.locator('#P1').evaluate('(e)=>e.getBoundingClientRect().top+scrollY')
    page.evaluate('(y)=>scrollTo(0,y)',top-1150)
    page.wait_for_function('__testAds.observations.bids.some(b=>b.adUnits.some(u=>u.code==="P1"))',timeout=1500)
    check(count(page,'P1')==0,'Fetch margin rendered too early')
    page.locator('#P1').scroll_into_view_if_needed()
    page.wait_for_function('__testAds.observations.requests.some(r=>r.id==="P1")',timeout=1500)
    check(count(page,'P1')==1,'Lazy display duplicated')
def immediate(page,source):
    visible(page)
    page.wait_for_function('__testAds.observations.requests.some(r=>r.id==="P1")',timeout=1500)
    check(count(page,'P1')==1,'Disabled BTF lazy did not request once')
def atf_lazy(page,source):
    visible(page);page.locator('#adsx-takeover-close').click()
    check(count(page,'Billboard')==1,'Visible ATF lazy duplicated initial auction')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    run(browser,'One Prebid TakeOver auction with unit override, close and duplicate-load guard',auction)
    run(browser,'Mobile map',mapped([300,250]),width=360)
    run(browser,'Tablet map',mapped([640,480]),width=900)
    run(browser,'GAM only',gam_only,source='gam')
    run(browser,'Empty mobile map skips TakeOver and guard',skipped,source='desktop-only',width=360)
    run(browser,'Bid timeout then late callback after close',late,hook="pbjs.requestBids=(i)=>{__testAds.observations.bids.push(JSON.parse(JSON.stringify(i)));if(i.adUnits.some(u=>u.code==='Overlay'))window.__lateOverlay=i.bidsBackHandler;else setTimeout(i.bidsBackHandler,1);};")
    run(browser,'No-fill uses one interstitial fallback',nofill,options={'takeoverResult':'empty'})
    run(browser,'Universal creative requires matching successful Prebid render',universal,options={'takeoverResult':'wrong-size'})
    run(browser,'Lazy fetch and render margins',lazy)
    run(browser,'Lazy BTF off requests immediately',immediate,source='btf-immediate')
    run(browser,'ATF lazy uses only one request',atf_lazy,source='atf-lazy')
    run(browser,'Frequency cap skips before creating DOM or guard',skipped,source='frequency',hook="Object.defineProperty(window,'sessionStorage',{value:{getItem(){return String(Date.now());},setItem(){}}});")
    browser.close()
out.mkdir(exist_ok=True)
(out/'browser-results.json').write_text(json.dumps(results,indent=2))
for row in results:
    print(('PASS ' if row['passed'] else 'FAIL ')+row['name']+(': '+row.get('error','') if not row['passed'] else ''))
raise SystemExit(0 if all(r['passed'] for r in results) else 1)
