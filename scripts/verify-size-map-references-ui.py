"""Real admin size-map UI and HTTP routes. All browser requests are local fixtures."""
import base64,json,os,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/size-map-references-ui';out.mkdir(parents=True,exist_ok=True)
origin='https://map-audit.fixture.invalid';endpoint='/api/publishers/audit-site/size-maps'
checks=[]
# Same name as the fixture's long page-type map of "display" (one unbreakable token).
LONG='vesti_sport_regionalno_beograd_i_okolina_najnovije_vesti_dana_iz_grada_i_regiona_sa_fotografijama'
# Short laptop and phone screens where the confirmation used to push "Confirm and save" out of the dialog.
SHORT={1440:[(1280,720),(1440,900)],390:[(390,844),(375,667)]}
# Visible part of the dialog below its sticky heading, the note, the confirm button and focus.
GEOMETRY='''d=>{const n=d.querySelector('.page-type-confirmation'),b=[...d.querySelectorAll('.modal-actions button')].find(x=>x.textContent.trim()==='Confirm and save'),h=d.querySelector('.modal-heading'),r=d.getBoundingClientRect(),nr=n.getBoundingClientRect(),br=b.getBoundingClientRect();
 return {visibleTop:r.top+d.clientTop+h.getBoundingClientRect().height,visibleBottom:r.top+d.clientTop+d.clientHeight,noteTop:nr.top,noteBottom:nr.bottom,buttonTop:br.top,buttonBottom:br.bottom,innerHeight,focused:document.activeElement===n,live:n.getAttribute('aria-live'),role:n.getAttribute('role')};}'''
# A long name wraps inside its card heading and keeps the references badge beside it.
CARD_WRAP='''c=>{const h=c.querySelector('h3'),b=c.querySelector('.map-usage'),u=c.querySelector('.map-used-by'),r=c.getBoundingClientRect(),hr=h.getBoundingClientRect(),br=b.getBoundingClientRect(),size=parseFloat(getComputedStyle(h).fontSize);
 return {clipped:h.scrollWidth>h.clientWidth+1||u.scrollWidth>u.clientWidth+1,lines:hr.height/size,badgeWidth:br.width,badgeInside:br.right<=r.right+1&&br.left>=hr.right-1,badgeText:b.textContent};}'''
