"""Real admin size-map UI and HTTP routes. All browser requests are local fixtures."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/size-map-references-ui';out.mkdir(parents=True,exist_ok=True)
origin='https://map-audit.fixture.invalid';endpoint='/api/publishers/audit-site/size-maps'
checks=[]
with sync_playwright() as playwright:
 launch={'headless':True,'args':['--no-sandbox','--disable-dev-shm-usage']}
 executable=os.environ.get('CHROMIUM_EXECUTABLE_PATH') or os.environ.get('CHROMIUM_PATH')
 if executable:launch['executable_path']=executable
 browser=playwright.chromium.launch(**launch)
 try:
  for width in [1440,390]:
   proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/size-map-references-browser-fixture.mjs'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
   assert json.loads(proc.stdout.readline())['ready']
   page=browser.new_page(viewport={'width':width,'height':1000});errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
   pending=[];faults={'load':True,'save':False}
   def send(path,method='GET',body=None):
    proc.stdin.write(json.dumps({'path':path,'method':method,'body':body})+'\n');proc.stdin.flush();value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
   def data(path):
    response=send(path);assert response['status']==200,response;return json.loads(base64.b64decode(response['body']))
   def fulfill(route,error=None):
    if error:result={'status':503,'headers':{'content-type':'application/json'},'body':base64.b64encode(json.dumps({'error':error}).encode()).decode()}
    else:result=send(urlsplit(route.request.url).path,route.request.method,route.request.post_data)
    route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
   def intercept(route):
    req=route.request;url=urlsplit(req.url);assert url.netloc=='map-audit.fixture.invalid','External request blocked'
    if url.path==endpoint and req.method=='GET' and faults['load']:faults['load']=False;fulfill(route,'Synthetic map loading unavailable. Retry.')
    elif url.path==endpoint+'/home-map' and req.method=='PATCH' and faults['save']:faults['save']=False;pending.append(route)
    else:fulfill(route)
   page.route('**/*',intercept)
   def screen(name):
    assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow'
    page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
   try:
    page.goto(origin,wait_until='domcontentloaded');expect(page.get_by_role('alert')).to_contain_text('Synthetic map loading');screen('load-error')
    page.get_by_role('button',name='Reload size maps').click();card=page.locator('article').filter(has=page.get_by_role('heading',name='home',exact=True));expect(card).to_contain_text('3 reference(s)');expect(card).to_contain_text('Future disabled (disabled)');expect(card).to_contain_text('Advanced homepage (advanced)');screen('references')
    card.get_by_role('button',name='Delete',exact=True).click();expect(page.get_by_role('alert')).to_contain_text('Reassign');expect(page.get_by_role('alert')).to_be_in_viewport();assert any(row['name']=='home' for row in data('/__fixture/snapshot')['maps']);screen('delete-refused')
    card.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');field=dialog.get_by_label('Size map name');field.fill('renamed');faults['save']=True;dialog.get_by_role('button',name='Save size map',exact=True).click();expect(dialog.get_by_role('button',name='Saving…')).to_be_disabled();expect(field).to_be_disabled();screen('pending')
    fulfill(pending.pop(),'Synthetic map save unavailable. Retry your edits.');expect(dialog.get_by_role('alert')).to_contain_text('Synthetic map save');expect(dialog.get_by_role('alert')).to_be_in_viewport();expect(field).to_have_value('renamed');screen('save-error')
    dialog.get_by_role('button',name='Save size map',exact=True).click();expect(dialog).to_have_count(0);renamed=page.locator('article').filter(has=page.get_by_role('heading',name='renamed',exact=True));expect(renamed).to_contain_text('3 reference(s)');state=data('/__fixture/snapshot');assert state['config']['advancedUnitRules']['P1']['conditionalMappings'][0]['sizeMapKey']=='renamed';assert state['config']['unitRules']['P1']['conditionalMappings'][1]['sizeMapKey']=='renamed';assert json.loads(state['rules'][0]['rule_json'])['conditionalMappings'][0]['sizeMapKey']=='renamed';screen('saved')
    page.reload();expect(renamed).to_contain_text('3 reference(s)');renamed.get_by_role('button',name='Edit',exact=True).click();field=page.get_by_role('dialog').get_by_label('Size map name');field.fill('display');page.get_by_role('button',name='Save size map',exact=True).click();expect(page.get_by_role('dialog').get_by_role('alert')).to_contain_text('already exists');expect(field).to_have_value('display');screen('name-conflict')
    field.fill('renamed');page.get_by_role('button',name='Save size map',exact=True).click();expect(page.get_by_role('dialog')).to_have_count(0);screen('retry-saved')
    # Page-type maps: listed as used, carried by a base rename, confirmed before they stop applying.
    def variant_card(name):return page.locator('article').filter(has=page.get_by_role('heading',name=name,exact=True))
    def map_names():return {row['name'] for row in data('/__fixture/snapshot')['maps']}
    variant=variant_card('naslovna_display');expect(variant).to_contain_text('Page type naslovna: P1 (via display)');expect(variant).to_contain_text('1 reference(s)');screen('page-type-listed')
    variant_card('display').get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');dialog.get_by_label('Size map name').fill('rectangle');expect(dialog).to_contain_text('Also renames: naslovna_display → naslovna_rectangle');screen('page-type-rename-preview')
    dialog.get_by_role('button',name='Save size map',exact=True).click();expect(dialog).to_have_count(0)
    variant=variant_card('naslovna_rectangle');expect(variant).to_contain_text('Page type naslovna: P1 (via rectangle)');assert {'rectangle','naslovna_rectangle'}<=map_names();assert 'naslovna_display' not in map_names()
    def rename_variant(card,new_name):
     card.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');dialog.get_by_label('Size map name').fill(new_name);dialog.get_by_role('button',name='Save size map',exact=True).click()
     note=dialog.locator('.page-type-confirmation');expect(note).to_contain_text('Page type naslovna: P1 will use rectangle instead of naslovna_rectangle.');expect(note).to_contain_text('Page type home: P1 will use home_rectangle instead of rectangle.');expect(note).to_contain_text('The next Generate uses these sizes. Existing packages do not change.');expect(note).to_be_in_viewport();expect(dialog.get_by_role('button',name='Confirm and save',exact=True)).to_be_visible();assert new_name not in map_names()
     return dialog,note
    dialog,note=rename_variant(variant,'home_rectangle');screen('page-type-confirm-rename')
    # Any change to the breakpoints withdraws the confirmation; saving again asks again.
    dialog.get_by_role('button',name='Add breakpoint',exact=True).click();expect(note).to_have_count(0);expect(dialog.get_by_role('button',name='Save size map',exact=True)).to_be_visible()
    dialog.get_by_role('button',name='Save size map',exact=True).click();expect(note).to_be_visible();dialog.get_by_role('button',name='Remove breakpoint 3',exact=True).click();expect(note).to_have_count(0);expect(dialog.get_by_role('button',name='Save size map',exact=True)).to_be_visible();assert 'home_rectangle' not in map_names();screen('page-type-confirm-cleared')
    dialog.get_by_role('button',name='Cancel',exact=True).click();expect(dialog).to_have_count(0);assert 'naslovna_rectangle' in map_names()
    dialog,note=rename_variant(variant,'home_rectangle');dialog.get_by_role('button',name='Confirm and save',exact=True).click();expect(dialog).to_have_count(0)
    variant=variant_card('home_rectangle');expect(variant).to_contain_text('Page type home: P1 (via rectangle)');assert 'home_rectangle' in map_names() and 'naslovna_rectangle' not in map_names();screen('page-type-confirmed')
    prompts=[];answer={'accept':False}
    def on_dialog(prompt):
     prompts.append(prompt.message);prompt.accept() if answer['accept'] else prompt.dismiss()
    page.on('dialog',on_dialog)
    def wait_prompts(count):
     for _ in range(100):
      if len(prompts)>=count:break
      page.wait_for_timeout(100)
     assert len(prompts)>=count,prompts
    variant.get_by_role('button',name='Delete',exact=True).click();wait_prompts(1);page.wait_for_timeout(300)
    assert len(prompts)==1 and 'Page type home: P1 will use rectangle instead of home_rectangle.' in prompts[0],prompts;assert 'home_rectangle' in map_names();expect(variant).to_have_count(1)
    prompts.clear();answer['accept']=True;variant.get_by_role('button',name='Delete',exact=True).click();expect(variant).to_have_count(0);assert len(prompts)==1,prompts;assert 'home_rectangle' not in map_names();screen('page-type-deleted')
    # The listing is stale (another tab adds P2 on the base): the server's fresh lines get a second dialog.
    send('/__fixture/insert-map','POST',json.dumps({'id':'sport-rectangle-map','name':'sport_rectangle','map':[{'minViewPort':[0,0],'sizes':[[300,250]]}]}));page.reload()
    sport=variant_card('sport_rectangle');expect(sport).to_contain_text('Page type sport: P1 (via rectangle)')
    send('/__fixture/insert-unit','POST',json.dumps({'id':'unit-P2','code':'P2','sizeMapKey':'rectangle','sortOrder':1}))
    prompts.clear();sport.get_by_role('button',name='Delete',exact=True).click();expect(sport).to_have_count(0)
    assert len(prompts)==2,prompts;assert 'Page type sport: P1 will use rectangle instead of sport_rectangle.' in prompts[0],prompts;assert 'Page type sport: P1, P2 will use rectangle instead of sport_rectangle.' in prompts[1],prompts
    assert 'sport_rectangle' not in map_names();page.remove_listener('dialog',on_dialog);screen('page-type-delete-recheck')
    page.get_by_role('button',name='Unit rules',exact=True).click();page.get_by_role('button',name='＋ New rule',exact=True).click();rule_dialog=page.get_by_role('dialog');rule_dialog.get_by_label('Rule target',exact=False).select_option('__DEFAULT__');scope=rule_dialog.locator('.conditional-section');scope.scroll_into_view_if_needed();expect(scope).to_contain_text('In scripts 3.21.1 and 3.21.2, Default, ATF and BTF conditions apply only to those formats');expect(scope).to_contain_text('A Default or group preset does not restrict TakeOver or Outstream.');expect(scope.get_by_text('Conditional rules support Banner and Sticky.',exact=False)).to_be_in_viewport();screen('rule-format-scope');rule_dialog.get_by_role('button',name='Cancel',exact=True).click();expect(rule_dialog).to_have_count(0);assert not errors,errors
    checks.append({'width':width,'pass':True,'checks':['real HTTP/SQLite','load/retry','basic+advanced+disabled references','delete blocked with explanation','pending lock','failed save retains values','successful rename closes dialog','saved rule references','reload','name conflict/retry','3.21.1 and 3.21.2 group format scope copy','page-type listing','page-type rename preview and cascade','page-type rename confirmation','breakpoint change clears confirmation','confirmed page-type rename','page-type delete cancel/confirm','stale listing asks again with fresh lines','no overflow','zero page errors']})
   finally:page.close();proc.stdin.close();proc.wait(timeout=15)
 finally:browser.close()
(out/'results.json').write_text(json.dumps({'checks':checks},indent=2)+'\n');print(json.dumps({'checks':checks},indent=2))
