"""Local synthetic application test; never uses the user's browser or Google account."""
import json, os, subprocess, time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

root=Path(__file__).resolve().parent.parent
out=root/'.generated/gam-ui-evidence';out.mkdir(parents=True,exist_ok=True)
process=None
try:
    try: urlopen('http://127.0.0.1:4178/api-integrations',timeout=1)
    except Exception:
        process=subprocess.Popen(['node','scripts/gam-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
        assert 'ready' in process.stdout.readline()
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1080})
        errors=[];external=[];requests=[]
        def route(r):
            if not r.request.url.startswith('http://127.0.0.1:4178/'):
                external.append(r.request.url);r.abort()
            else:r.continue_()
        page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
        page.on('request',lambda r:requests.append({'method':r.method,'url':r.url}))
        page.goto('http://127.0.0.1:4178/api-integrations')
        page.get_by_text('Povezano · 123456',exact=True).wait_for()
        assert page.locator('.gam-tabs button').first.inner_text()=='GAM povezivanje'
        assert page.get_by_role('button',name='GAM povezivanje',exact=True).get_attribute('aria-current')=='page'
        page.get_by_role('button',name='Ad uniti',exact=True).click()
        assert page.locator('.gam-total').inner_text().startswith('26')
        assert all(r['method']=='GET' for r in requests)
        assert not page.get_by_role('button',name='Proveri u GAM-u',exact=True).is_enabled()
        page.get_by_label('Sajt / oznaka unosa',exact=True).fill('example.invalid')
        page.get_by_label('Parent naziv',exact=True).fill('Example Display')
        page.get_by_label('Parent code',exact=True).fill('Example')
        page.screenshot(path=str(out/'desktop.png'),full_page=False)
        page.get_by_role('button',name='InFeed 6 pozicija',exact=True).click()
        page.get_by_label('Broj pozicija',exact=True).fill('2')
        page.get_by_label('Početni broj',exact=True).fill('3')
        assert page.locator('.gam-total').inner_text().startswith('22')
        page.get_by_label('Naziv novog šablona',exact=True).fill('Dve InFeed pozicije')
        page.get_by_role('button',name='Sačuvaj šablon',exact=True).click()
        page.get_by_text('Šablon je sačuvan i dostupan za sledeći unos.',exact=True).wait_for()
        page.get_by_role('button',name='Proveri u GAM-u',exact=True).click()
        page.get_by_text('Provereno u GAM-u',exact=True).wait_for()
        assert not page.get_by_role('button',name='Kreiraj u GAM-u',exact=True).is_enabled()
        page.get_by_role('checkbox',name='Potvrđujem kreiranje',exact=False).check()
        page.get_by_role('button',name='Kreiraj u GAM-u',exact=True).click()
        page.get_by_text('Rezultat je sačuvan',exact=True).wait_for()
        assert page.locator('.gam-result').get_by_text('/123456/Example/InFeed_3',exact=True).count()==1
        page.get_by_role('button',name='Istorija',exact=True).click()
        page.get_by_text('example.invalid ·',exact=False).wait_for()
        page.reload()
        page.get_by_text('Povezano · 123456',exact=True).wait_for()
        page.get_by_role('button',name='Šabloni',exact=True).click()
        page.get_by_role('heading',name='Dve InFeed pozicije',exact=True).wait_for()
        page.get_by_role('button',name='Ad uniti',exact=True).click()
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(out/'mobile.png'),full_page=True)
        page.set_viewport_size({'width':1440,'height':1080})
        page.get_by_role('button',name='Line itemi',exact=True).click()
        page.get_by_role('heading',name='Šta kreiramo?',exact=True).wait_for()
        page.get_by_label('Advertiser',exact=True).select_option('new')
        page.get_by_label('Naziv novog advertiser-a',exact=True).fill('Example Prebid advertiser')
        page.get_by_label('Naziv novog order-a',exact=True).fill('Example Prebid order')
        page.get_by_label('Trafficker',exact=True).locator('option[value="30"]').wait_for(state='attached')
        page.get_by_label('Trafficker',exact=True).select_option('30')
        page.get_by_role('button',name='Učitaj ad unite',exact=True).click()
        page.get_by_role('button',name='Dodaj ovaj parent',exact=True).click()
        page.get_by_label('Do 1',exact=True).fill('0.03')
        page.get_by_label('Broj kopija kreativa',exact=True).fill('2')
        page.get_by_label('Veličine line itema',exact=True).fill('300x250;728x90')
        page.get_by_role('button',name='Proveri postavku u GAM-u',exact=True).click()
        page.get_by_role('heading',name='Spremno za potvrdu',exact=True).wait_for()
        assert not page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).is_enabled()
        page.get_by_role('checkbox',name='Potvrđujem ovu postavku',exact=False).check()
        page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).click()
        page.get_by_role('heading',name='Završeno',exact=True).wait_for()
        assert page.locator('.gam-li-review').get_by_text('HB EUR 0.03',exact=True).count()==1
        assert page.locator('.gam-li-review').get_by_role('link',name='Preuzmi kompletnu').count()==1
        page.locator('.gam-li-review').scroll_into_view_if_needed()
        page.screenshot(path=str(out/'line-items-prebid-result.png'),full_page=False)
        page.get_by_role('button',name='Pripremi sledeću postavku',exact=True).click()
        page.get_by_role('button',name='Jedan line item',exact=False).click()
        page.get_by_label('Advertiser',exact=True).select_option('existing')
        page.get_by_label('Izaberite advertiser',exact=True).locator('option[value="10"]').wait_for(state='attached')
        page.get_by_label('Izaberite advertiser',exact=True).select_option('10')
        page.get_by_label('Order',exact=True).select_option('existing')
        page.get_by_label('Izaberite order',exact=True).locator('option[value="20"]').wait_for(state='attached')
        page.get_by_label('Izaberite order',exact=True).select_option('20')
        page.get_by_label('Naziv line itema',exact=True).fill('Example direct campaign')
        page.get_by_label('Tip line itema',exact=True).select_option('STANDARD')
        page.get_by_label('Završetak (UTC) — obavezno',exact=True).fill('2099-01-01T12:00')
        page.get_by_role('button',name='Proveri postavku u GAM-u',exact=True).click()
        page.get_by_role('heading',name='Spremno za potvrdu',exact=True).wait_for()
        page.get_by_role('checkbox',name='Potvrđujem ovu postavku',exact=False).check()
        page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).click()
        page.get_by_role('heading',name='Završeno',exact=True).wait_for()
        assert page.locator('.gam-li-review').get_by_text('Example direct campaign',exact=True).count()==1
        page.reload()
        page.get_by_role('button',name='Line itemi',exact=True).click()
        page.get_by_role('button',name='Otvori posao',exact=True).first.wait_for()
        assert page.get_by_role('button',name='Otvori posao',exact=True).count()==2
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(out/'line-items-mobile.png'),full_page=True)
        page.set_viewport_size({'width':1440,'height':1080})
        page.locator('.gam-li').scroll_into_view_if_needed()
        page.screenshot(path=str(out/'line-items-desktop.png'),full_page=False)
        page.get_by_role('button',name='GAM povezivanje',exact=True).click()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.screenshot(path=str(out/'connection.png'),full_page=True)
        page.route('**/test-api/integrations/gam/status',lambda r:r.fulfill(json={'configured':False,'connections':[]}))
        page.reload()
        page.get_by_text('Povezivanje još nije aktivirano',exact=False).wait_for()
        assert page.get_by_role('button',name='GAM povezivanje',exact=True).get_attribute('aria-current')=='page'
        upload=page.get_by_label('Service account JSON',exact=True)
        assert upload.is_enabled()
        before=len([r for r in requests if r['method']=='POST'])
        upload.set_input_files({'name':'key.json','mimeType':'application/json','buffer':b'{"type":"service_account","client_email":"fixture@fixture.iam.gserviceaccount.com","private_key":"synthetic-key"}'})
        page.get_by_label('Network code',exact=True).fill('123456')
        assert upload.evaluate('(input) => input.files[0].name')=='key.json'
        assert len([r for r in requests if r['method']=='POST'])==before
        assert not page.get_by_role('button',name='Proveri i poveži GAM',exact=True).is_enabled()
        page.unroute('**/test-api/integrations/gam/status')
        page.get_by_role('button',name='Proveri podešavanje',exact=True).click()
        page.get_by_text('Povezano · 123456',exact=True).wait_for()
        assert upload.evaluate('(input) => input.files[0].name')=='key.json'
        assert page.get_by_role('button',name='Proveri i poveži GAM',exact=True).is_enabled()
        assert len([r for r in requests if r['method']=='POST'])==before
        assert not errors,errors
        assert not external,external
        browser.close()
        (out/'result.json').write_text(json.dumps({'passed':True,'pageErrors':errors,'externalRequests':external,'requests':requests},indent=2))
        print('PASS Prebid and ordinary line items, shared creatives, saved jobs, desktop/mobile, presets, saved templates, explicit review/create, paths/history, connection-first navigation, local JSON selection and setup recheck')
finally:
    if process:process.terminate();process.wait(timeout=10)
