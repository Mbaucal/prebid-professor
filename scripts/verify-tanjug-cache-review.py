"""Static review/download page only. No candidate JavaScript is executed."""
import hashlib,json,zipfile,io
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
root=Path('.generated/tanjug-cache-review');report=json.loads((root/'review.json').read_text())
checks=[];errors=[];external=[]
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True)
    context=browser.new_context(accept_downloads=True,viewport={'width':1280,'height':900})
    def route(r):
        prefix='https://offline-review.invalid/'
        if not r.request.url.startswith(prefix):external.append(r.request.url);r.abort();return
        name=r.request.url[len(prefix):]
        if name not in ['review.html','review.json','tanjug-cache-review-v1-control.zip','tanjug-cache-review-v1-cache.zip']:external.append(r.request.url);r.abort();return
        headers={'content-type':'text/html' if name.endswith('.html') else 'application/zip' if name.endswith('.zip') else 'application/json'}
        if name.endswith('.zip'):headers['content-disposition']='attachment; filename="'+name+'"'
        r.fulfill(status=200,headers=headers,body=(root/name).read_bytes())
    context.route('**/*',route)
    page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
    try:
        page.goto('https://offline-review.invalid/review.html')
        expect(page.get_by_role('heading',name='Tanjug · predlog cache pilota')).to_be_visible()
        expect(page.get_by_text('Pripremljeno za pregled.',exact=False)).to_be_visible()
        assert page.locator('script,iframe').count()==0
        assert page.evaluate('typeof window.pbjs+":"+typeof window.__tesseraExperiments')=='undefined:undefined'
        checks.append('Static proposal explains restricted scope and cannot execute ads')
        for arm in ['control','cache']:
            with page.expect_download() as download:page.locator('a[href$="-'+arm+'.zip"]').click()
            data=Path(download.value.path()).read_bytes();assert hashlib.sha256(data).hexdigest()==report['arms'][arm]['zipSha256']
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                config=json.loads(z.read('config.json'));assert config['bidCache']['mode']==report['arms'][arm]['mode'];assert config['bidCache']['maxAgeSeconds']==60
                assert [u['id'] for u in config['core']['explicitUnits']]==['Billboard','Sticky']
                assert hashlib.sha256(z.read('prebid.js')).hexdigest()==report['prebidSha256']
            checks.append(arm+': downloaded exact package with reviewed mode, positions and native Prebid bytes')
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(root/'review-mobile.png'),full_page=True)
        checks.append('Review fits mobile width')
        assert not errors,errors
        assert not external,external
        checks.append('No JavaScript errors, external requests, or publisher script execution')
    finally:browser.close()
result={'scope':'Offline static proposal only; candidate code is downloaded, never executed','checks':checks,'passed':len(checks)}
(root/'browser.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
