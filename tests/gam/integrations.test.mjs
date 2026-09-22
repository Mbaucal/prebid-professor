import test from 'node:test';
import assert from 'node:assert/strict';
import presets from '../../shared/gam/presets.json' with {type:'json'};
import {normalizePlan,expandGroup,parseSizes} from '../../shared/gam/plan.mjs';
import {gamResponse,encryptCredential,decryptCredential} from '../../worker/integrations/gam-service.mjs';
import {accessToken,parseResponse,unitPayload,GamClient} from '../../worker/integrations/gam-client.mjs';
import {fixture} from './fixture.mjs';

const origin='https://fixture.invalid',base='/api/integrations/gam',actor='test@example.invalid';
const account={type:'service_account',client_email:'fixture@fixture.iam.gserviceaccount.com',private_key:'-----BEGIN PRIVATE KEY-----\nsynthetic-key-not-used\n-----END PRIVATE KEY-----'};
const makePlan=(count=2)=>({networkCode:'123456',siteLabel:'example.invalid',parent:{mode:'new',name:'Example Display',code:'Example'},rows:expandGroup({...presets[3],count})});
async function request(f,path,body,options={}){
 const response=await gamResponse(new Request(origin+base+path,{method:body===undefined?'GET':'POST',headers:{origin,...(body===undefined?{}:{'content-type':'application/json'}),...options.headers},body:body===undefined?undefined:JSON.stringify(body)}),f.env,options.actor||actor,{clientFactory:()=>f.client});
 return {status:response.status,data:await response.json()};
}
async function connected(){const f=fixture();assert.equal((await request(f,'/connect',{networkCode:'123456',credentials:account})).status,201);return f;}

