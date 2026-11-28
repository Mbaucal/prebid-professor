"""Independent account UI review: actual React and Worker, isolated SQLite, no remote ads."""
import argparse,base64,json,os,re,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

parser=argparse.ArgumentParser();parser.add_argument('--runtime',default='3.22.1');args=parser.parse_args()
root=Path(__file__).resolve().parent.parent
out=root/'.generated/review-mba413-ui';out.mkdir(parents=True,exist_ok=True)
origin='https://accounts-review.fixture.invalid';site='account-review-site';endpoint='/api/publishers/'+site+'/bidders'
results=[]
# Script versions that apply bidder accounts, from the registry.
def registry_labels(*capabilities):
 """The versions the admin names for these capabilities, read from the release registry by the shared rule
 (worker/site-runtime/script-versions.mjs): the smallest step and the newest without a runtime notice, one or two."""
 code="const {scriptVersionLabels}=await import('./worker/site-runtime/script-versions.mjs');console.log(JSON.stringify(scriptVersionLabels(JSON.parse(process.argv[1]))))"
 labels=json.loads(subprocess.run(['node','--input-type=module','-e',code,json.dumps(capabilities)],cwd=root,check=True,capture_output=True,text=True).stdout)
 assert 1<=len(labels)<=2,labels
 return labels
