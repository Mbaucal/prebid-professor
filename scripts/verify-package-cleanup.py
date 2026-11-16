"""Actual TEST React/Worker/SQLite cleanup; all traffic stays in a synthetic fixture."""
import base64,json,subprocess
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright,expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/package-cleanup-evidence';out.mkdir(exist_ok=True)
process=subprocess.Popen(['node','--experimental-strip-types','--experimental-loader','./tests/support/ts-extension-loader.mjs','scripts/site-workspace-browser-fixture.mjs','--cleanup'],cwd=root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,text=True)
assert json.loads(process.stdout.readline())['ready']
errors=[];fail_delete=False
def route(route):
 global fail_delete
 req=route.request;url=urlsplit(req.url)
 assert url.netloc=='tessera.fixture.invalid'
 if url.path=='/test-api/package-cleanup' and req.method=='POST' and fail_delete:
  fail_delete=False;route.fulfill(status=503,content_type='application/json',body=json.dumps({'error':'Temporary cleanup failure. Retry.'}));return
 process.stdin.write(json.dumps({'path':url.path,'method':req.method,'body':req.post_data})+'\n');process.stdin.flush()
 result=json.loads(process.stdout.readline());assert 'error' not in result,result
 route.fulfill(status=result['status'],headers=result['headers'],body=base64.b64decode(result['body']))
try:
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True);page=browser.new_page(viewport={'width':1280,'height':900})
  page.route('**/*',route);page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto('https://tessera.fixture.invalid/site-workspace#packages')
  page.get_by_role('radio',name='GAM / AdX only',exact=False).check()
  page.get_by_role('button',name='Save script setup',exact=True).click()
  generate=page.get_by_role('button',name='Generate and save package',exact=True)
  expect(generate).to_be_enabled();generate.click()
  page.get_by_role('status').filter(has_text='Package saved in Releases').wait_for()
  page.get_by_text('1 of 20 package spaces used',exact=True).wait_for()
  clear=page.get_by_role('button',name='Delete all generated packages',exact=True)
  clear.scroll_into_view_if_needed();page.screenshot(path=str(out/'desktop.png'),full_page=True)
  page.once('dialog',lambda d:d.dismiss());clear.click()
  expect(page.get_by_text('1 of 20 package spaces used',exact=True)).to_be_visible()
  fail_delete=True;page.once('dialog',lambda d:d.accept());clear.click()
  page.get_by_role('status').filter(has_text='Temporary cleanup failure').wait_for();expect(clear).to_be_enabled()
  page.set_viewport_size({'width':390,'height':844});clear.scroll_into_view_if_needed()
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth+1')
  page.screenshot(path=str(out/'mobile.png'),full_page=True)
  page.once('dialog',lambda d:d.accept());clear.click()
  page.get_by_role('status').filter(has_text='1 generated packages deleted. 0 of 20 spaces used.').wait_for()
  expect(clear).to_be_disabled();page.reload();page.get_by_text('0 of 20 package spaces used',exact=True).wait_for()
  generate.click();page.get_by_role('status').filter(has_text='Package saved in Releases').wait_for()
  page.get_by_text('1 of 20 package spaces used',exact=True).wait_for()
  assert not errors,errors
  (out/'results.json').write_text(json.dumps({'passed':True,'checks':['desktop','mobile','cancel','error/retry','actual deletion','reload','generate after cleanup'],'externalTraffic':False},indent=2))
  browser.close()
finally:
 process.stdin.close();process.wait(timeout=15)
print('Package cleanup UI: desktop/mobile, cancellation, error recovery, delete, reload and new generation passed.')