TITLE_WRAP='''d=>{const t=d.querySelector('#size-map-editor-title'),x=d.querySelector('.modal-heading .icon-button'),r=d.getBoundingClientRect(),tr=t.getBoundingClientRect(),xr=x.getBoundingClientRect();
 return {clipped:t.scrollWidth>t.clientWidth+1||tr.right>xr.left+1,lines:tr.height/parseFloat(getComputedStyle(t).fontSize),closeInside:xr.width>0&&xr.right<=r.right+1};}'''
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
   def confirm_in_view(dialog):
    # Both inside the dialog's visible area (not under the sticky heading), and focus on the note.
    expect(dialog.get_by_role('button',name='Confirm and save',exact=True)).to_be_in_viewport(ratio=1)
    g=dialog.evaluate(GEOMETRY)
    assert g['noteTop']>=g['visibleTop']-1 and g['noteBottom']<=g['buttonTop'] and g['buttonBottom']<=g['visibleBottom']+1 and g['buttonBottom']<=g['innerHeight'],g
    assert g['focused'] and g['live']=='polite' and g['role']=='status',g
    return g
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
    # Long names wrap in the card heading and in the dialog title; the badge and the close button stay visible.
    long_card=variant_card(LONG+'_display');expect(long_card).to_contain_text(f'Page type {LONG}: P1 (via display)');expect(long_card.locator('.map-usage')).to_be_visible()
    wrap=long_card.evaluate(CARD_WRAP);assert not wrap['clipped'] and wrap['lines']>=2 and wrap['badgeWidth']>0 and wrap['badgeInside'] and wrap['badgeText']=='1 reference(s)',wrap
    long_card.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');expect(dialog.locator('#size-map-editor-title')).to_have_text('Edit '+LONG+'_display')
    title=dialog.evaluate(TITLE_WRAP);assert not title['clipped'] and title['lines']>=2 and title['closeInside'],title;screen('long-name-dialog');dialog.get_by_role('button',name='Cancel',exact=True).click();expect(dialog).to_have_count(0);screen('long-name-card')
    # Help text: a page-type map of a base in use is renamed on its own; a base renames its page-type maps.
    variant.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog')
    expect(dialog).to_contain_text('naslovna_display is the naslovna page-type map of display, so no other map is renamed with it.');expect(dialog).not_to_contain_text('renames its page-type maps')
    dialog.get_by_label('Size map name').fill('vesti_display');expect(dialog.locator('.page-type-renames')).to_have_count(0);screen('page-type-variant-help');dialog.get_by_role('button',name='Cancel',exact=True).click();expect(dialog).to_have_count(0)
    variant_card('display').get_by_role('button',name='Duplicate',exact=True).click();dialog=page.get_by_role('dialog');expect(dialog).to_contain_text('renames its page-type maps (<page type>_name).');dialog.get_by_role('button',name='Cancel',exact=True).click();expect(dialog).to_have_count(0)
    variant_card('display').get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');expect(dialog).to_contain_text('renames its page-type maps (<page type>_display).');dialog.get_by_label('Size map name').fill('rectangle')
    renames=dialog.locator('.page-type-renames');expect(renames.locator('span')).to_have_text('Also renames:');expect(renames.locator('li')).to_have_count(2)
    assert sorted(renames.locator('li').all_text_contents())==sorted(['naslovna_display → naslovna_rectangle',f'{LONG}_display → {LONG}_rectangle']),renames.locator('li').all_text_contents();screen('page-type-rename-preview')
    dialog.get_by_role('button',name='Save size map',exact=True).click();expect(dialog).to_have_count(0)
    variant=variant_card('naslovna_rectangle');expect(variant).to_contain_text('Page type naslovna: P1 (via rectangle)');assert {'rectangle','naslovna_rectangle',LONG+'_rectangle'}<=map_names();assert not {'naslovna_display',LONG+'_display'}&map_names()
    # The note and "Confirm and save" appear together on short screens, after a click on Save or Enter in the name field.
    for index,(w,h) in enumerate(SHORT[width]):
     page.set_viewport_size({'width':w,'height':h});variant.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');field=dialog.get_by_label('Size map name');field.fill('home_rectangle')
     if index%2:field.press('Enter')
     else:dialog.get_by_role('button',name='Save size map',exact=True).click()
     expect(dialog.locator('.page-type-confirmation')).to_contain_text('Page type home: P1 will use home_rectangle instead of rectangle.');confirm_in_view(dialog)
     page.screenshot(path=str(out/f'page-type-confirm-in-view-{w}x{h}.png'))
     dialog.get_by_role('button',name='Cancel',exact=True).click();expect(dialog).to_have_count(0)
    page.set_viewport_size({'width':width,'height':1000});assert 'home_rectangle' not in map_names()
    def rename_variant(card,new_name):
     card.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');dialog.get_by_label('Size map name').fill(new_name);dialog.get_by_role('button',name='Save size map',exact=True).click()
     note=dialog.locator('.page-type-confirmation');expect(note).to_contain_text('Page type naslovna: P1 will use rectangle instead of naslovna_rectangle.');expect(note).to_contain_text('Page type home: P1 will use home_rectangle instead of rectangle.');expect(note).to_contain_text('The next Generate uses these sizes. Existing packages do not change.');expect(note).to_be_in_viewport()
     confirm_in_view(dialog);expect(note.locator('.page-type-confirmation-updated')).to_have_count(0);expect(note.locator('.page-type-video-size')).to_have_count(0);assert new_name not in map_names()
     return dialog,note
    dialog,note=rename_variant(variant,'home_rectangle');screen('page-type-confirm-rename')
    # Any change to the breakpoints withdraws the confirmation; saving again asks again.
    dialog.get_by_role('button',name='Add breakpoint',exact=True).click();expect(note).to_have_count(0);expect(dialog.get_by_role('button',name='Save size map',exact=True)).to_be_visible()
    dialog.get_by_role('button',name='Save size map',exact=True).click();expect(note).to_be_visible();dialog.get_by_role('button',name='Remove breakpoint 3',exact=True).click();expect(note).to_have_count(0);expect(dialog.get_by_role('button',name='Save size map',exact=True)).to_be_visible();assert 'home_rectangle' not in map_names();screen('page-type-confirm-cleared')
    dialog.get_by_role('button',name='Cancel',exact=True).click();expect(dialog).to_have_count(0);assert 'naslovna_rectangle' in map_names()
    dialog,note=rename_variant(variant,'home_rectangle')
    # Another tab adds P9 on the base: "Confirm and save" gets a new confirmation, marked as updated, shown with its button and focused.
    send('/__fixture/insert-unit','POST',json.dumps({'id':'unit-P9','code':'P9','sizeMapKey':'rectangle','sortOrder':5}))
    dialog.get_by_role('button',name='Confirm and save',exact=True).click()
    expect(note.locator('.page-type-confirmation-updated')).to_have_text('Updated: the impact changed since your last attempt, for example in another tab. Review these lines before you confirm.')
    expect(note).to_contain_text('Page type naslovna: P1, P9 will use rectangle instead of naslovna_rectangle.');expect(note).not_to_contain_text('Page type naslovna: P1 will use');confirm_in_view(dialog);assert 'home_rectangle' not in map_names();screen('page-type-confirm-updated')
    dialog.get_by_role('button',name='Confirm and save',exact=True).click();expect(dialog).to_have_count(0);assert 'home_rectangle' in map_names()
    send('/__fixture/delete-unit','POST',json.dumps({'id':'unit-P9'}));page.reload()
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
    # P1 is Outstream with map-based sizes: a map with two video sizes renamed into rectangle's family needs a Formats choice first.
    send('/__fixture/outstream','POST','{}');send('/__fixture/insert-map','POST',json.dumps({'id':'clip-map','name':'clip','map':[{'minViewPort':[0,0],'sizes':[[300,250],[400,300]]}]}));page.reload()
    variant_card('clip').get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog');dialog.get_by_label('Size map name').fill('galerija_rectangle');dialog.get_by_role('button',name='Save size map',exact=True).click()
    note=dialog.locator('.page-type-confirmation');expect(note).to_contain_text('Page type galerija: P1, P2 will use galerija_rectangle instead of rectangle.')
    expect(note.locator('.page-type-video-size')).to_have_text(['Outstream on P1: no video size is chosen for galerija_rectangle. Choose one in Formats before Generate.']);confirm_in_view(dialog);screen('page-type-confirm-outstream')
    dialog.get_by_role('button',name='Cancel',exact=True).click();expect(dialog).to_have_count(0);assert 'clip' in map_names() and 'galerija_rectangle' not in map_names()
    page.get_by_role('button',name='Unit rules',exact=True).click();page.get_by_role('button',name='＋ New rule',exact=True).click();rule_dialog=page.get_by_role('dialog');rule_dialog.get_by_label('Rule target',exact=False).select_option('__DEFAULT__');scope=rule_dialog.locator('.conditional-section');scope.scroll_into_view_if_needed();expect(scope).to_contain_text('In scripts 3.21.1 and 3.21.2, Default, ATF and BTF conditions apply only to those formats');expect(scope).to_contain_text('Other scripts, including 3.22.0, can reject packages when those group rules reach TakeOver or Outstream.');expect(scope).to_contain_text('A Default or group preset does not restrict TakeOver or Outstream.');expect(scope.get_by_text('Conditional rules support Banner and Sticky.',exact=False)).to_be_in_viewport();screen('rule-format-scope');rule_dialog.get_by_role('button',name='Cancel',exact=True).click();expect(rule_dialog).to_have_count(0);assert not errors,errors
    checks.append({'width':width,'pass':True,'checks':['real HTTP/SQLite','load/retry','basic+advanced+disabled references','delete blocked with explanation','pending lock','failed save retains values','successful rename closes dialog','saved rule references','reload','name conflict/retry','3.21.1 and 3.21.2 group format scope copy','page-type listing','long names wrap with badge and close button','page-type map help text','page-type rename preview list and cascade','page-type rename confirmation','note and Confirm and save in view on short screens, focus on note','breakpoint change clears confirmation','re-issued confirmation marked as updated','confirmed page-type rename','page-type delete cancel/confirm','stale listing asks again with fresh lines','Outstream video size line','no overflow','zero page errors']})
   finally:page.close();proc.stdin.close();proc.wait(timeout=15)
 finally:browser.close()
(out/'results.json').write_text(json.dumps({'checks':checks},indent=2)+'\n');print(json.dumps({'checks':checks},indent=2))
