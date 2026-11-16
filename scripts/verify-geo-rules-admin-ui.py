"""Country rule editing through the actual UI/API, with all traffic isolated."""
import base64,json,subprocess,zipfile
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect

root=Path(__file__).resolve().parent.parent
out=root/'.generated/geo-rules-admin-evidence';out.mkdir(parents=True,exist_ok=True)
origin='https://admin-audit.fixture.invalid';results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
 for width in [1440,390]:
  proc=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/admin-audit-browser-fixture.mjs','--runtime=3.18.0','--conditional'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
  ready=json.loads(proc.stdout.readline());assert ready['ready']
  page=browser.new_page(viewport={'width':width,'height':1000});errors=[]
  page.on('pageerror',lambda error:errors.append(str(error)))
  def send(path,method='GET',body=None):
   proc.stdin.write(json.dumps({'path':path,'method':method,'body':None if body is None else json.dumps(body)})+'\n');proc.stdin.flush()
   value=json.loads(proc.stdout.readline());assert 'error' not in value,value;return value
  def data(path):
   response=send(path);assert response['status']==200,response;return json.loads(base64.b64decode(response['body']))
  def route(r):
   request=r.request;url=urlsplit(request.url);assert url.netloc=='admin-audit.fixture.invalid',request.url
   value=send(url.path+('?' +url.query if url.query else ''),request.method,json.loads(request.post_data) if request.post_data else None)
   r.fulfill(status=value['status'],headers=value['headers'],body=base64.b64decode(value['body']))
  page.route('**/*',route)
  def screen(name):
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1'),'Horizontal overflow'
   page.screenshot(path=str(out/f'{name}-{width}.png'),full_page=True)
  try:
   page.goto(origin+'/',wait_until='domcontentloaded')
   before=data('/__fixture/snapshot')
   page.get_by_role('button',name='Unit rules',exact=True).click()
   card=page.locator('article.unit-rule-card.exact').filter(has=page.get_by_role('heading',name='P1',exact=True))
   card.get_by_role('button',name='Edit',exact=True).click();dialog=page.get_by_role('dialog')
   expect(dialog.get_by_label('Key',exact=True)).to_have_value('category')
   dialog.get_by_role('button',name='＋ Country mapping',exact=True).click()
   mapping=dialog.locator('.conditional-mapping-card').last
   expect(mapping.get_by_label('Key',exact=True)).to_have_value('geo_country')
   mapping.get_by_label('Value',exact=True).fill('zz')
   expect(mapping.get_by_label('Value',exact=True)).to_have_value('ZZ')
   mapping.get_by_label('Use size map',exact=False).select_option('display')
   dialog.get_by_role('button',name='Save rule',exact=True).click()
   expect(dialog.get_by_text('use a country code such as RS, DE or AT.',exact=False)).to_be_visible()
   expect(mapping.get_by_label('Value',exact=True)).to_have_value('ZZ');screen('invalid-code-kept')
   mapping.get_by_label('Value',exact=True).fill('de')
   mapping.scroll_into_view_if_needed();screen('country-map')
   dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
   saved=data('/__fixture/snapshot');rule=json.loads(next(r['rule_json'] for r in saved['rules'] if r['rule_key']=='P1'))
   assert rule['conditionalMappings'][0]['conditions'][0]['key']=='category'
   assert rule['conditionalMappings'][1]['conditions'][0]['value']=='DE'
   assert saved['config']['builtinRuntimeSelection']==before['config']['builtinRuntimeSelection']
   page.get_by_role('button',name='＋ New rule',exact=True).click();dialog=page.get_by_role('dialog')
   dialog.get_by_label('Rule target',exact=False).select_option('__INTERSTITIAL__')
   expect(dialog.get_by_role('heading',name='Prebid timeout',exact=True)).to_have_count(0)
   expect(dialog.get_by_role('heading',name='Viewability refresh guard',exact=True)).to_have_count(0)
   expect(dialog.get_by_text('It does not activate a standalone Interstitial.',exact=False)).to_be_visible()
   dialog.get_by_role('button',name='Only Serbia preset',exact=True).click()
   expect(dialog.get_by_label('Use size map',exact=False)).to_have_count(0)
   expect(dialog.get_by_label('Match',exact=False)).to_have_value('any')
   expect(dialog.get_by_label('Slot action',exact=False)).to_have_value('disable')
   expect(dialog.get_by_label('Operator',exact=False).nth(0)).to_have_value('notEquals')
   expect(dialog.get_by_label('Operator',exact=False).nth(1)).to_have_value('notExists')
   expect(dialog.get_by_label('Value',exact=True).nth(0)).to_have_value('RS')
   expect(dialog.get_by_label('Value',exact=True).nth(1)).to_be_disabled()
   dialog.locator('.conditional-section').scroll_into_view_if_needed();screen('only-serbia-fallback')
   dialog.get_by_role('button',name='Save rule',exact=True).click();expect(dialog).to_have_count(0)
   expect(page.get_by_role('heading',name='Interstitial fallback',exact=True)).to_be_visible()
   saved=data('/__fixture/snapshot');fallback=json.loads(next(r['rule_json'] for r in saved['rules'] if r['rule_key']=='__INTERSTITIAL__'))
   assert set(fallback)=={'conditionalMappings'},fallback
   assert fallback['conditionalMappings'][0]['conditions'][0]['value']=='RS'
   assert fallback['conditionalMappings'][0]['conditions'][1]['operator']=='notExists'
   assert saved['config']['builtinRuntimeSelection']==before['config']['builtinRuntimeSelection']
   screen('saved')
   page.get_by_role('button',name='Script setup',exact=True).first.click()
   select=page.get_by_label('Script version',exact=True)
   option=select.locator('option').filter(has_text='3.19.0');expect(option).to_have_count(1)
   select.select_option(option.get_attribute('value'))
   page.get_by_role('button',name='Save script setup',exact=True).click()
   expect(page.get_by_role('status').filter(has_text='Script setup saved')).to_be_visible()
   state=data('/__fixture/snapshot');assert state['config']['builtinRuntimeSelection']['runtime']['runtimeVersion']=='3.19.0'
   assert state['rules']==saved['rules'],'Version change lost saved rules'
   page.get_by_role('button',name='Generate and releases',exact=True).first.click()
   generate=page.get_by_role('button',name='Generate and save package',exact=True);expect(generate).to_be_enabled();generate.click()
   download=page.get_by_role('button',name='Download saved ZIP',exact=True);expect(download).to_be_visible(timeout=30000)
   with page.expect_download() as event:download.click()
   archive=zipfile.ZipFile(event.value.path());config=json.loads(archive.read('config.json'))
   assert config['runtime']['runtimeVersion']=='3.19.0'
   assert config['conditionalUnits']['P1']['usesGeo'] is True
   assert config['interstitialRules']['usesGeo'] is True
   assert config['countrySignal']['targetingKey']=='geo_country'
   assert b'geo_country' in archive.read('ads.js') and b'geo_country' in archive.read('ads.min.js')
   assert not errors,errors;screen('generated-319')
   results.append({'width':width,'passed':True,'categoryKept':True,'invalidCountryRecovery':True,'fallbackPresetSaved':True,'versionUnchanged':True})
  except Exception:
   screen('failure');print(page.locator('body').inner_text());raise
  finally:
   page.close();proc.stdin.close();proc.wait(timeout=10)
 browser.close()
(out/'results.json').write_text(json.dumps(results,indent=2))
print('2/2 desktop/mobile country map edit/error recovery and Interstitial fallback preset saves passed.')
