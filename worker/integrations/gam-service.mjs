import {siteInventoryStore,planSiteInventory,sitePlanSummary} from './site-inventory.mjs';
import { lineItemResponse } from './line-item-service.mjs';
import { GamError, parseSizes, numericId, normalizePlan, compareRows, expandGroup, text } from '../../shared/gam/plan.mjs';
import { GamClient, accessToken, validateCredential, gamPath, API_VERSION } from './gam-client.mjs';

const prefix='api-integrations/gam/v1/';
const encoder=new TextEncoder();
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
const fail=(message,status=422)=>{throw new GamError(message,status);};
const connectionKey=n=>`${prefix}connections/${numericId(n)}.json`;
const jobKey=id=>`${prefix}jobs/${id}.json`;
const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value)?value:fail('Neispravan ID operacije.');
async function read(bucket,key){const object=await bucket.get(key);return object?{value:await object.json(),etag:object.etag}:null;}
async function write(bucket,key,value,options={}){return bucket.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},...options});}
function secret(env){if(typeof env.GAM_CREDENTIALS_KEY!=='string'||env.GAM_CREDENTIALS_KEY.length<32)fail('GAM povezivanje još nije podešeno na serveru. Potrebno je dodati GAM_CREDENTIALS_KEY u Worker Secrets.',503);return env.GAM_CREDENTIALS_KEY;}
async function aesKey(value){return crypto.subtle.importKey('raw',await crypto.subtle.digest('SHA-256',encoder.encode(`tessera-gam-v1:${value}`)),{name:'AES-GCM'},false,['encrypt','decrypt']);}
export async function encryptCredential(value,credential,network){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(network)},await aesKey(value),encoder.encode(JSON.stringify(credential)));
  return {iv:Array.from(iv),cipher:Array.from(new Uint8Array(cipher))};
}
export async function decryptCredential(value,sealed,network){
  try{return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:new Uint8Array(sealed.iv),additionalData:encoder.encode(network)},await aesKey(value),new Uint8Array(sealed.cipher))));}
  catch{fail('Sačuvani GAM ključ nije moguće otvoriti. Proverite server Secret pre ponovnog povezivanja.',503);}
}
async function body(request){
  if(!request.headers.get('content-type')?.startsWith('application/json'))fail('Potreban je JSON zahtev.',415);
  let size=0;const chunks=[],reader=request.body?.getReader();if(!reader)fail('Nedostaje zahtev.');
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();fail('Zahtev je prevelik.',413);}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length;}
  try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();return value;}catch{fail('Neispravan JSON.');}
}
export async function buildPreview(client,network,plan){
  let parent;
  if(plan.parent.mode==='existing')parent=await client.get(plan.parent.id);
  else{
    const candidates=await client.children(network.rootId);
    const named=candidates.find(x=>x.name.toLowerCase()===plan.parent.name.toLowerCase());
    parent=candidates.find(x=>x.code.toLowerCase()===plan.parent.code.toLowerCase());
    if((!parent&&named)||(parent&&(parent.code!==plan.parent.code||parent.name!==plan.parent.name)))fail('Novi parent se poklapa sa postojećim nazivom ili code-om. Izaberite postojeći parent.',409);
  }
  if(parent&&parent.status!=='ACTIVE')fail('Izabrani parent nije aktivan.',409);
  const rows=compareRows(plan.rows,parent?await client.children(parent.id):[]);
  return {parent:parent?{...parent,state:'existing',path:gamPath(network.networkCode,network.rootId,parent)}:{...plan.parent,state:'new',path:`/${network.networkCode}/${plan.parent.code}`},rows,
    counts:{new:rows.filter(x=>x.state==='new').length,existing:rows.filter(x=>x.state==='existing').length,conflict:rows.filter(x=>x.state==='conflict').length}};
}

