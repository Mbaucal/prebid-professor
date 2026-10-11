"""Actual React dashboard; synthetic API, zero external traffic and no live saves."""
import copy,json,os,subprocess
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent;out=root/'.generated/deals-ui-evidence';out.mkdir(parents=True,exist_ok=True)
origin='http://127.0.0.1:4182'
child_env={k:v for k,v in os.environ.items() if 'proxy' not in k.lower()}
server=subprocess.Popen(['node','scripts/layout-ui-fixture.mjs'],cwd=root,env=child_env,stdout=subprocess.PIPE,text=True)
results=[]
try:
 assert 'ready' in server.stdout.readline()
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True,executable_path=os.environ.get('CHROMIUM_PATH'),args=['--no-sandbox'])
  for width in [1440,390]:
   page=browser.new_page(viewport={'width':width,'height':900});errors=[];external=[];saved={};state={'fail':False,'hold':False};pending=[]
   page.on('pageerror',lambda e:errors.append(str(e)))
   def payload(site):return {'revision':site+'-1','settings':saved.get(site,{'schemaVersion':1,'entries':[]}), 'bidders':[{'bidder':'pubmatic','enabled':True}],'units':[{'code':'P1','enabled':True}],'notice':'One selected bid per bidder and position.','validationIssue':None,'servingAvailable':False,'plan':{'entries':[{'id':e['id'],'name':e['name'],'startsAt':e['startsAt'],'endsAt':e['endsAt'],'inventory':[{'code':'P1','adUnitPath':'/123/test/P1','sizeMap':[{'viewport':[0,0],'sizes':[[300,250]]}]}],'priorityInstruction':'Configure agreed priority in GAM.','creativeAdIdMacro':'%%PATTERN:hb_adid_pubmatic%%','targeting':{'key':'hb_deal_pubmatic','value':e['dealId']},'eligibility':'Only current matching deal bids are eligible.'} for e in saved.get(site,{'entries':[]})['entries']]}}
   def route(r):
    path=urlparse(r.request.url).path
    if not r.request.url.startswith(origin+'/'):external.append(r.request.url);r.abort();return
    if path.endswith('/deals'):
     site=path.split('/')[3]
     if state['hold']:pending.append(r);return
     if state['fail']:r.fulfill(status=503,json={'error':'Synthetic save unavailable. Retry.'});return
     if r.request.method=='POST':saved[site]=r.request.post_data_json['settings'];r.fulfill(json={**payload(site),'changed':True});return
     r.fulfill(json=payload(site));return
    if path.endswith('/bidders'):r.fulfill(json={'bidders':[]});return
    if path.endswith('/bidder-overrides'):r.fulfill(json={'overrides':[]});return
    if path.endswith('/ad-units'):r.fulfill(json={'adUnits':[]});return
    if r.request.method!='GET':raise AssertionError('Unexpected mutation '+path)
    r.continue_()
   page.route('**/*',route)
   def open_deals():
    page.locator('.tabbar').get_by_role('button',name='Config',exact=True).click()
    groups=page.get_by_role('navigation',name='Configuration groups',exact=True)
    sections=page.get_by_role('navigation',name='Configuration sections',exact=True)
    expect(groups.or_(sections)).to_be_visible()
    if groups.is_visible():
     groups.get_by_role('button',name='Demand',exact=True).click()
     page.get_by_role('navigation',name='Demand settings').get_by_role('button',name='Bidders',exact=True).click()
    else:sections.get_by_role('button',name='Bidders & overrides',exact=True).click()
    expect(page.get_by_role('heading',name='Deals',exact=True)).to_be_visible()
   def record(name):
    assert not errors,errors;assert not external,external
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),name
    results.append({'case':name,'width':width,'passed':True})
   try:
    page.goto(origin);open_deals();page.get_by_role('button',name='Add deal',exact=True).click()
    panel=page.locator('section[aria-labelledby="deals-title"]')
    panel.get_by_label('Deal name',exact=True).fill('Fixture contract');panel.get_by_label('Bidder',exact=True).select_option('pubmatic');panel.get_by_label('Deal ID',exact=True).fill('0000199')
    panel.get_by_label('Starts (UTC)',exact=True).fill('2026-10-01T00:00');panel.get_by_label('Ends (UTC)',exact=True).fill('2027-01-01T00:00');panel.get_by_label('Active',exact=True).check()
    state['fail']=True;panel.get_by_role('button',name='Save deals',exact=True).click();expect(panel.get_by_role('alert')).to_have_text('Synthetic save unavailable. Retry.')
    expect(panel.get_by_label('Deal ID',exact=True)).to_have_value('0000199');record('error-retains-draft')
    state['fail']=False;panel.get_by_role('button',name='Save deals',exact=True).click();expect(panel.get_by_role('status')).to_contain_text('Deals saved')
    assert saved['site-1']['entries'][0]['dealId']=='0000199';record('save-string-id')
    panel.get_by_role('button',name='Reload saved deals',exact=True).click();expect(panel.get_by_label('Deal ID',exact=True)).to_have_value('0000199');record('reload')
    panel.get_by_text('Saved GAM plan · review only',exact=True).click();expect(panel).to_contain_text('300×250');expect(panel).to_contain_text('%%PATTERN:hb_adid_pubmatic%%');record('saved-plan-size-and-adid')
    panel.get_by_role('heading',name='Deals',exact=True).scroll_into_view_if_needed();page.screenshot(path=str(out/f'deals-{width}.png'),full_page=True)
    panel.get_by_label('Deal name',exact=True).evaluate('(element)=>element.scrollIntoView({block:"start"})');page.screenshot(path=str(out/f'deals-form-{width}.png'))
    state['hold']=True;panel.get_by_role('button',name='Save deals',exact=True).click();expect(panel.get_by_role('button',name='Save deals',exact=True)).to_be_disabled()
    page.wait_for_function('document.querySelector("section[aria-labelledby=deals-title]").getAttribute("aria-busy")==="true"')
    menu=page.get_by_role('button',name='Menu',exact=True)
    if menu.is_visible():menu.click()
    page.locator('.site-link').filter(has_text='site2.example.com').click();state['hold']=False
    # Site change replaces Config body; resolving A must never overwrite B.
    for request in pending:request.fulfill(status=503,json={'error':'Late site A failure'})
    pending.clear();open_deals();expect(page.locator('section[aria-labelledby="deals-title"]')).not_to_contain_text('Late site A failure');expect(page.get_by_role('button',name='Add deal',exact=True)).to_be_enabled();record('late-save-site-switch')
   finally:page.close()
  browser.close()
finally:server.terminate();server.wait(timeout=10)
(out/'results.json').write_text(json.dumps(results,indent=2)+'\n');print(json.dumps({'passed':len(results),'evidence':str(out)}))