test('source presets produce 26 positions; numbering, custom names and validation',()=>{
 assert.equal(presets.flatMap(expandGroup).length,26);
 assert.equal(expandGroup({...presets[3],count:2,start:7})[1].code,'InFeed_8');
 assert.equal(expandGroup({...presets[3],names:'Alpha\nBeta'})[1].code,'Beta');
 assert.deepEqual(parseSizes('300x250;300x250;Fluid').sizes,[{width:300,height:250}]);
 assert.throws(()=>normalizePlan({...makePlan(),rows:[makePlan().rows[0],makePlan().rows[0]]}),/Dupliran/);
 assert.throws(()=>parseSizes('0x250'),/Neispravna/);
 assert.throws(()=>normalizePlan({...makePlan(),networkCode:'123 OR 1=1'}),/Neispravan/);
 assert.throws(()=>expandGroup({...presets[0],count:2}),/\{n\}/);
});
test('GET before setup has no writes or Google calls; credentials need configured encryption',async()=>{
 const f=fixture();delete f.env.GAM_CREDENTIALS_KEY;
 const s=await request(f,'/status');assert.equal(s.data.configured,false);assert.equal(f.env.BUILDS.data.size,0);assert.equal(f.counters.reads,0);
 const c=await request(f,'/connect',{networkCode:'123456',credentials:account});assert.equal(c.status,503);assert.equal(f.counters.reads,0);
});
test('credentials stay encrypted, bound to network and absent from status',async()=>{
 const f=await connected();const all=[...f.env.BUILDS.data.values()].map(x=>x.body).join('');assert(!all.includes(account.private_key));
 assert(!(JSON.stringify((await request(f,'/status')).data)).includes('sealed'));
 const sealed=await encryptCredential(f.env.GAM_CREDENTIALS_KEY,account,'123456');
 assert.deepEqual(await decryptCredential(f.env.GAM_CREDENTIALS_KEY,sealed,'123456'),account);
 await assert.rejects(decryptCredential(f.env.GAM_CREDENTIALS_KEY,sealed,'654321'));
});
test('preview has no GAM writes; explicit create stores real IDs and paths; replay is idempotent',async()=>{
 const f=await connected(),p=await request(f,'/preview',makePlan());assert.equal(p.status,200);assert.equal(p.data.counts.new,2);assert.equal(f.counters.creates,0);
 const create={id:p.data.id,confirmNetwork:'123456'};const r=await request(f,'/create',create);assert.equal(r.status,200);assert.equal(r.data.completed,true);assert.equal(f.counters.creates,2);assert.equal(r.data.rows[0].path,'/123456/Example/InFeed_1');
 assert.deepEqual((await request(f,'/create',create)).data,r.data);assert.equal(f.counters.creates,2);
 const second=await request(f,'/preview',makePlan());assert.equal(second.data.counts.existing,2);assert.equal(second.data.counts.new,0);
 assert.equal((await request(f,'/history')).data.results.length,1);
});
test('cross-origin, wrong actor, wrong network and expired review cannot create',async()=>{
 const f=await connected(),p=await request(f,'/preview',makePlan());
 assert.equal((await request(f,'/create',{id:p.data.id,confirmNetwork:'123456'},{headers:{origin:'https://evil.invalid'}})).status,403);
 assert.equal((await request(f,'/create',{id:p.data.id,confirmNetwork:'123456'},{actor:'other@example.invalid'})).status,404);
 assert.equal((await request(f,'/create',{id:p.data.id,confirmNetwork:'987654'})).status,422);
 const key=`api-integrations/gam/v1/jobs/${p.data.id}.json`,job=await f.env.BUILDS.get(key),value=await job.json();value.expiresAt=0;await f.env.BUILDS.put(key,JSON.stringify(value));
 assert.equal((await request(f,'/create',{id:p.data.id,confirmNetwork:'123456'})).status,409);assert.equal(f.counters.creates,0);
});
test('stale review refuses changed GAM data and fresh preview shows conflict',async()=>{
 const f=await connected();await f.client.create([{name:'Example Display',code:'Example'}],'1');const p=await request(f,'/preview',makePlan());
 await f.client.create([{name:'Different name',code:'InFeed_1',sizes:'300x250'}],'2');const before=f.counters.creates;
 assert.equal((await request(f,'/create',{id:p.data.id,confirmNetwork:'123456'})).status,409);assert.equal(f.counters.creates,before);
 assert.equal((await request(f,'/preview',makePlan())).data.counts.conflict,1);
});
test('partial/uncertain batch is marked unconfirmed; a new preview recovers without duplicating known rows',async()=>{
 const f=await connected(),p=await request(f,'/preview',makePlan(25));f.failOnCreate(3);
 const r=await request(f,'/create',{id:p.data.id,confirmNetwork:'123456'});assert.equal(r.data.completed,false);assert.equal(r.data.rows.filter(x=>x.state==='created').length,20);assert.equal(r.data.rows.filter(x=>x.state==='unconfirmed').length,5);
 f.failOnCreate(0);const retry=await request(f,'/preview',makePlan(25));assert.equal(retry.data.counts.existing,20);assert.equal(retry.data.counts.new,5);
 const end=await request(f,'/create',{id:retry.data.id,confirmNetwork:'123456'});assert.equal(end.data.completed,true);assert.equal(f.units.length,27);
});
test('concurrent execution of same review produces one mutation sequence',async()=>{
 const f=await connected(),p=await request(f,'/preview',makePlan());const input={id:p.data.id,confirmNetwork:'123456'};
 const results=await Promise.all([request(f,'/create',input),request(f,'/create',input)]);
 assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);assert.equal(f.counters.creates,2);
});
test('custom templates persist, and saving them never contacts Google',async()=>{
 const f=fixture(),r=await request(f,'/templates',{label:'My rectangle',group:{...presets[3],count:1,sizes:'300x250'}});
 assert.equal(r.status,201);assert.equal((await request(f,'/templates')).data.templates[0].label,'My rectangle');assert.equal(f.counters.reads,0);assert.equal(f.counters.creates,0);
});
test('SOAP parsing preserves numeric-looking codes and escapes unsafe XML',async()=>{
 const xml='<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><getAdUnitsByStatementResponse><rval><totalResultSetSize>1</totalResultSetSize><results><id>15</id><parentId>1</parentId><name>010</name><adUnitCode>010</adUnitCode><status>ACTIVE</status><isFluid>true</isFluid><adUnitSizes><size><width>300</width><height>250</height></size></adUnitSizes></results></rval></getAdUnitsByStatementResponse></soap:Body></soap:Envelope>';
 const client=new GamClient('123456','synthetic',async(url,init)=>{assert(url.startsWith('https://ads.google.com/'));assert(init.body.includes('parentId = 1'));return new Response(xml);});
 const units=await client.children('1');assert.equal(units[0].name,'010');assert.equal(units[0].fluid,true);assert.equal(units[0].sizes[0].width,300);
 const payload=unitPayload({name:'A & B',code:'A',description:'<img>',sizes:'300x250;Fluid'},'1');assert(payload.includes('A &amp; B'));assert(payload.includes('&lt;img&gt;'));assert(payload.includes('<isFluid>true</isFluid>'));
 assert.throws(()=>parseResponse('<!DOCTYPE x><x/>','createAdUnits'),/Neočekivan/);
 assert.throws(()=>parseResponse('<Envelope><Body><Fault><detail><ApiExceptionFault><errors><reason>PERMISSION_DENIED</reason></errors></ApiExceptionFault></detail></Fault></Body></Envelope>','createAdUnits'),/PERMISSION_DENIED/);
});
test('OAuth uses a signed short-lived assertion and a fixed token endpoint',async()=>{
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const pem='-----BEGIN PRIVATE KEY-----\n'+Buffer.from(await crypto.subtle.exportKey('pkcs8',pair.privateKey)).toString('base64')+'\n-----END PRIVATE KEY-----';
 const token=await accessToken({...account,private_key:pem,token_uri:'https://evil.invalid'},async(url,options)=>{
  assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(options.redirect,'error');const assertion=options.body.get('assertion');const [head,body,sig]=assertion.split('.');
  assert(await crypto.subtle.verify('RSASSA-PKCS1-v1_5',pair.publicKey,Buffer.from(sig,'base64url'),new TextEncoder().encode(`${head}.${body}`)));
  const claims=JSON.parse(Buffer.from(body,'base64url'));assert.equal(claims.exp-claims.iat,3600);assert.equal(claims.scope,'https://www.googleapis.com/auth/admanager');
  return Response.json({access_token:'synthetic-token'});
 });assert.equal(token,'synthetic-token');
});
