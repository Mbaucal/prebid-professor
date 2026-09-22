import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../worker/test-workspace/index.mjs';
import {workspaceStore,ORIGIN,TEST_EMAIL,TEST_PASSWORD} from '../support/test-workspace-store.mjs';
import {sizeMapsTemplateCsv,adUnitsTemplateCsv} from '../../src/shared/inventory-csv-templates.ts';
async function call(f,path,cookie,body){return worker.fetch(new Request(ORIGIN+path,{method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),origin:ORIGIN,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),f.env);}
async function ready(f){const r=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);const cookie=r.headers.get('set-cookie').split(';')[0];assert.equal((await call(f,'/test-api/setup',cookie,{confirm:'prepare-empty-test-database'})).status,200);return cookie;}
test('catalog, assets, CSV templates and previews respect TEST authentication and scope',async()=>{
 const f=workspaceStore();try{
  for(const path of ['/creative-templates','/creative-templates.js','/test-api/inventory-template/size-maps.csv'])assert([303,401].includes((await call(f,path)).status));
  const cookie=await ready(f),page=await call(f,'/creative-templates',cookie);assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'self'/);assert.match(await page.text(),/creative-templates.js/);
  const script=await call(f,'/creative-templates.js',cookie);assert.equal(script.status,200);assert.match(await script.text(),/Preuzmi za GAM/);
  assert.equal(await (await call(f,'/test-api/inventory-template/size-maps.csv',cookie)).text(),sizeMapsTemplateCsv);
  assert.equal((await call(f,'/test-api/inventory-preview',cookie,{kind:'bidders',csv:'x'})).status,422);
  assert.equal((await call(f,'/test-api/inventory-preview',cookie,{kind:'size-maps',csv:sizeMapsTemplateCsv,siteId:'foreign'})).status,422);
 }finally{f.close();}
});
test('CSV preview performs no writes and full generic draft saves through revision-checked editor',async()=>{
 const f=workspaceStore();try{
  const cookie=await ready(f),selection=await (await call(f,'/test-api/runtime-selection',cookie)).json();
  assert.equal((await call(f,'/test-api/runtime-selection',cookie,{expectedRevision:selection.revision,selection:{runtime:selection.runtimes[0].pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}})).status,200);
  const before=await (await call(f,'/test-api/site-settings',cookie)).json();
  const maps=await (await call(f,'/test-api/inventory-preview',cookie,{kind:'size-maps',csv:sizeMapsTemplateCsv})).json();
  const units=await (await call(f,'/test-api/inventory-preview',cookie,{kind:'ad-units',csv:adUnitsTemplateCsv})).json();
  assert.equal(maps.preview.errorCount,0);assert.equal(units.preview.errorCount,0);
  assert.equal(maps.preview.rows.length,11);assert.equal(units.preview.rows.length,36);
  assert.equal((await (await call(f,'/test-api/site-settings',cookie)).json()).revision,before.revision);
  const draft=structuredClone(before.draft);
  for(const {data:d} of maps.preview.rows){const m={name:d.name,breakpoints:d.map.map(r=>({minWidth:r.minViewPort[0],sizes:r.sizes}))};const i=draft.maps.findIndex(x=>x.name===m.name);if(i<0)draft.maps.push(m);else draft.maps[i]=m;}
  for(const {data:d} of units.preview.rows){const i=draft.units.findIndex(x=>x.code===d.code),u={...(i<0?{}:draft.units[i]),code:d.code,type:d.type,sizeMap:d.sizeMapKey,enabled:d.enabled};if(i<0)draft.units.push(u);else draft.units[i]=u;}
  const save=await call(f,'/test-api/site-settings',cookie,{expectedRevision:before.revision,acknowledge:true,draft});assert.equal(save.status,200,await save.text());
  const after=await (await call(f,'/test-api/site-settings',cookie)).json();assert.equal(after.draft.units.find(u=>u.code==='TakeOver').type,'DRAFT');assert(after.draft.maps.some(m=>m.name==='Native'));assert(after.draft.units.some(u=>u.code==='InText_10'));
  assert.equal((await call(f,'/test-api/site-settings',cookie,{expectedRevision:before.revision,acknowledge:true,draft})).status,409);
 }finally{f.close();}
});
