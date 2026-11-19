"""Actual MAIN App bundle and real local GAM handler; no external requests or credentials."""
import json,os,subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/gam-ui-evidence/main';out.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:4187'
evidence=[]
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
    assert page.get_by_role('checkbox',name='Uključi ključ ',exact=False).count()==12
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

    held={'review':[],'step':[],'pauseReview':True,'pauseStep':True}
    def hold_review(route):
     if held['pauseReview']:held['review'].append(route)
     else:route.continue_()
    def hold_step(route):
     if held['pauseStep']:held['step'].append(route)
     else:route.continue_()
    page.route('**/line-items/jobs/*/review',hold_review)
    page.route('**/line-items/jobs/*/step',hold_step)
    preview.click()
    status=page.get_by_label('Status key-values posla',exact=True)
    expect(status).to_be_visible();expect(status).to_have_attribute('aria-busy','true')
    expect(status).to_contain_text('Posao:')
    assert held['review'],'The real handler review should be visibly in progress'
    assert status.get_by_role('heading',name='Priprema je završena',exact=True).count()==0
    page.screenshot(path=str(out/f'checking-{width}.png'),full_page=False)
    held['pauseReview']=False
    for route in held['review']:route.continue_()
    expect(status.get_by_role('heading',name='Provera je završena — spremno za potvrdu',exact=True)).to_be_visible()
    expect(status).to_have_attribute('aria-busy','false')
    assert page.request.get(origin+'/__fixture__/state').json()['writes']==[]
    page.get_by_role('checkbox',name='Potvrđujem pripremu 2 ključeva i 2 vrednosti u GAM mreži 123456.',exact=True).check()
    page.get_by_role('button',name='Pokreni pripremu key-values',exact=True).click()
    expect(status).to_have_attribute('aria-busy','true')
    expect(page.get_by_role('progressbar',name='Potvrđeni key-values napredak',exact=True)).to_be_visible()
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
 finally:browser.close()
(out/'result.json').write_text(json.dumps({'passed':True,'scope':'Actual MAIN App build, real local GAM handler; synthetic storage and Google only','cases':evidence},indent=2)+'\n')
print('PASS actual MAIN App: visible Key-values tab, exact subset, live checking/creation progress, result and read-only reopen at desktop/mobile')