ACCOUNT_SCRIPT_VERSIONS=registry_labels('bidder-accounts')
ACCOUNT_SCRIPTS=' or '.join(ACCOUNT_SCRIPT_VERSIONS)
ACCOUNT_SELECTION='one of these versions' if len(ACCOUNT_SCRIPT_VERSIONS)>1 else 'that version'
custom={'ver':'1.0','complete':1,'nodes':[{'asi':'agency-seller.example','sid':'agency-42','hp':1}]}
with sync_playwright() as pw:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=pw.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/review-mba413-browser-fixture.mjs','--runtime='+args.runtime],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   ready=json.loads(proc.stdout.readline());assert ready['ready'] and ready['runtime']==args.runtime
   checks=[];requests=[];errors=[];external=[];hold=[];pending=[];reject=[];patch=[]
   page=browser.new_page(viewport={'width':width,'height':1000});page.on('pageerror',lambda error:errors.append(str(error)))
   def send(path,method='GET',body=None):
    proc.stdin.write(json.dumps({'path':path,'method':method,'body':None if body is None else json.dumps(body)})+'\n');proc.stdin.flush()
    value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
   def data(path):
    value=send(path);assert value['status']==200,value;return json.loads(base64.b64decode(value['body']))
   def fulfill(route):
    request=route.request;path=urlsplit(request.url).path
    value=send(path,request.method,json.loads(request.post_data) if request.post_data else None)
    requests.append({'path':path,'method':request.method,'status':value['status']})
    body=base64.b64decode(value['body'])
    # Payload fields for a saved state this fixture cannot reach (such as 3.24.0 with saved bid caching); None drops one.
    if patch and path==endpoint and request.method=='GET':body=json.dumps({k:v for k,v in {**json.loads(body),**patch[0]}.items() if v is not None}).encode()
    route.fulfill(status=value['status'],headers=value['headers'],body=body)
   def route(route):
    request=route.request;url=urlsplit(request.url)
    if url.netloc!='accounts-review.fixture.invalid':external.append(request.url);route.abort();return
    if reject and url.path==endpoint and request.method=='GET':
     reject.pop();route.fulfill(status=503,headers={'content-type':'application/json'},body=json.dumps({'error':'Synthetic list outage: retry.'}));return
    if hold and url.path==endpoint and request.method==hold[0]:pending.append(route);hold.pop();return
    fulfill(route)
   page.route('**/*',route)
   def passed(name):checks.append(name)
   def screen(name,target=None):
    if target is not None:target.scroll_into_view_if_needed()
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal page overflow'
    page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   def dialog():return page.get_by_role('dialog')
   def card(code):return page.locator('article.bidder-card').filter(has=page.locator('.bidder-card-heading code',has_text=re.compile('^'+re.escape(code)+'$')))
   def create(code,mode,params,name):
    page.get_by_role('button',name='＋ New bidder',exact=True).click()
    d=dialog();d.get_by_label('Bidder code',exact=False).fill(code);d.get_by_label('Base adapter',exact=True).fill('adf');d.get_by_label('Account name',exact=True).fill(name)
    d.get_by_label('Account SChain',exact=True).select_option(mode);d.get_by_label('Base params JSON',exact=False).fill(json.dumps(params))
    return d
   try:
    reject.append(True);page.goto(origin+'/',wait_until='domcontentloaded');expect(page.locator('.bidders-page .form-error')).to_contain_text('Synthetic list outage')
    screen('listing-error');passed('Listing failure is visible and recoverable')
    # The script versions are unknown after the failure: the account form names none and denies none.
    page.get_by_role('button',name='＋ New bidder',exact=True).click();d=dialog()
    expect(d.get_by_text('Aliases and account-specific SChain require',exact=False)).to_have_text('Aliases and account-specific SChain require a script version that applies bidder accounts with your other saved options. Existing scripts keep their saved settings.')
    expect(d).not_to_contain_text('No available script version');expect(d).not_to_contain_text('No corrected script version')
    d.get_by_role('button',name='Cancel',exact=True).click();expect(d).to_have_count(0);passed('After a listing failure the account form names no version and denies none')
    hold.append('GET');page.reload(wait_until='domcontentloaded');expect(page.locator('.bidders-page .config-loading')).to_be_visible();screen('listing-loading')
    assert len(pending)==1;fulfill(pending.pop());expect(card('pubmatic')).to_be_visible();expect(page.locator('.bidders-page .config-loading')).to_have_count(0)
    passed('Loading preserves the component and reload recovers the real API')
    d=create('adf_smn','inherit',{'mid':111},'SMN Adform')
    d.get_by_role('button',name='Create bidder',exact=True).click();expect(d).to_have_count(0);expect(card('adf_smn')).to_contain_text('Site chain')
    d=create('adf_ag','custom',{'mid':222},'Agency Adform')
    expect(d.get_by_text('Aliases and account-specific SChain require',exact=False)).to_have_text(f'Aliases and account-specific SChain require script {ACCOUNT_SCRIPTS}. Save the account, then explicitly select {ACCOUNT_SELECTION} in Script setup and generate a new package. Existing scripts keep their saved settings.')
    expect(d).not_to_contain_text('3.22.1');passed('Account form names the script versions that apply bidder accounts')
    d.get_by_label('Custom SChain JSON',exact=True).fill('{bad')
    d.get_by_role('button',name='Create bidder',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('not valid JSON')
    expect(d.get_by_label('Base params JSON',exact=False)).to_have_value(json.dumps({'mid':222}));screen('custom-json-error',d.get_by_role('alert'));passed('Invalid custom chain preserves account and parameter input')
    d.get_by_label('Custom SChain JSON',exact=True).fill(json.dumps(custom));d.get_by_label('Account SChain',exact=True).select_option('none')
    hold.append('POST');d.get_by_role('button',name='Create bidder',exact=True).click();expect(d.get_by_role('button',name='Saving…',exact=True)).to_be_disabled();screen('account-saving')
    assert len(pending)==1;fulfill(pending.pop());expect(d).to_have_count(0);expect(card('adf_ag')).to_contain_text('No upstream chain')
    passed('Agency alias saves with no upstream chain and saving state prevents double submission')
    page.reload();expect(card('adf_ag')).to_be_visible();saved=data(endpoint)['bidders'];agency=next(row for row in saved if row['bidder']=='adf_ag');own=next(row for row in saved if row['bidder']=='adf_smn')
    assert agency['baseAdapter']=='adf' and agency['schain']['mode']=='none' and agency['schain']['config']==custom and agency['params']=={'mid':222};assert own['params']=={'mid':111} and own['schain']['mode']=='inherit'
    screen('account-list');passed('Reload retains separate base adapter, account labels, params and SChain mode')
    card('adf_ag').get_by_role('button',name='＋ Add override',exact=True).click();d=dialog();d.get_by_label('Scope type',exact=False).select_option('adunit');d.get_by_label('Scope key',exact=False).fill('P1');d.get_by_label('Params JSON',exact=False).fill('{"mid":224}')
    d.get_by_role('button',name='Create override',exact=True).click();expect(d).to_have_count(0)
    card('adf_ag').locator('.bidder-actions').get_by_role('button',name='Duplicate',exact=True).click();d=dialog();d.get_by_label('Bidder code',exact=False).fill('adf_ag2');expect(d.get_by_label('Base adapter',exact=True)).to_have_value('adf');expect(d.get_by_label('Account SChain',exact=True)).to_have_value('none');d.get_by_label('Enabled',exact=True).uncheck()
    expect(d.get_by_text('The new account alias is registered by',exact=False)).to_have_text(f'Base params and the selected SChain settings are copied. The base adapter must be present in the uploaded Prebid build. The new account alias is registered by script {ACCOUNT_SCRIPTS}. Review partner IDs before enabling this account.')
    screen('duplicate-account',d);d.get_by_role('button',name='Duplicate bidder',exact=True).click();expect(d).to_have_count(0)
    saved=data(endpoint)['bidders'];copy=next(row for row in saved if row['bidder']=='adf_ag2');agency=next(row for row in saved if row['bidder']=='adf_ag');assert not copy['enabled'] and copy['schain']['mode']=='none';assert copy['overrides'][0]['bidder']=='adf_ag2' and copy['overrides'][0]['id']!=agency['overrides'][0]['id'];passed('Duplicate preserves mode and base adapter, copies overrides to distinct account, and respects disabled state')
    card('adf_ag').get_by_role('button',name='Edit bidder',exact=True).click();d=dialog();d.get_by_label('Base params JSON',exact=False).fill('{"mid":999}')
    response=send(endpoint+'/'+agency['id'],'PATCH',{'schain':{'mode':'custom','config':custom},'expectedUpdatedAt':agency['updatedAt']});assert response['status']==200,response
    d.get_by_role('button',name='Save bidder',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('changed in another tab');expect(d.get_by_label('Base params JSON',exact=False)).to_have_value('{"mid":999}');screen('stale-save-refused',d.get_by_role('alert'))
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['schain']['mode']=='custom' and saved['params']=={'mid':222};passed('Stale full-form save is refused without restoring the old chain or losing entered params')
    reject.append(True);d.get_by_role('button',name='Reload saved account (discard edits)',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('Synthetic list outage');expect(d.get_by_label('Base params JSON',exact=False)).to_have_value('{"mid":999}')
    d.get_by_role('button',name='Reload saved account (discard edits)',exact=True).click();expect(d.get_by_label('Account SChain',exact=True)).to_have_value('custom');expect(d.get_by_label('Base params JSON',exact=False)).to_have_value(json.dumps({'mid':222},indent=2));assert json.loads(d.get_by_label('Custom SChain JSON',exact=True).input_value())==custom;screen('custom-chain-reloaded',d)
    d.get_by_label('Base params JSON',exact=False).fill('{"mid":999}');d.get_by_role('button',name='Save bidder',exact=True).click();expect(d).to_have_count(0)
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['params']=={'mid':999} and saved['schain']['config']==custom;passed('Reopening the fresh record allows recovery while preserving the new custom chain')
    card('adf_ag').get_by_role('button',name='Edit bidder',exact=True).click();d=dialog();remembered={**custom,'nodes':[{**custom['nodes'][0],'sid':'agency-edited-43'}]};d.get_by_label('Custom SChain JSON',exact=True).fill(json.dumps(remembered));d.get_by_label('Account SChain',exact=True).select_option('inherit');d.get_by_role('button',name='Save bidder',exact=True).click();expect(d).to_have_count(0)
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['schain']=={'mode':'inherit','config':remembered};passed('Switching away from custom preserves the edited custom values for later reuse')
    card('adf_ag').get_by_role('button',name='Edit bidder',exact=True).click();d=dialog();d.get_by_label('Account SChain',exact=True).select_option('custom');expect(d.get_by_label('Custom SChain JSON',exact=True)).to_have_value(json.dumps(remembered,indent=2));d.get_by_label('Custom SChain JSON',exact=True).fill('{bad');d.get_by_label('Account SChain',exact=True).select_option('none');d.get_by_role('button',name='Save bidder',exact=True).click();expect(d.get_by_role('alert')).to_contain_text('not valid JSON');screen('inactive-custom-draft-error',d.get_by_role('alert'));d.get_by_role('button',name='Discard custom draft',exact=True).click();d.get_by_role('button',name='Save bidder',exact=True).click();expect(d).to_have_count(0)
    saved=next(row for row in data(endpoint)['bidders'] if row['bidder']=='adf_ag');assert saved['schain']=={'mode':'none'};passed('Invalid hidden draft is explicit and can be discarded before saving no upstream chain')
    # With no version named, the account notes follow the payload: the selected script applies accounts with the other
    # saved options, a version with a runtime notice still applies them (never named), none applies them, or unknown.
    alias_lead='Base params and the selected SChain settings are copied. The base adapter must be present in the uploaded Prebid build. '
    for fields,form_note,alias_note in [
     ({'accountScriptVersions':[],'accountNoticedScriptApplies':True,'selectedScriptAppliesAccounts':True},'The selected script applies aliases and account-specific SChain with your other saved options. Save the account, then generate a new package.','The new account alias is registered by the selected script.'),
     ({'accountScriptVersions':[],'accountNoticedScriptApplies':True,'selectedScriptAppliesAccounts':False},'No corrected script version is offered that applies aliases and account-specific SChain with your other saved options. Versions with a runtime notice in Script setup still apply them. You can save the account for a future package.','No corrected script version is offered that applies the new alias with your other saved options. Versions with a runtime notice in Script setup still apply it.'),
     ({'accountScriptVersions':[],'accountNoticedScriptApplies':False,'selectedScriptAppliesAccounts':False},'No available script version applies aliases and account-specific SChain with your other saved options. You can save the account for a future package.','No available script version applies the new alias with your other saved options.'),
     ({'accountScriptVersions':None,'accountNoticedScriptApplies':None,'selectedScriptAppliesAccounts':None},'Aliases and account-specific SChain require a script version that applies bidder accounts with your other saved options.','The new account alias is registered by a script version that applies bidder accounts.')]:
     patch[:]=[fields];page.reload(wait_until='domcontentloaded');expect(card('adf_ag')).to_be_visible();expect(page.locator('.bidders-page .config-loading')).to_have_count(0)
     page.get_by_role('button',name='＋ New bidder',exact=True).click();d=dialog()
     expect(d.locator('p.muted-copy',has_text=form_note)).to_have_text(form_note+' Existing scripts keep their saved settings.');d.get_by_role('button',name='Cancel',exact=True).click();expect(d).to_have_count(0)
     card('adf_ag').locator('.bidder-actions').get_by_role('button',name='Duplicate',exact=True).click();d=dialog()
     expect(d.get_by_text(alias_lead,exact=False)).to_have_text(alias_lead+alias_note+' Review partner IDs before enabling this account.')
     expect(d).not_to_contain_text('3.24.0');expect(d).not_to_contain_text('3.23.0');d.get_by_role('button',name='Cancel',exact=True).click();expect(d).to_have_count(0)
    patch.clear();page.reload(wait_until='domcontentloaded');expect(card('adf_ag')).to_be_visible()
    passed('With no version named, the account notes say whether the selected or a noticed script applies accounts, or that none does')
    before=data('/__fixture/snapshot');page.get_by_role('button',name='Script setup',exact=True).click();selector=page.get_by_label('Script version',exact=True);expect(selector).to_be_enabled()
    if args.runtime=='3.22.1':assert 'preview' in selector.locator('option:checked').inner_text().lower(),'Preview version is not labeled as preview'
    screen('script-preview-labeled',selector);assert data('/__fixture/snapshot')==before,'Opening version settings must not switch or modify account settings';passed('Script setup labels the selected preview explicitly and opening it changes no settings')
    assert not external,external;assert not errors,errors;passed('No horizontal overflow, page JavaScript errors or outbound traffic')
    results.append({'width':width,'checks':checks,'requests':requests,'pageErrors':errors,'externalRequests':external})
   except Exception:
    screen('failure');(out/f'failure-{width}.json').write_text(json.dumps({'checks':checks,'requests':requests,'pageErrors':errors,'visibleText':page.locator('body').inner_text()},indent=2));raise
   finally:page.close();proc.stdin.close();proc.wait(timeout=15)
 finally:browser.close()
report={'scope':'Actual React + authenticated Worker with local SQLite. No hosted deployment or SSP receipt verified.','runtime':args.runtime,'results':results,'passed':sum(len(row['checks']) for row in results),'failed':0}
(out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
