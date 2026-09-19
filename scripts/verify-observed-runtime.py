"""Execute the new compiled runtime in Chromium with local mock ad libraries only."""
import json
from pathlib import Path
from playwright.sync_api import sync_playwright
out=Path('.generated/observed-evidence')
source=(out/'ads.js').read_text()
mock=Path('tests/runtime/mock-ad-libraries.js').read_text()
checks=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    page=browser.new_page(viewport={'width':1280,'height':900})
    errors=[];external=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    page.route('**/*',lambda r:(external.append(r.request.url),r.abort()))
    try:
        page.set_content('<!doctype html><div id="Billboard" class="wrapperAd" style="height:250px"></div><div id="P1" class="wrapperAd" style="height:250px"></div><div id="Overlay"></div>')
        page.add_script_tag(content=mock)
        page.add_script_tag(content=source)
        page.wait_for_function("window.__tesseraRuntimeDiagnostics?.['test-site']?.snapshot().totals.filled>0")
        first=page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot()")
        assert first['initializations']==1 and first['totals']['requests']>0
        checks.append('Compiled new runtime enters once and observes actual mocked GPT requests/renders')
        page.add_script_tag(content=source)
        second=page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot()")
        assert second['initializations']==1 and second['attempts']==2 and second['blockedDuplicates']==1
        checks.append('Second insertion is counted and blocked before runtime initialization')
        page.evaluate("{const slot=__testAds.slots.find(s=>s.id==='Billboard');__testAds.emit('slotRequested',{slot});__testAds.emit('slotRenderEnded',{slot,isEmpty:true});}")
        assert page.evaluate("__tesseraRuntimeDiagnostics['test-site'].snapshot().totals.empty")>=1
        checks.append('Empty response stays separate from filled render')
        assert not errors,errors
        assert not external,external
        checks.append('No JavaScript errors or external requests')
    finally:
        browser.close()
(out/'browser.json').write_text(json.dumps({'scope':'Compiled new runtime; mocked GPT; no real auctions or revenue','checks':checks,'passed':len(checks)},indent=2))
print(json.dumps(checks,indent=2))
