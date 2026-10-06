"""MBA-96: explore the actual dashboard build using synthetic read-only APIs."""
import json, subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
root=Path(__file__).resolve().parent.parent
out=root/'.generated/audit-mba96';out.mkdir(exist_ok=True)
server=subprocess.Popen(['node','scripts/layout-ui-fixture.mjs'],cwd=root,stdout=subprocess.PIPE,text=True)
results=[]
try:
 assert 'ready' in server.stdout.readline()
 with sync_playwright() as p:
  browser=p.chromium.launch(headless=True)
  page=browser.new_page(viewport={'width':1440,'height':1000})
  page.route('**/*',lambda r:r.continue_() if r.request.url.startswith('http://127.0.0.1:4182/') else r.abort())
  page.goto('http://127.0.0.1:4182/')
  expect(page.locator('.workspace h1')).to_have_text('site1.example.com')
  page.locator('.site-link').filter(has_text='site2.example.com').click()
  expect(page.locator('.workspace h1')).to_have_text('site2.example.com')
  page.locator('.tabbar').get_by_role('button',name='Config',exact=True).click()
  before={'site':page.locator('.workspace h1').inner_text(),'tab':page.locator('.tabbar .active').inner_text(),'url':page.url}
  page.reload();expect(page.locator('.workspace h1')).to_be_visible()
  after={'site':page.locator('.workspace h1').inner_text(),'tab':page.locator('.tabbar .active').inner_text(),'url':page.url}
  results.append({'case':'reload preserves selected site and section','status':'passed' if before==after else 'failed','before':before,'after':after})
  page.get_by_role('button',name='Publish ↗',exact=True).click()
  expect(page.locator('.tabbar .active')).to_have_text('Releases')
  before=page.locator('.workspace-content').inner_text()
  page.get_by_role('button',name='Publish ↗',exact=True).click()
  after=page.locator('.workspace-content').inner_text()
  results.append({'case':'Publish header action while already on Releases','status':'failed' if before==after else 'review','detail':'Same Releases section; no additional instruction, selection, focus or publish action. APIs are intentionally synthetic in this check.'})
  page.get_by_role('button',name='Edit site',exact=True).first.click()
  expect(page.get_by_role('dialog')).to_be_visible()
  page.keyboard.press('Escape')
  remains=page.get_by_role('dialog').count()>0
  results.append({'case':'Escape closes site dialog','status':'failed' if remains else 'passed'})
  if remains:
   page.get_by_role('dialog').get_by_role('button',name='Cancel',exact=True).click()
  page.screenshot(path=str(out/'dashboard-navigation.png'),full_page=True)
  browser.close()
 (out/'navigation.json').write_text(json.dumps({'scope':'actual dashboard; synthetic API; no hosted mutations','results':results},indent=2))
 print(json.dumps(results,indent=2))
finally:
 server.terminate();server.wait(timeout=5)
