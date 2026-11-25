"""Actual MAIN App bundle and real local GAM handler; no external requests or credentials."""
import json,os,subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/gam-ui-evidence/main';out.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:4187'
evidence=[]
def choose_add_only_subset(page):
 page.get_by_role('button',name='Poništi izbor',exact=True).click()
 page.get_by_role('checkbox',name='Uključi ključ aq_bid_origin',exact=True).check()
 page.get_by_role('checkbox',name='Uključi ključ geo_country',exact=True).check()
 origin_card=page.locator('.gam-kv-key').filter(has=page.get_by_role('checkbox',name='Uključi ključ aq_bid_origin',exact=True))
 origin_card.locator('summary').click()
 page.get_by_role('checkbox',name='aq_bid_origin: fresh',exact=True).uncheck()
 page.get_by_role('checkbox',name='aq_bid_origin: none',exact=True).uncheck()
 country=page.locator('.gam-kv-key').filter(has=page.get_by_role('checkbox',name='Uključi ključ geo_country',exact=True))
 country.locator('summary').click()
 page.get_by_role('button',name='Bez vrednosti za geo_country',exact=True).click()
 page.get_by_label('Pretraži vrednosti za geo_country',exact=True).fill('RS')
 page.get_by_role('checkbox',name='geo_country: RS',exact=True).check()

