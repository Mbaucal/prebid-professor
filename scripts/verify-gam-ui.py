"""Local synthetic application test; never uses the user's browser or Google account."""
import json, os, subprocess, time
from copy import deepcopy
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/gam-ui-evidence';out.mkdir(parents=True,exist_ok=True)
process=None
try:
    try: urlopen('http://127.0.0.1:4178/api-integrations',timeout=1)
    except Exception:
        process=subprocess.Popen(['node','scripts/gam-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
        assert 'ready' in process.stdout.readline()
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
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
        expect(page.get_by_role('button',name='Pokreni i napravi',exact=True)).to_be_enabled()
        assert page.get_by_label('Naziv novog advertiser-a',exact=True).input_value()=='Prebid'
        assert page.get_by_label('Naziv novog order-a',exact=True).input_value()=='SMN - Programmatic HB - Prebid'
        assert not page.locator('.gam-li-settings').get_attribute('open')
        page.locator('.gam-li-preset').scroll_into_view_if_needed()
        page.screenshot(path=str(out/'prebid-defaults-desktop.png'),full_page=False)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.locator('.gam-li-preset').screenshot(path=str(out/'prebid-defaults-mobile.png'))
        page.set_viewport_size({'width':1440,'height':1080})
        # Verify the untouched submitted preset. Bound only the synthetic browser
        # fixture's volume; the API suite exercises all 2,000 prices unchanged.
        submitted=[]
        def small_preset(r):
            data=json.loads(r.request.post_data)
            submitted.append(data)
            assert data['advertiser']['name']=='Prebid'
            assert data['order']['name']=='SMN - Programmatic HB - Prebid'
            assert data['order']['traffickerId']=='30'
            assert data['inventory']=={'kind':'placements','ids':['40']}
            assert data['ranges']==[{'from':'0.01','to':'20.00','step':'0.01'}]
            assert data['creative']['copies']==20
            assert '@latest/dist/creative.js' in data['creative']['snippet']
            assert data['customTargeting']=='' and data['allowOverbook'] is True
            data={**data,'ranges':[{'from':'0.01','to':'0.03','step':'0.01'}],'creative':{**data['creative'],'copies':2}}
            r.continue_(post_data=json.dumps(data))
        page.route('**/line-items/preview',small_preset)
        paused=[]
        def pause_review(r):
            response=r.fetch()
            if response.json().get('status')=='ready':
                page.get_by_role('button',name='Pauziraj posle tekućeg koraka',exact=True).click()
                paused.append(True)
            r.fulfill(response=response)
        page.route('**/line-items/jobs/*/review',pause_review)
        start_count=sum(r['url'].endswith('/start') for r in requests)
        page.get_by_role('button',name='Pokreni i napravi',exact=True).click()
        page.get_by_role('heading',name='Spremno za potvrdu',exact=True).wait_for()
        expect(page.get_by_role('button',name='Pokreni i napravi',exact=True)).to_be_enabled()
        assert paused and sum(r['url'].endswith('/start') for r in requests)==start_count
        page.unroute('**/line-items/jobs/*/review',pause_review)
        page.reload()
        page.get_by_role('button',name='Line itemi',exact=True).click()
        expect(page.get_by_role('button',name='Pokreni i napravi',exact=True)).to_be_enabled()
        assert sum(r['url'].endswith('/start') for r in requests)==start_count
        page.get_by_role('button',name='Pokreni i napravi',exact=True).click()
        page.get_by_role('heading',name='Završeno',exact=True).wait_for(timeout=60000)
        assert len(submitted)==2
        assert sum(r['url'].endswith('/start') for r in requests)==start_count+1
        page.unroute('**/line-items/preview',small_preset)
        page.get_by_role('button',name='Pripremi sledeću postavku',exact=True).click()
        page.locator('.gam-li-settings>summary').click()
        page.get_by_label('Advertiser',exact=True).select_option('new')
        page.get_by_label('Naziv novog advertiser-a',exact=True).fill('Example Prebid advertiser')
        page.get_by_label('Naziv novog order-a',exact=True).fill('Example Prebid order')
        page.get_by_label('Trafficker',exact=True).locator('option[value="30"]').wait_for(state='attached')
        page.get_by_label('Trafficker',exact=True).select_option('30')
        page.get_by_label('Targetiranje inventory-ja',exact=True).select_option('adUnits')
        page.get_by_role('button',name='Učitaj ad unite',exact=True).click()
        page.get_by_role('button',name='Dodaj ovaj parent',exact=True).click()
        page.get_by_label('Do 1',exact=True).fill('0.03')
        page.get_by_label('Broj kopija kreativa',exact=True).fill('2')
        page.get_by_label('Veličine line itema',exact=True).fill('300x250;728x90')
        expect(page.locator('.gam-li-naming tbody tr').last).to_contain_text('HB €0.03, #1')
        assert page.locator('.gam-li-naming').get_by_text('hb_pb = 0.03',exact=True).count()==1
        assert page.locator('.gam-li-order-names').get_by_text('Example Prebid order #1 (0.01-0.03 EUR)',exact=True).count()==1
        page.locator('.gam-li-naming').scroll_into_view_if_needed()
        page.screenshot(path=str(out/'line-items-naming.png'),full_page=False)
        page.set_viewport_size({'width':390,'height':844})
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.locator('.gam-li-naming').scroll_into_view_if_needed()
        page.screenshot(path=str(out/'line-items-naming-mobile.png'),full_page=False)
        page.set_viewport_size({'width':1440,'height':1080})
        page.get_by_role('button',name='Proveri postavku u GAM-u',exact=True).click()
        page.get_by_role('heading',name='Spremno za potvrdu',exact=True).wait_for()
        assert not page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).is_enabled()
        page.get_by_role('checkbox',name='Potvrđujem ovu postavku',exact=False).check()
        page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).click()
        page.get_by_role('heading',name='Završeno',exact=True).wait_for()
        assert page.locator('.gam-li-review').get_by_text('HB €0.03',exact=True).count()==1
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
        # Exercise the compiled panel's error/recovery boundary independently of
        # the handler fixture. Existing normal flows above still use gamResponse.
        job_url=next(r['url'].removesuffix('/start') for r in reversed(requests) if r['url'].endswith('/start'))
        completed=page.request.get(job_url).json()
        verified=deepcopy(completed)
        verified.update(status='ready',error='',awaitingCheck=False,canStart=True,
                        verificationCount=0,unverifiedCount=0,blockedCount=0,verificationIssues=[])
        for count in verified['counts'].values():
            count.update(existing=count['existing']+count['created'],created=0,new=0,
                         conflict=0,unverified=0,blocked=0)
            count['done']=count['existing']
        for example in verified['examples']:example['state']='existing'
        unverified=deepcopy(verified)
        unverified.update(canStart=False,error='GAM provera ordera nije uspela. Ponovite proveru.',
                          verificationCount=2,unverifiedCount=1,blockedCount=1,
                          verificationIssues=[{'ref':'order:0','state':'unverified','message':'GAM je odbio zahtev: UNPARSABLE.'},
                                              {'ref':'lineItem:0','state':'blocked','message':'Čeka potvrđen order.'}])
        unverified['counts']['order'].update(done=0,existing=0,unverified=1)
        unverified['counts']['lineItem'].update(done=0,existing=0,blocked=1)
        unverified['examples'][0]['state']='blocked'
        scenario={'job':unverified,'retries':0}
        action_calls=[]
        def serve_job(r):r.fulfill(json=scenario['job'])
        def serve_action(r):
            action=r.request.url.rsplit('/',1)[-1]
            action_calls.append({'action':action,'body':json.loads(r.request.post_data or '{}')})
            if action=='review':
                assert action_calls[-1]['body'].get('retry') is True
                scenario['retries']+=1
                if scenario['retries']>1:scenario['job']=verified
            elif action=='step' and scenario.get('stepSucceeds'):
                scenario['job']=completed
            r.fulfill(json=scenario['job'])
        page.route(job_url,serve_job)
        page.route(job_url+'/*',serve_action)
        history_url='http://127.0.0.1:4178/test-api/integrations/gam/line-items/jobs?network=123456'
        page.route(history_url,lambda r:r.fulfill(json={'jobs':[{'id':completed['id'],'name':'Example direct campaign',
                   'status':'ready','count':1,'createdAt':completed['createdAt']}]}))
        page.get_by_role('button',name='Osveži poslove',exact=True).click()
        expect(page.get_by_role('button',name='Otvori posao',exact=True)).to_have_count(1)
        page.get_by_role('button',name='Otvori posao',exact=True).click()
        page.get_by_role('heading',name='Provera nije završena',exact=True).wait_for()
        review=page.locator('.gam-li-review')
        expect(review.get_by_role('columnheader',name='Urađeno',exact=True)).to_be_visible()
        expect(review.get_by_role('columnheader',name='Nedostaje',exact=True)).to_be_visible()
        expect(review.get_by_role('columnheader',name='Čeka proveru',exact=True)).to_be_visible()
        assert review.get_by_text('konflikata. Ispravite izbor',exact=False).count()==0
        assert page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).count()==0
        assert page.get_by_role('button',name='Nastavi posao',exact=True).count()==0
        retry=page.get_by_role('button',name='Ponovi proveru istog posla',exact=True)
        retry.click()
        expect(retry).to_be_enabled()
        assert len(action_calls)==1 and action_calls[0]['action']=='review'
        page.get_by_role('heading',name='Provera nije završena',exact=True).wait_for()
        assert page.get_by_label('Naziv line itema',exact=True).input_value()=='Example direct campaign'
        assert page.get_by_label('GAM mreža za line iteme',exact=True).input_value()=='123456'
        for width,height,label in [(1440,1080,'desktop'),(390,844,'mobile')]:
            page.set_viewport_size({'width':width,'height':height})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            review.scroll_into_view_if_needed()
            review.screenshot(path=str(out/f'line-items-verification-{label}.png'))
            if width==390:
                table=review.locator('.gam-table-wrap').first
                table.evaluate('(element) => element.scrollLeft = element.scrollWidth')
                expect(review.get_by_role('columnheader',name='Čeka proveru',exact=True)).to_be_in_viewport()
                review.screenshot(path=str(out/'line-items-verification-mobile-counts.png'))
                table.evaluate('(element) => element.scrollLeft = 0')
        retry.click()
        page.get_by_role('heading',name='Spremno za potvrdu',exact=True).wait_for()
        assert len(action_calls)==2 and all(c['action']=='review' for c in action_calls)
        assert review.get_by_text('✓ Urađeno · postoji u GAM-u',exact=True).count()==1
        assert not page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).is_enabled()
        review.screenshot(path=str(out/'line-items-rechecked-mobile.png'))
        # A genuine mismatch remains a conflict and cannot authorize creation.
        conflict=deepcopy(verified)
        conflict.update(canStart=False,conflictCount=1,conflicts=[{'ref':'lineItem:0','message':'Postojeći line item ima drugačiju cenu.'}])
        conflict['counts']['lineItem'].update(done=0,existing=0,conflict=1)
        scenario['job']=conflict
        page.get_by_role('button',name='Otvori posao',exact=True).click()
        expect(review).to_contain_text('1 konflikata.')
        assert page.get_by_role('button',name='Kreiraj potvrđenu postavku',exact=True).count()==0
        # A creating job whose pre-write read failed can retry one step
        # explicitly. Another read failure stops again, without an auto loop.
        creating_unverified=deepcopy(unverified)
        creating_unverified.update(status='creating')
        scenario['job']=creating_unverified
        page.get_by_role('button',name='Otvori posao',exact=True).click()
        before_steps=len(action_calls)
        page.get_by_role('button',name='Nastavi posao',exact=True).click()
        expect(page.get_by_role('button',name='Nastavi posao',exact=True)).to_be_enabled()
        assert len(action_calls)==before_steps+1 and action_calls[-1]['action']=='step'
        scenario['stepSucceeds']=True
        page.get_by_role('button',name='Nastavi posao',exact=True).click()
        page.get_by_role('heading',name='Završeno',exact=True).wait_for()
        assert len(action_calls)==before_steps+2 and action_calls[-1]['action']=='step'
        # Reusing an active plan must only open it; even one-click may not
        # automatically step/check/start the returned saved job.
        active=deepcopy(verified)
        active.update(status='creating',resumed=True,awaitingCheck=False)
        scenario['job']=active
        preview_url='http://127.0.0.1:4178/test-api/integrations/gam/line-items/preview'
        def resumed_preview(r):r.fulfill(json=active)
        page.route(preview_url,resumed_preview)
        before_actions=len(action_calls)
        page.get_by_role('button',name='Proveri postavku u GAM-u',exact=True).click()
        page.get_by_role('heading',name='U toku / može da se nastavi',exact=True).wait_for()
        assert len(action_calls)==before_actions
        pending=deepcopy(active)
        pending.update(awaitingCheck=True,error='Ishod poslednjeg upisa nije potvrđen.')
        scenario['job']=pending
        page.get_by_role('button',name='Otvori posao',exact=True).click()
        pending_check=page.get_by_role('button',name='Proveri ishod u GAM-u',exact=True)
        expect(pending_check).to_be_enabled()
        assert page.get_by_role('button',name='Nastavi posao',exact=True).count()==0
        assert len(action_calls)==before_actions
        pending_check.click()
        expect(pending_check).to_be_enabled()
        assert len(action_calls)==before_actions+1 and action_calls[-1]['action']=='check'
        before_actions=len(action_calls)
        scenario['job']=active
        page.reload()
        page.get_by_role('button',name='Line itemi',exact=True).click()
        page.get_by_role('button',name='Pokreni i napravi',exact=True).click()
        page.get_by_role('heading',name='U toku / može da se nastavi',exact=True).wait_for()
        assert len(action_calls)==before_actions
        page.unroute(preview_url,resumed_preview)
        # A different active plan offers its saved job without throwing away
        # the entered draft or silently submitting a second job.
        def active_conflict(r):r.fulfill(status=409,json={'error':'Drugi posao je već aktivan.','activeJobId':completed['id']})
        page.route(preview_url,active_conflict)
        page.reload()
        page.get_by_role('button',name='Line itemi',exact=True).click()
        page.get_by_role('button',name='Pokreni i napravi',exact=True).click()
        page.get_by_role('button',name='Otvori postojeći posao',exact=True).click()
        page.get_by_role('heading',name='U toku / može da se nastavi',exact=True).wait_for()
        assert len(action_calls)==before_actions
        page.unroute(preview_url,active_conflict)
        page.unroute(job_url,serve_job)
        page.unroute(job_url+'/*',serve_action)
        page.unroute(history_url)
        page.reload()
        page.get_by_role('button',name='Line itemi',exact=True).click()
        page.get_by_role('button',name='Otvori posao',exact=True).first.wait_for()
        assert page.get_by_role('button',name='Otvori posao',exact=True).count()==4
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
        (out/'result.json').write_text(json.dumps({'passed':True,'pageErrors':errors,'externalRequests':external,
            'requests':requests,'manualRecoveryActions':action_calls,
            'recoveryScope':'Compiled UI with local job-response fixtures; normal flows use the actual local handler.',
            'browserVersion':browser.version},indent=2))
        print('PASS untouched script preset, one-click creation, same-job verification retry, completed/missing/unverified/conflict counts, active-job reuse without automatic writes, desktop/mobile recovery, Prebid and ordinary line items, saved jobs, explicit review/create, paths/history, connection-first navigation and setup recheck')
finally:
    if process:process.terminate();process.wait(timeout=10)