// Called only after the host's authentication guard. Recheck Origin here as well.
export async function gamResponse(request,env,actor,{base='/api/integrations/gam',clientFactory,tokenFactory=accessToken,trafficFactory,siteScope=null,inventoryGuard,inventoryValidator}={}){
  try{
    const url=new URL(request.url),path=url.pathname.slice(base.length);
    if(!url.pathname.startsWith(base+'/')&&url.pathname!==base)return null;
    if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
    if(request.method==='POST'&&(request.headers.get('origin')!==url.origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))))return json({error:'Same-origin request required.'},403);
    const bucket=env.BUILDS,sites=siteInventoryStore(env,{siteScope,inventoryGuard,inventoryValidator});
    const withSite=async result=>{if(!result.siteId){if(!env.DB)return result;try{const links=await sites.links(result.id);return links.length?{...result,siteId:links[0].siteId,siteSync:links[0]}:result;}catch{return result;}}try{return {...result,siteSync:await sites.receipt(result.siteId,result.id)||{state:'pending',siteId:result.siteId}};}catch{return {...result,siteSync:{state:'pending',siteId:result.siteId,error:'Upis u sajt nije potvrđen. Proverite ponovo.'}};}};
    const makeClient=async connection=>clientFactory?clientFactory(connection):new GamClient(connection.networkCode,await tokenFactory(await decryptCredential(secret(env),connection.sealed,connection.networkCode)));
    const connected=async network=>{
      if(!bucket)fail('Skladište integracija nije povezano.',503);
      secret(env);const found=await read(bucket,connectionKey(network));if(!found)fail('Prvo povežite ovu GAM mrežu.',409);return found.value;
    };
    if(path==='/sites'&&request.method==='GET')return json({sites:env.DB?await sites.list():[]});
    if(path==='/site-inventory'&&request.method==='GET'){
      const siteId=url.searchParams.get('siteId'),saved=await sites.read(siteId);
      return json({revision:saved.revision,siteId,mapNames:saved.snapshot.maps.map(m=>m.name)});
    }
    if(path==='/defaults'&&request.method==='POST'){
      const input=await body(request);if(typeof input.revision!=='string'||!input.revision)fail('Prvo učitajte mape sajta.',409);
      const plan=await planSiteInventory(sites,input.siteId,{revision:input.revision});
      return json(await sites.commit(plan,actor,crypto.randomUUID()));
    }
    if(path==='/site-sync/preview'&&request.method==='POST'){
      const input=await body(request),resultId=uuid(input.id),stored=await read(bucket,`${prefix}results/${resultId}.json`);
      if(!stored)fail('GAM rezultat nije pronađen.',404);
      const result=stored.value,known=await sites.receipt(input.siteId,resultId);if(known)return json({saved:known});
      const original=await read(bucket,jobKey(resultId));
      const connection=await connected(result.networkCode),client=await makeClient(connection),network=await client.network();
      const rows=[],current=await client.children(numericId(result.parentId));
      for(const row of result.rows.filter(r=>r.id&&r.path&&['created','existing'].includes(r.state))){
        const actual=current.find(unit=>unit.id===row.id);
        if(!actual||actual.status!=='ACTIVE'||actual.code!==row.code||gamPath(network.networkCode,network.rootId,actual)!==row.path)fail(`${row.code}: GAM stanje je promenjeno. Ponovite GAM pregled.`,409);
        rows.push({...row,sizes:[...actual.sizes.map(s=>`${s.width}x${s.height}`),...(actual.fluid?['fluid']:[])].join('; '),mapKey:row.mapKey||original?.value.plan.rows.find(r=>r.code===row.code)?.mapKey});
      }
      if(!rows.length)fail('Nema potvrđenih GAM ad unita za upis. Ponovite proveru u GAM-u.',409);
      const plan=await planSiteInventory(sites,input.siteId,{rows}),id=crypto.randomUUID();
      const review={id,resultId,actor,origin:url.origin,siteId:input.siteId,networkCode:result.networkCode,parentId:result.parentId,connectionRevision:connection.revision,rows,revision:plan.revision,expiresAt:Date.now()+15*60*1000};
      await write(bucket,`${prefix}site-reviews/${id}.json`,review,{onlyIf:{etagDoesNotMatch:'*'}});
      return json({id,resultId,...sitePlanSummary(plan)});
    }
    if(path==='/site-sync/apply'&&request.method==='POST'){
      const input=await body(request),id=uuid(input.id),stored=await read(bucket,`${prefix}site-reviews/${id}.json`),r=stored?.value;
      if(!r||r.actor!==actor||r.origin!==url.origin)fail('Pregled upisa nije pronađen.',404);
      if(input.confirmSite!==r.siteId)fail('Potvrdite prikazani sajt.');
      const known=await sites.receipt(r.siteId,r.resultId);if(known)return json(known);
      if(r.expiresAt<Date.now())fail('Pregled je istekao. Ponovo proverite upis u sajt.',409);
      const connection=await connected(r.networkCode);if(connection.revision!==r.connectionRevision)fail('GAM konekcija je promenjena. Ponovo proverite upis u sajt.',409);
      const client=await makeClient(connection),network=await client.network(),current=await client.children(numericId(r.parentId));
      for(const row of r.rows){const actual=current.find(u=>u.id===row.id),expected=parseSizes(row.sizes);
        if(!actual||actual.status!=='ACTIVE'||actual.code!==row.code||gamPath(network.networkCode,network.rootId,actual)!==row.path||actual.fluid!==expected.fluid||actual.sizes.map(s=>`${s.width}x${s.height}`).sort().join(';')!==expected.sizes.map(s=>`${s.width}x${s.height}`).sort().join(';'))fail(`${row.code}: GAM stanje je promenjeno. Ponovo proverite upis u sajt.`,409);
      }
      const plan=await planSiteInventory(sites,r.siteId,{rows:r.rows,revision:r.revision});
      return json(await sites.commit(plan,actor,r.resultId));
    }
    if(path.startsWith('/line-items/'))return await lineItemResponse(request,path,{bucket,actor,body,connected,makeClient,trafficFactory});
    if(path==='/status'&&request.method==='GET'){
      const connections=[];
      if(bucket){const list=await bucket.list({prefix:prefix+'connections/',limit:100});for(const object of list.objects){const item=await read(bucket,object.key);if(item){const {sealed,...safe}=item.value;connections.push(safe);}}}
      return json({configured:Boolean(bucket&&typeof env.GAM_CREDENTIALS_KEY==='string'&&env.GAM_CREDENTIALS_KEY.length>=32),apiVersion:API_VERSION,connections});
    }
    if(path==='/connect'&&request.method==='POST'){
      if(!bucket)fail('Skladište integracija nije povezano.',503);
      const key=secret(env),input=await body(request),networkCode=numericId(input.networkCode);
      const credentials=validateCredential(input.credentials);
      const client=clientFactory?clientFactory({networkCode}):new GamClient(networkCode,await tokenFactory(credentials));
      const network=await client.network();
      const value={...network,email:credentials.client_email,revision:crypto.randomUUID(),connectedAt:new Date().toISOString(),connectedBy:actor,sealed:await encryptCredential(key,credentials,networkCode)};
      if(!await write(bucket,connectionKey(networkCode),value,{onlyIf:{etagDoesNotMatch:'*'}}))fail('Mreža je već povezana. Izaberite je u listi konekcija.',409);
      const {sealed,...safe}=value;return json({connection:safe},201);
    }
    if(path==='/parents'&&request.method==='GET'){
      const connection=await connected(url.searchParams.get('network'));
      const client=await makeClient(connection),parentId=url.searchParams.get('parent')||connection.rootId;
      const parent=await client.get(numericId(parentId));
      const units=await client.children(parent.id);
      return json({parent,units:units.filter(x=>x.status==='ACTIVE'),rootId:connection.rootId});
    }
    if(path==='/templates'&&request.method==='GET'){
      if(!bucket)return json({templates:[]});
      const list=await bucket.list({prefix:prefix+'templates/',limit:100});
      const templates=[];for(const object of list.objects){const found=await read(bucket,object.key);if(found)templates.push(found.value);}
      return json({templates});
    }
    if(path==='/templates'&&request.method==='POST'){
      if(!bucket)fail('Skladište integracija nije povezano.',503);
      const input=await body(request),group={...input.group};
      const label=text(input.label,'Naziv šablona',80);expandGroup(group);
      const item={id:crypto.randomUUID(),label,pattern:text(group.pattern,'Naziv'),count:Number(group.count),start:Number(group.start),sizes:group.sizes,description:String(group.description||'').slice(0,6000),...(group.mapKey?{mapKey:group.mapKey}:{}),createdBy:actor};
      if((await bucket.list({prefix:prefix+'templates/',limit:100})).objects.length>=100)fail('Dostignuto je 100 sačuvanih šablona.');
      await write(bucket,`${prefix}templates/${item.id}.json`,item);return json({template:item},201);
    }
    if(path==='/preview'&&request.method==='POST'){
      const plan=normalizePlan(await body(request)),connection=await connected(plan.networkCode);
      const client=await makeClient(connection),network=await client.network();
      const preview=await buildPreview(client,network,plan),id=crypto.randomUUID();
      const local=plan.siteId?await planSiteInventory(sites,plan.siteId,{parentPath:preview.parent.path,rows:preview.rows}):null;
      const siteSync=local?sitePlanSummary(local):null;
      const value={id,actor,origin:url.origin,createdAt:new Date().toISOString(),expiresAt:Date.now()+15*60*1000,connectionRevision:connection.revision,plan,preview,network,siteSync};
      await write(bucket,jobKey(id),value,{onlyIf:{etagDoesNotMatch:'*'}});
      return json({id,...preview,network,siteSync,expiresAt:value.expiresAt});
    }
    if(path==='/create'&&request.method==='POST'){
      if(!bucket)fail('Skladište integracija nije povezano.',503);
      const input=await body(request),id=uuid(input.id),job=await read(bucket,jobKey(id));
      if(!job||job.value.actor!==actor||job.value.origin!==url.origin)fail('Pregled nije pronađen. Ponovite proveru.',404);
      const review=job.value;
      if(input.confirmNetwork!==review.plan.networkCode)fail('Potvrdite prikazanu GAM mrežu.');
      const stored=await read(bucket,`${prefix}results/${id}.json`);if(stored)return json(await withSite(stored.value));
      if(review.expiresAt<Date.now())fail('Pregled je istekao. Ponovite proveru u GAM-u.',409);
      const connection=await connected(review.plan.networkCode);
      if(connection.revision!==review.connectionRevision)fail('GAM konekcija je promenjena. Ponovite proveru.',409);
      if(review.plan.siteId)await planSiteInventory(sites,review.plan.siteId,{parentPath:review.preview.parent.path,rows:review.preview.rows,revision:review.siteSync.revision});
      // One attempt per review. A failed or interrupted call requires a fresh read-only preview.
      // Never automatically retry an uncertain Google mutation.
      if(!await write(bucket,`${prefix}attempts/${id}.json`,{actor,startedAt:new Date().toISOString()},{onlyIf:{etagDoesNotMatch:'*'}}))fail('Ovaj upis je već pokrenut. Ponovite proveru u GAM-u da vidite stvarno stanje.',409);
      const client=await makeClient(connection),network=await client.network();
      const fresh=await buildPreview(client,network,review.plan);
      if(fresh.counts.conflict)fail('Postoji konflikt. Ponovite pregled i ispravite nazive.',409);
      if(JSON.stringify(fresh)!==JSON.stringify(review.preview))fail('GAM stanje je promenjeno od pregleda. Ponovite proveru pre kreiranja.',409);
      let parent=fresh.parent;
      if(parent.state==='new'){
        const created=await client.create([{name:review.plan.parent.name,code:review.plan.parent.code,description:`Parent ad unit for ${review.plan.parent.code}`}],network.rootId);
        if(created.length!==1)fail('Ishod kreiranja parenta nije potvrđen. Ponovite proveru.',502);
        parent=created[0];
        if(parent.parentId!==network.rootId||parent.code!==review.plan.parent.code)fail('GAM parent odgovor ne odgovara zahtevu. Ponovite proveru.',502);
      }
      const output=fresh.rows.filter(x=>x.state==='existing').map(x=>({name:x.name,code:x.code,id:x.existing.id,state:'existing',path:gamPath(network.networkCode,network.rootId,x.existing),differences:x.differences,sizes:[...x.existing.sizes.map(s=>`${s.width}x${s.height}`),...(x.existing.fluid?['fluid']:[])].join('; '),mapKey:x.mapKey}));
      const pending=fresh.rows.filter(x=>x.state==='new');let error=null;
      // Bounded batches keep the API request below Worker subrequest limits.
      for(let offset=0;offset<pending.length;offset+=20){
        const batch=pending.slice(offset,offset+20);
        try{
          const created=await client.create(batch,parent.id);
          if(created.length!==batch.length||created.some(u=>u.parentId!==parent.id||!batch.some(b=>b.code===u.code&&b.name===u.name)))throw new GamError('GAM odgovor nije potvrdio ceo paket. Ponovite proveru.',502);
          output.push(...created.map(u=>({name:u.name,code:u.code,id:u.id,state:'created',path:gamPath(network.networkCode,network.rootId,u),sizes:[...u.sizes.map(s=>`${s.width}x${s.height}`),...(u.fluid?['fluid']:[])].join('; '),mapKey:batch.find(b=>b.code===u.code)?.mapKey})));
        }catch(e){error=e instanceof GamError?e.message:'Upis nije potvrđen. Ponovite proveru u GAM-u.';break;}
      }
      const result={id,...(review.plan.siteId?{siteId:review.plan.siteId}:{}),networkCode:network.networkCode,siteLabel:review.plan.siteLabel,parentId:parent.id,completed:!error,error,createdAt:new Date().toISOString(),rows:review.plan.rows.map(r=>output.find(x=>x.code===r.code)||{name:r.name,code:r.code,state:'unconfirmed',id:null,path:null})};
      // Persist the Google outcome first. A local failure never retries Google creation.
      await write(bucket,`${prefix}results/${id}.json`,result,{onlyIf:{etagDoesNotMatch:'*'}});
      if(result.siteId){
        const rows=result.rows.filter(r=>r.id&&r.path&&['created','existing'].includes(r.state));
        if(rows.length)try{
          const local=await planSiteInventory(sites,result.siteId,{rows,parentPath:fresh.parent.path,revision:review.siteSync.revision});
          return json({...result,siteSync:await sites.commit(local,actor,id)});
        }catch(e){return json({...result,siteSync:{state:'pending',siteId:result.siteId,error:e instanceof GamError?e.message:'GAM je sačuvan. Proverite upis u sajt za nastavak.'}});}
      }
      return json(await withSite(result));
    }
    if(path==='/history'&&request.method==='GET'){
      const items=[];if(bucket){const list=await bucket.list({prefix:prefix+'results/',limit:100});for(const object of list.objects){const result=await read(bucket,object.key);if(result)items.push(await withSite(result.value));}}
      return json({results:items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }
    return json({error:'GAM operacija nije pronađena.'},404);
  }catch(error){return json({error:error instanceof GamError?error.message:'GAM operacija nije uspela. Sačuvani podaci nisu dostupni; pokušajte ponovo.'},error instanceof GamError?error.status:500);}
}
