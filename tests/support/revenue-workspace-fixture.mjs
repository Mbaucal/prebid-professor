import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import worker from '../../worker/test-workspace/index.mjs';
import {ORIGIN,TEST_EMAIL,TEST_PASSWORD} from './test-workspace-store.mjs';
export function revenueRequest(f,cookie,path,body,headers={}){
 return worker.fetch(new Request(ORIGIN+path,{method:body===undefined?'GET':'POST',headers:{cookie,origin:ORIGIN,...(body===undefined?{}:{'content-type':'application/json'}),...headers},body:body===undefined?undefined:typeof body==='string'||body instanceof Uint8Array?body:JSON.stringify(body)}),f.env);
}
export async function revenueJson(f,cookie,path,body){const r=await revenueRequest(f,cookie,path,body),data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;}
/** Actual fixed-site HTTP setup; synthetic credentials, SQLite and in-memory R2.
 * Does not save Deals/Formats: those remain explicit form/test operations. */
export async function initializeRevenueWorkspace(f){
 const login=await worker.fetch(new Request(ORIGIN+'/api/auth/login',{method:'POST',headers:{origin:ORIGIN,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({email:TEST_EMAIL,password:TEST_PASSWORD})}),f.env);
 assert.equal(login.status,303);const cookie=login.headers.get('set-cookie').split(';')[0];
 await revenueJson(f,cookie,'/test-api/setup',{confirm:'prepare-empty-test-database'});
 assert.equal((await revenueJson(f,cookie,'/test-api/outstream-settings')).runtimeEligible,false);
 const selection=await revenueJson(f,cookie,'/test-api/runtime-selection');
 const runtime=selection.runtimes.find(x=>x.id==='tessera-revenue-preview-1');assert(runtime);
 await revenueJson(f,cookie,'/test-api/runtime-selection',{expectedRevision:selection.revision,selection:{runtime:runtime.pin,allowPreview:true,enablePrebid:false,prebidBuildId:null}});
 const bytes=new Uint8Array(await readFile(new URL('../../vendor/prebid/tanjug-11.34.0/prebid.js',import.meta.url)));
 const upload=await revenueRequest(f,cookie,'/test-api/prebid/upload',bytes,{'content-type':'application/javascript','x-tessera-upload':'prebid-test-file'});const stored=await upload.json();assert.equal(upload.status,200,JSON.stringify(stored));
 const prebid=await revenueJson(f,cookie,'/test-api/prebid-settings');
 await revenueJson(f,cookie,'/test-api/prebid-settings',{expectedRevision:prebid.revision,acknowledge:true,draft:{...prebid.draft,enablePrebid:true,buildId:stored.file.id,bidders:[{bidder:'pubmatic',params:{publisherId:'fixture',adSlot:'fixture'},enabled:true}]}});
 const site=await revenueJson(f,cookie,'/test-api/site-settings');
 const unit=site.draft.units.find(x=>x.code==='Billboard');assert(unit);
 site.draft.maps.find(x=>x.name===unit.sizeMap).breakpoints.forEach(x=>{if(x.sizes.length&&!x.sizes.some(s=>s[0]===300&&s[1]===250))x.sizes.push([300,250]);});
 await revenueJson(f,cookie,'/test-api/site-settings',{expectedRevision:site.revision,acknowledge:true,draft:site.draft});
 return {cookie,initialSelection:selection};
}
export const revenueDeals={schemaVersion:1,entries:[{id:'fixture-deal',name:'Synthetic contract',bidder:'pubmatic',dealId:'0000199',positions:['Billboard'],startsAt:'2026-01-01T00:00:00.000Z',endsAt:'2027-01-01T00:00:00.000Z',enabled:true,mode:'contract-priority'}]};
export const revenueOutstream={schemaVersion:1,units:{Billboard:{format:'banner-outstream',playerSize:[300,250],minDuration:1,maxDuration:30,playbackMethod:2,placement:3,plcmt:4,partner:{bidder:'pubmatic',adapter:'pubmatic',outstreamAU:'fixture',activationConfirmed:true},cacheUrl:'https://prebid.adnxs.com/pbc/v1/cache'}}};