def verify_during_existing_creatives(browser):
 cases=[]
 for width,height in [(1440,1080),(390,844)]:
  server=subprocess.Popen(['node','scripts/gam-main-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True,env={**os.environ,'GAM_MAIN_BLOCKER':'creative','GAM_MAIN_SEED_OFF':'1'})
  context=None
  try:
   assert 'ready' in server.stdout.readline()
   context=browser.new_context(viewport={'width':width,'height':height})
   page=context.new_page();errors=[];external=[];requests=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   def local_only(route):
    if not route.request.url.startswith(origin+'/'):external.append(route.request.url);route.abort()
    else:route.continue_()
   page.route('**/*',local_only)
   page.on('request',lambda request:requests.append({'method':request.method,'url':request.url}))
   page.goto(origin+'/?section=integrations')
   page.get_by_role('button',name='Key-values',exact=True).click()
   preview=page.get_by_role('button',name='Proveri izabrane key-values u GAM-u',exact=True)
   expect(preview).to_be_enabled();choose_add_only_subset(page)
   baseline=page.request.get(origin+'/__fixture__/state').json()
   old=json.loads(baseline['blockerRaw']);old_id=old['id']
   assert old['status']=='creating' and old['phase']=='creative'
   assert 'reporting' not in old['plan']
   assert 0<len(baseline['adObjects']['creative'])<200
   assert baseline['adObjects']['lineItem']==[] and baseline['adObjects']['association']==[]
   assert json.loads(baseline['networkLock'])['owner']==old_id
   first_request=len(requests);preview.click()
   status=page.get_by_label('Status key-values posla',exact=True)
   expect(status.get_by_role('heading',name='Provera je završena — spremno za potvrdu',exact=True)).to_be_visible(timeout=30000)
   related=page.get_by_label('Postojeći oglasni posao — samo čitanje',exact=True)
   expect(related).to_be_visible();expect(related).to_contain_text(old_id)
   expect(related).to_contain_text('Dodavanje key-values ne menja postojeći Prebid posao')
   assert related.get_by_role('button').count()==0
   expect(page.get_by_label('Rezultat key-values posla',exact=True)).to_contain_text('reporting je OFF i ostaje OFF')
   assert page.request.get(origin+'/__fixture__/state').json()==baseline,'Preview must not touch GAM or the existing job'
   page.get_by_role('checkbox',name='Potvrđujem dodavanje nedostajućih stavki iz izbora 2 ključeva i 2 vrednosti u GAM mreži 123456. Postojeća podešavanja ostaju bez izmene.',exact=True).check()
   page.get_by_role('button',name='Pokreni pripremu key-values',exact=True).click()
   expect(status.get_by_role('heading',name='Priprema je završena',exact=True)).to_be_visible(timeout=60000)
   result=page.get_by_label('Rezultat key-values posla',exact=True)
   expect(result).to_contain_text('Ključevi: 1 kreirano · 1 već postoji — bez izmene')
   expect(result).to_contain_text('reporting je OFF i ostaje OFF')
   state=page.request.get(origin+'/__fixture__/state').json()
   assert state['blockerRaw']==baseline['blockerRaw'],'The exact existing ad snapshot must remain unchanged'
   assert state['networkLock']==baseline['networkLock'],'The original ad reservation must remain unchanged'
   assert state['adObjects']==baseline['adObjects'],'No ad entities may be created or changed'
   for key in baseline['keys']:assert next(item for item in state['keys'] if item['id']==key['id'])==key
   for value in baseline['values']:assert next(item for item in state['values'] if item['id']==value['id'])==value
   assert len(state['keys'])==len(baseline['keys'])+1 and len(state['values'])==len(baseline['values'])+2
   writes=state['writes'][len(baseline['writes']):]
   assert writes and all(write['kind'] in ['key','value'] and write.get('operation')!='update' for write in writes)
   assert not [item for item in requests[first_request:] if item['method']=='POST' and f'/line-items/jobs/{old_id}' in item['url']]
   assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
   assert not errors,errors
   assert not external,external
   page.screenshot(path=str(out/f'during-existing-creatives-{width}.png'),full_page=False)
   cases.append({'case':'complete-additions-during-existing-creatives','width':width,'passed':True,'oldJobAndGlobalReservationExactlyUnchanged':True,'existingMetadataPreserved':True,'adEntitiesChanged':0,'pageErrors':errors,'externalRequests':external})
  finally:
   if context:context.close()
   server.terminate();server.wait(timeout=10)
 return cases

def verify_add_only_safety(browser):
 cases=[]
 for blocker_mode in ['preview','creating']:
  for width,height in [(1440,1080),(390,844)]:
   server=subprocess.Popen(['node','scripts/gam-main-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True,env={**os.environ,'GAM_MAIN_BLOCKER':blocker_mode,'GAM_MAIN_SEED_OFF':'1'})
   context=None
   try:
    assert 'ready' in server.stdout.readline()
    context=browser.new_context(viewport={'width':width,'height':height})
    page=context.new_page();errors=[];external=[];requests=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    def local_only(route):
     if not route.request.url.startswith(origin+'/'):external.append(route.request.url);route.abort()
     else:route.continue_()
    page.route('**/*',local_only)
    page.on('request',lambda request:requests.append({'method':request.method,'url':request.url}))
    page.goto(origin+'/?section=integrations')
    page.get_by_role('button',name='Key-values',exact=True).click()
    preview=page.get_by_role('button',name='Proveri izabrane key-values u GAM-u',exact=True)
    expect(preview).to_be_enabled()
    expect(page.get_by_text('Dodaju se samo nedostajući ključevi i vrednosti; postojeća podešavanja ostaju bez izmene.',exact=True)).to_be_visible()
    page.get_by_role('button',name='Poništi izbor',exact=True).click()
    page.get_by_role('checkbox',name='Uključi ključ aq_bid_origin',exact=True).check()
    page.get_by_role('checkbox',name='Uključi ključ geo_country',exact=True).check()
    origin_card=page.locator('.gam-kv-key').filter(has=page.get_by_role('checkbox',name='Uključi ključ aq_bid_origin',exact=True))
    origin_card.locator('summary').click()
    page.get_by_role('checkbox',name='aq_bid_origin: fresh',exact=True).uncheck()
    page.get_by_role('checkbox',name='aq_bid_origin: none',exact=True).uncheck()
    country=page.locator('.gam-kv-key').filter(has=page.get_by_role('checkbox',name='Uključi ključ geo_country',exact=True))
    country.locator('summary').click()
    page.get_by_role('button',name='Bez vrednosti za geo_country',exact=True).click()
    page.get_by_label('Pretraži vrednosti za geo_country',exact=True).fill('RS')
    page.get_by_role('checkbox',name='geo_country: RS',exact=True).check()
    baseline=page.request.get(origin+'/__fixture__/state').json()
    assert baseline['writes']==[]
    before_requests=len(requests);preview.click()
    blocker=page.get_by_label('Aktivni posao — samo čitanje',exact=True)
    expect(blocker).to_be_visible();expect(blocker).to_contain_text('Ova nova priprema nije pokrenuta')
    expect(blocker).to_contain_text('Prebid postavka')
    assert page.get_by_role('button',name='Key-values',exact=True).get_attribute('aria-current')=='page'
    assert not [item for item in requests[before_requests:] if item['method']=='POST' and item['url'].endswith(('/start','/step','/cancel','/close-preview'))]
    assert page.request.get(origin+'/__fixture__/state').json()['writes']==[]
    assert page.get_by_role('button',name='Nastavi posao',exact=True).count()==0
    assert page.get_by_role('button',name='Pokreni pripremu key-values',exact=True).count()==0
    if blocker_mode=='creating':
     assert page.get_by_role('button',name='Zatvori nepočeti pregled',exact=True).count()==0
     page.get_by_role('button',name='Osveži aktivni posao bez izmene',exact=True).click()
     expect(blocker).to_be_visible()
     state=page.request.get(origin+'/__fixture__/state').json()
     assert state==baseline
    else:
     close=page.get_by_role('button',name='Zatvori nepočeti pregled',exact=True)
     expect(close).to_be_disabled()
     page.get_by_role('checkbox',name='Potvrđujem zatvaranje nepočetog pregleda ',exact=False).check()
     close.click()
     expect(page.get_by_text('Nepočeti pregled je zatvoren.',exact=False)).to_be_visible()
     state=page.request.get(origin+'/__fixture__/state').json()
     assert state['blocker']['status']=='cancelled'
     assert state['keys']==baseline['keys'] and state['values']==baseline['values'] and state['writes']==[]
     expect(page.locator('.gam-kv-selected-count')).to_have_text('2 ključeva · 2 vrednosti')
     assert len([item for item in requests[before_requests:] if item['method']=='POST' and item['url'].endswith('/line-items/preview')])==1,'Closing cannot silently create another plan'
     preview.click()
     status=page.get_by_label('Status key-values posla',exact=True)
     expect(status.get_by_role('heading',name='Provera je završena — spremno za potvrdu',exact=True)).to_be_visible()
     expect(page.get_by_label('Rezultat key-values posla',exact=True)).to_contain_text('reporting je OFF i ostaje OFF')
     page.get_by_role('checkbox',name='Potvrđujem dodavanje nedostajućih stavki iz izbora 2 ključeva i 2 vrednosti u GAM mreži 123456. Postojeća podešavanja ostaju bez izmene.',exact=True).check()
     page.get_by_role('button',name='Pokreni pripremu key-values',exact=True).click()
     expect(status.get_by_role('heading',name='Priprema je završena',exact=True)).to_be_visible(timeout=60000)
     result=page.get_by_label('Rezultat key-values posla',exact=True)
     expect(result).to_contain_text('Ključevi: 1 kreirano · 1 već postoji — bez izmene')
     state=page.request.get(origin+'/__fixture__/state').json()
     for key in baseline['keys']:assert next(item for item in state['keys'] if item['id']==key['id'])==key
     for value in baseline['values']:assert next(item for item in state['values'] if item['id']==value['id'])==value
     assert len(state['keys'])==len(baseline['keys'])+1
     assert len(state['values'])==len(baseline['values'])+2
     assert all(write['kind'] in ['key','value'] and write.get('operation')!='update' for write in state['writes'])
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    assert not errors,errors
    assert not external,external
    page.screenshot(path=str(out/f'add-only-{blocker_mode}-{width}.png'),full_page=False)
    cases.append({'case':blocker_mode,'width':width,'passed':True,'pageErrors':errors,'externalRequests':external,'existingMetadataPreserved':True,'automaticExistingJobWrites':0})
   finally:
    if context:context.close()
    server.terminate();server.wait(timeout=10)
 return cases

def verify_testid_selection(browser, identity_key='TestId'):
 cases=[]
 for width,height in [(1440,1080),(390,844)]:
  server=subprocess.Popen(['node','scripts/gam-main-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
  context=None
  try:
   assert 'ready' in server.stdout.readline()
   context=browser.new_context(viewport={'width':width,'height':height})
   page=context.new_page();errors=[];external=[]
   page.on('pageerror',lambda error:errors.append(str(error)))
   def local_only(route):
    if not route.request.url.startswith(origin+'/'):external.append(route.request.url);route.abort()
    else:route.continue_()
   page.route('**/*',local_only)
   page.goto(origin+'/?section=integrations')
   page.get_by_role('button',name='Key-values',exact=True).click()
   preview=page.get_by_role('button',name='Proveri izabrane key-values u GAM-u',exact=True)
   expect(preview).to_be_enabled()
   # Use only the A/B catalog rows, keep pasted IDs across preset/opt-out,
   # and prove the exact request reaches the real local add-only handler.
   page.get_by_role('button',name='Samo A/B oznake',exact=True).click()
   page.get_by_role('checkbox',name='Uključi ključ '+('VersionId' if identity_key=='TestId' else 'TestId'),exact=True).uncheck()
   expect(page.locator('.gam-kv-selected-count')).to_have_text('2 ključeva · 2 vrednosti')
   testid_card=page.locator('.gam-kv-key').filter(has=page.get_by_role('checkbox',name='Uključi ključ '+identity_key,exact=True))
   testid_card.locator('summary').click()
   testid_input=page.get_by_label(identity_key+' vrednosti',exact=True)
   testid_input.fill('Bad-ID');expect(preview).to_be_disabled()
   testid_input.fill('main_ab_1,\nmain_ab_2, main_ab_1')
   expect(page.locator('.gam-kv-selected-count')).to_have_text('2 ključeva · 4 vrednosti')
   page.get_by_role('button',name='Poništi izbor',exact=True).click();expect(preview).to_be_disabled()
   page.get_by_role('button',name='Samo A/B oznake',exact=True).click()
   page.get_by_role('checkbox',name='Uključi ključ '+('VersionId' if identity_key=='TestId' else 'TestId'),exact=True).uncheck()
   expect(testid_input).to_have_value('main_ab_1,\nmain_ab_2, main_ab_1')
   page.get_by_role('button',name='Izaberi sve',exact=True).click()
   expect(testid_input).to_have_value('main_ab_1,\nmain_ab_2, main_ab_1')
   page.get_by_role('button',name='Samo A/B oznake',exact=True).click()
   page.get_by_role('checkbox',name='Uključi ključ '+('VersionId' if identity_key=='TestId' else 'TestId'),exact=True).uncheck()
   expect(page.locator('.gam-kv-selected-count')).to_have_text('2 ključeva · 4 vrednosti')
   page.get_by_role('button',name='Samo tri nove oznake',exact=True).click()
   expect(testid_input).to_have_value('main_ab_1,\nmain_ab_2, main_ab_1')
   expect(testid_input).to_be_disabled()
   page.get_by_role('button',name='Samo A/B oznake',exact=True).click()
   page.get_by_role('checkbox',name='Uključi ključ '+('VersionId' if identity_key=='TestId' else 'TestId'),exact=True).uncheck()
   expect(testid_input).to_have_value('main_ab_1,\nmain_ab_2, main_ab_1')
   expect(page.locator('.gam-kv-selected-count')).to_have_text('2 ključeva · 4 vrednosti')
   page.get_by_role('checkbox',name='Uključi ključ '+identity_key,exact=True).uncheck()
   expect(page.locator('.gam-kv-selected-count')).to_have_text('1 ključeva · 2 vrednosti')
   page.get_by_role('checkbox',name='Uključi ključ '+identity_key,exact=True).check()
   testid_input.scroll_into_view_if_needed()
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
   page.screenshot(path=str(out/f'{identity_key.lower()}-selection-{width}.png'),full_page=False)
   with page.expect_request(lambda request: request.url.endswith('/line-items/preview') and request.method=='POST') as submitted:
    preview.click()
   assert json.loads(submitted.value.post_data)['reportingSelection']==[
    {'key':'Variant','values':['A','B']},{'key':identity_key,'values':['main_ab_1','main_ab_2']}]
   page.get_by_role('heading',name='Provera je završena — spremno za potvrdu',exact=True).wait_for()
   before_testid=page.request.get(origin+'/__fixture__/state').json()
   assert not before_testid['keys'] and not before_testid['values'],'Preview must not write GAM data'
   page.get_by_role('checkbox',name='Potvrđujem dodavanje nedostajućih stavki iz izbora 2 ključeva i 4 vrednosti u GAM mreži 123456. Postojeća podešavanja ostaju bez izmene.',exact=True).check()
   page.get_by_role('button',name='Pokreni pripremu key-values',exact=True).click()
   page.get_by_role('heading',name='Priprema je završena',exact=True).wait_for()
   testid_state=page.request.get(origin+'/__fixture__/state').json()
   assert {key['name'] for key in testid_state['keys']}=={'Variant',identity_key}
   testid_key=next(key for key in testid_state['keys'] if key['name']==identity_key)
   assert testid_key['type']=='PREDEFINED' and testid_key['reportableType']=='ON'
   assert {value['name'] for value in testid_state['values'] if value['customTargetingKeyId']==testid_key['id']}=={'main_ab_1','main_ab_2'}
   cases.append({'case':identity_key+' exact A/B selection and explicit add-only confirmation','width':width,'passed':True})
   assert not errors,errors
   assert not external,external
  finally:
   if context:context.close()
   server.terminate();server.wait(timeout=10)
 return cases

with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
 try:
  for width,height in [(1440,1080),(390,844)]:
   server=subprocess.Popen(['node','scripts/gam-main-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
   context=None
   try:
    assert 'ready' in server.stdout.readline()
    context=browser.new_context(viewport={'width':width,'height':height})
    page=context.new_page();errors=[];external=[];requests=[]
    page.on('pageerror',lambda error:errors.append(str(error)))
    def local_only(route):
     if not route.request.url.startswith(origin+'/'):external.append(route.request.url);route.abort()
     else:route.continue_()
    page.route('**/*',local_only)
    page.on('request',lambda request:requests.append({'method':request.method,'url':request.url}))
    page.goto(origin+'/?section=integrations')
    expect(page.get_by_role('heading',name='Google Ad Manager',exact=True)).to_be_visible()
    tab=page.get_by_role('button',name='Key-values',exact=True)
    expect(tab).to_be_visible();tab.click()
    expect(page.get_by_role('heading',name='Koji ključevi su ti potrebni?',exact=True)).to_be_visible()
    preview=page.get_by_role('button',name='Proveri izabrane key-values u GAM-u',exact=True)
    expect(preview).to_be_enabled()
    assert page.get_by_role('checkbox',name='Uključi ključ ',exact=False).count()==14
    page.screenshot(path=str(out/f'tab-{width}.png'),full_page=False)
    page.get_by_role('button',name='Poništi izbor',exact=True).click();expect(preview).to_be_disabled()
    page.get_by_role('checkbox',name='Uključi ključ aq_bid_origin',exact=True).check()
    page.get_by_role('checkbox',name='Uključi ključ geo_country',exact=True).check()
    origin_card=page.locator('.gam-kv-key').filter(has=page.get_by_role('checkbox',name='Uključi ključ aq_bid_origin',exact=True))
    origin_card.locator('summary').click()
    page.get_by_role('checkbox',name='aq_bid_origin: fresh',exact=True).uncheck()
    page.get_by_role('checkbox',name='aq_bid_origin: none',exact=True).uncheck()
    country=page.locator('.gam-kv-key').filter(has=page.get_by_role('checkbox',name='Uključi ključ geo_country',exact=True))
    country.locator('summary').click()
    page.get_by_role('button',name='Bez vrednosti za geo_country',exact=True).click()
    page.get_by_label('Pretraži vrednosti za geo_country',exact=True).fill('RS')
    page.get_by_role('checkbox',name='geo_country: RS',exact=True).check()
    expect(page.locator('.gam-kv-selected-count')).to_have_text('2 ključeva · 2 vrednosti')
    assert page.request.get(origin+'/__fixture__/state').json()['writes']==[]

    held={'preview':[],'review':[],'step':[],'pauseReview':True,'pauseStep':True}
    def hold_preview(route):held['preview'].append(route)
    def hold_review(route):
     if held['pauseReview']:held['review'].append(route)
     else:route.continue_()
    def hold_step(route):
     if held['pauseStep']:held['step'].append(route)
     else:route.continue_()
    page.route('**/line-items/jobs/*/review',hold_review)
    page.route('**/line-items/jobs/*/step',hold_step)
    page.route('**/line-items/preview',hold_preview)
    preview.click()
    status=page.get_by_label('Status key-values posla',exact=True)
    expect(status).to_be_visible();expect(status).to_have_attribute('aria-busy','true')
    def visible_status():
     expect(status.get_by_role('heading',level=3)).to_be_in_viewport(ratio=1)
     page.wait_for_function("""()=>{
       const heading=document.querySelector('[aria-label="Status key-values posla"] h3');
       const bar=document.querySelector('.global-topbar');
       if(!heading)return false;
       const bounds=heading.getBoundingClientRect(),headerBottom=bar?.getBoundingClientRect().bottom??0;
       return bounds.top>=headerBottom&&bounds.bottom<=innerHeight;
     }""",timeout=5000)
    visible_status()
    assert held['preview'],'Initial preview request must show feedback before a response arrives'
    assert page.request.get(origin+'/__fixture__/state').json()['writes']==[]
    page.screenshot(path=str(out/f'request-start-{width}.png'),full_page=False)
    page.unroute('**/line-items/preview',hold_preview)
    for route in held['preview']:route.continue_()
    expect(status).to_contain_text('Posao:')
    visible_status()
    assert held['review'],'The real handler review should be visibly in progress'
    assert status.get_by_role('heading',name='Priprema je završena',exact=True).count()==0
    page.screenshot(path=str(out/f'checking-{width}.png'),full_page=False)
    held['pauseReview']=False
    for route in held['review']:route.continue_()
    expect(status.get_by_role('heading',name='Provera je završena — spremno za potvrdu',exact=True)).to_be_visible()
    expect(status).to_have_attribute('aria-busy','false')
    assert page.request.get(origin+'/__fixture__/state').json()['writes']==[]
    page.get_by_role('checkbox',name='Potvrđujem dodavanje nedostajućih stavki iz izbora 2 ključeva i 2 vrednosti u GAM mreži 123456. Postojeća podešavanja ostaju bez izmene.',exact=True).check()
    page.get_by_role('button',name='Pokreni pripremu key-values',exact=True).click()
    expect(status).to_have_attribute('aria-busy','true')
    expect(page.get_by_role('progressbar',name='Potvrđeni key-values napredak',exact=True)).to_be_visible()
    visible_status()
    assert held['step'],'The actual write step should remain visible before its response'
    assert status.get_by_role('heading',name='Priprema je završena',exact=True).count()==0
    page.screenshot(path=str(out/f'creating-{width}.png'),full_page=False)
    held['pauseStep']=False
    for route in held['step']:route.continue_()
    expect(status.get_by_role('heading',name='Priprema je završena',exact=True)).to_be_visible(timeout=60000)
    expect(status).to_have_attribute('aria-busy','false')
    results=page.get_by_label('Rezultat key-values posla',exact=True)
    expect(results).to_contain_text('Ključevi: 2 kreirano')
    expect(results).to_contain_text('Vrednosti: 2 kreirano')
    expect(page.get_by_role('link',name='Otvori key-values u GAM-u',exact=True)).to_have_attribute('href','https://admanager.google.com/123456#inventory/custom_targeting/list')
    state=page.request.get(origin+'/__fixture__/state').json()
    assert {key['name'] for key in state['keys']}=={'aq_bid_origin','geo_country'}
    assert {value['name'] for value in state['values']}=={'cached','RS'}
    assert all(write['kind'] in ['key','value'] for write in state['writes'])
    results.scroll_into_view_if_needed();page.screenshot(path=str(out/f'completed-{width}.png'),full_page=False)
    before_reload=len(state['writes'])
    page.reload();page.get_by_role('button',name='Key-values',exact=True).click()
    page.get_by_role('button',name='Otvori key-values posao',exact=True).first.click()
    expect(page.get_by_label('Status key-values posla',exact=True).get_by_role('heading',name='Priprema je završena',exact=True)).to_be_visible()
    expect(page.get_by_label('Rezultat key-values posla',exact=True)).to_contain_text('Ključevi: 2 kreirano')
    expect(page.locator('.gam-kv-selected-count')).to_have_text('2 ključeva · 2 vrednosti')
    assert len(page.request.get(origin+'/__fixture__/state').json()['writes'])==before_reload
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
    assert not errors,errors
    assert not external,external
    page.screenshot(path=str(out/f'reopened-{width}.png'),full_page=False)
    evidence.append({'width':width,'passed':True,'pageErrors':errors,'externalRequests':external,'requests':requests,'createdKeys':2,'createdValues':2,'reopenWrites':0})
   finally:
    if context:context.close()
    server.terminate();server.wait(timeout=10)
  evidence.extend(verify_testid_selection(browser))
  evidence.extend(verify_testid_selection(browser, 'VersionId'))
  evidence.extend(verify_add_only_safety(browser))
  evidence.extend(verify_during_existing_creatives(browser))
 finally:browser.close()
(out/'result.json').write_text(json.dumps({'passed':True,'scope':'Actual MAIN App build, real local GAM handler; synthetic storage and Google only','cases':evidence},indent=2)+'\n')
print('PASS actual MAIN App: independent add-only completion beside partial legacy creatives, exact old job/lock/ad preservation, OFF metadata, progress, saved results and safe blockers at desktop/mobile')
