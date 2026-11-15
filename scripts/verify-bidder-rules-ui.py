"""Bidder eligibility editor: native React + authenticated Worker, synthetic only."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/bidder-rules-ui-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://bidder-rules.fixture.invalid';endpoint='/api/publishers/audit-site/bidder-rules'
checks=[]
with sync_playwright() as playwright:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=playwright.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/bidder-rules-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(process.stdout.readline());assert ready['ready']
   page=browser.new_page(viewport={'width':width,'height':900});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   pending=[];faults={'holdGet':True,'holdPost':False}
   def send(path,body=None,headers=None):
    process.stdin.write(json.dumps({'path':path,'method':'POST' if body is not None else 'GET','body':json.dumps(body) if body is not None else None,'headers':headers or {}})+'\n');process.stdin.flush()
    value=json.loads(process.stdout.readline());assert 'error' not in value,value;return value
   def data(path=endpoint,body=None):
    value=send(path,body);payload=json.loads(base64.b64decode(value['body']));assert value['status']==200,payload;return payload
   def fulfill(route,failure=None):
    req=route.request
    if failure:result={'status':503,'headers':{'content-type':'application/json'},'body':base64.b64encode(json.dumps({'error':failure}).encode()).decode()}
    else:
     process.stdin.write(json.dumps({'path':urlsplit(req.url).path,'method':req.method,'body':req.post_data})+'\n');process.stdin.flush();result=json.loads(process.stdout.readline());assert 'error' not in result,result
    route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   def route(request):
    req=request.request;url=urlsplit(req.url);assert url.netloc=='bidder-rules.fixture.invalid','External request blocked'
    if url.path==endpoint and req.method=='GET' and faults['holdGet']:faults['holdGet']=False;pending.append(request)
    elif url.path==endpoint and req.method=='POST' and faults['holdPost']:faults['holdPost']=False;pending.append(request)
    else:fulfill(request)
   page.route('**/*',route)
   def screen(name):
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth+1'),'Horizontal overflow'
    page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   panel=page.get_by_role('region',name='Bidder rules',exact=True)
   save=panel.get_by_role('button',name='Save bidder rules',exact=True)
   decision=panel.get_by_role('status',name='Rule preview')
   def preview(country=None,viewport=None,code=None):
    if country is not None:panel.get_by_role('textbox',name='Preview country',exact=True).fill(country)
    if viewport is not None:panel.get_by_role('textbox',name='Preview viewport width',exact=True).fill(str(viewport))
    if code is not None:panel.get_by_role('combobox',name='Preview position').select_option(code)
   try:
    page.goto(origin,wait_until='domcontentloaded');expect(panel.get_by_role('status')).to_contain_text('Loading');screen('loading')
    fulfill(pending.pop(),'Synthetic load unavailable.');expect(panel.get_by_role('alert')).to_contain_text('Synthetic load');screen('load-error')
    panel.get_by_role('button',name='Reload saved settings').click();expect(panel.get_by_role('checkbox',name='Enable bidder rules for this site')).not_to_be_checked();expect(save).to_be_disabled()
    expect(page.get_by_role('navigation',name='Demand settings')).to_be_visible();expect(panel).to_contain_text('3.22.0');screen('defaults')
    panel.get_by_role('checkbox',name='Enable bidder rules for this site').check();panel.get_by_role('button',name='Add bidder rule').click()
    panel.get_by_role('combobox',name='Bidder for rule 1').select_option('pubmatic')
    panel.get_by_role('textbox',name='Rule 1 name',exact=True).fill('Serbia desktop')
    panel.get_by_role('combobox',name='Country policy for rule 1').select_option('include')
    codes=panel.get_by_role('textbox',name='Country codes for rule 1',exact=True);codes.fill('rs, BA')
    panel.get_by_role('combobox',name='Unknown country for rule 1').select_option('skip')
    rule1=panel.get_by_role('article',name='Rule 1',exact=True)
    rule1.get_by_role('checkbox',name='Mobile · below 768px').uncheck();rule1.get_by_role('checkbox',name='Tablet · 768–1023px').uncheck()
    panel.get_by_role('combobox',name='Preview bidder').select_option('pubmatic')
    preview('RS',1024,'P1');expect(decision).to_contain_text('Eligible');expect(decision).to_contain_text('Serbia desktop')
    preview('DE');expect(decision).to_contain_text('Skipped');expect(decision).to_contain_text('country is excluded')
    panel.get_by_role('combobox',name='Country policy for rule 1').select_option('exclude');expect(decision).to_contain_text('Eligible')
    preview('RS');expect(decision).to_contain_text('Skipped');panel.get_by_role('combobox',name='Country policy for rule 1').select_option('include')
    preview('');expect(decision).to_contain_text('Country is unknown');expect(decision).to_contain_text('Skipped')
    panel.get_by_role('combobox',name='Unknown country for rule 1').select_option('allow');expect(decision).to_contain_text('Eligible')
    panel.get_by_role('combobox',name='Unknown country for rule 1').select_option('skip')
    preview('RS',1023);expect(decision).to_contain_text('Skipped');expect(decision).to_contain_text('tablet')
    preview(viewport=1024);expect(decision).to_contain_text('Eligible');screen('configured')
    # A selected-position rule overrides the All positions rule, including dotted IDs.
    panel.get_by_role('button',name='Add bidder rule').click();panel.get_by_role('textbox',name='Rule 2 name',exact=True).fill('Mobile placement')
    panel.get_by_role('combobox',name='Bidder for rule 2').select_option('pubmatic')
    panel.get_by_role('combobox',name='Positions for rule 2').select_option('selected')
    rule2=panel.get_by_role('article',name='Rule 2',exact=True);rule2.get_by_role('checkbox',name='m.box_1',exact=True).check()
    rule2.get_by_role('checkbox',name='Tablet · 768–1023px').uncheck();rule2.get_by_role('checkbox',name='Desktop · 1024px and above').uncheck()
    preview('DE',767,'m.box_1');expect(decision).to_contain_text('Eligible');expect(decision).to_contain_text('Mobile placement')
    preview(viewport=768);expect(decision).to_contain_text('Skipped');expect(decision).to_contain_text('tablet')
    preview(viewport='');expect(decision).to_contain_text('Viewport width is unknown')
    preview('RS',1024,'P1');screen('position-override')
    faults['holdPost']=True;save.click();expect(panel.get_by_role('button',name='Saving…')).to_be_disabled();expect(codes).to_be_disabled();expect(panel.get_by_role('button',name='Add bidder rule')).to_be_disabled();screen('saving')
    fulfill(pending.pop(),'Synthetic save unavailable. Retry your edits.');expect(panel.get_by_role('alert')).to_contain_text('Synthetic save');expect(panel.get_by_role('alert')).to_be_in_viewport();expect(codes).to_have_value('rs, BA');expect(save).to_be_enabled();screen('save-error')
    save.click();expect(panel.get_by_text('Saved. Generate a new script',exact=False)).to_be_visible();expect(save).to_be_disabled()
    saved=data()['settings'];assert saved['enabled'];assert saved['rules'][0]['countries']['values']==['BA','RS'];assert saved['rules'][1]['positions']==['m.box_1'];assert saved['rules'][1]['devices']==['mobile']
    page.reload();expect(codes).to_have_value('BA, RS');expect(save).to_be_disabled();screen('reloaded')
    # Invalid edits do not reach persistence. Overlapping policies are not silently ordered.
    codes.fill('ZZ');save.click();expect(panel.get_by_role('alert')).to_contain_text('not a supported');expect(codes).to_have_value('ZZ');assert data()['settings']==saved
    codes.fill('RS');panel.get_by_role('button',name='Add bidder rule').click();panel.get_by_role('combobox',name='Bidder for rule 3').select_option('pubmatic');save.click();expect(panel.get_by_role('alert')).to_contain_text('only one enabled rule for All positions');assert data()['settings']==saved;screen('overlap')
    panel.get_by_role('button',name='Remove rule 3').click();data('/__fixture/stale',{});save.click();expect(panel.get_by_role('alert')).to_contain_text('Site settings changed');expect(panel.get_by_role('alert')).to_be_in_viewport();expect(codes).to_have_value('RS');screen('stale')
    panel.get_by_role('button',name='Reload saved settings').click();expect(codes).to_have_value('BA, RS');expect(save).to_be_disabled()
    panel.get_by_role('checkbox',name='Enable bidder rules for this site').uncheck();save.click();expect(panel.get_by_text('Saved. Generate a new script',exact=False)).to_be_visible();assert data()['settings']['enabled'] is False;assert data()['settings']['rules']==saved['rules']
    panel.get_by_role('button',name='Add bidder rule').click();panel.get_by_role('textbox',name='Rule 3 name',exact=True).fill('Unsaved');panel.get_by_role('button',name='Reset changes').click();expect(panel.get_by_role('textbox',name='Rule 3 name',exact=True)).to_have_count(0)
    data('/__fixture/remove-bidder',{});page.reload();expect(panel.get_by_role('combobox',name='Bidder for rule 1')).to_have_value('pubmatic');expect(panel.get_by_text('This bidder is not configured or is disabled. The rule is kept; it does not activate a bidder.')).to_have_count(2);expect(panel.get_by_role('checkbox',name='m.box_1 · not configured',exact=True)).to_be_checked();screen('orphan-preserved')
    assert not errors,errors
    no_auth=send(endpoint,{'revision':data()['revision'],'settings':saved},{'cookie':''});assert no_auth['status']==401
    cross=send(endpoint,{'revision':data()['revision'],'settings':saved},{'origin':'https://other.invalid'});assert cross['status']==403
    checks.append({'width':width,'checks':['load/retry','default-off','country-include/exclude','unknown-allow/skip','viewport-boundaries','specific-over-default','dotted-position','pending-lock','save-error-preserves','save/reload','invalid-country','overlap','stale/reload','off-preserves','reset','orphan-bidder/position-visible','auth/origin','no-overflow','zero-page-errors'],'pass':True})
   finally:
    page.close();process.stdin.close();process.wait(timeout=15)
 finally:browser.close()
(out/'results.json').write_text(json.dumps({'checks':checks},indent=2)+'\n');print(json.dumps({'checks':checks},indent=2))
