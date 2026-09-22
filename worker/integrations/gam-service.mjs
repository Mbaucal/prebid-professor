import { lineItemResponse } from './line-item-service.mjs';
import { GamError, numericId, normalizePlan, compareRows, expandGroup, text } from '../../shared/gam/plan.mjs';
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
export async function gamResponse(request,env,actor,{base='/api/integrations/gam',clientFactory,tokenFactory=accessToken,trafficFactory}={}){
  try{
    const url=new URL(request.url),path=url.pathname.slice(base.length);
    if(!url.pathname.startsWith(base+'/')&&url.pathname!==base)return null;
    if(!['GET','POST'].includes(request.method))return json({error:'Method not allowed.'},405);
    if(request.method==='POST'&&(request.headers.get('origin')!==url.origin||!['same-origin','none',null].includes(request.headers.get('sec-fetch-site'))))return json({error:'Same-origin request required.'},403);
    const bucket=env.BUILDS;
    const makeClient=async connection=>clientFactory?clientFactory(connection):new GamClient(connection.networkCode,await tokenFactory(await decryptCredential(secret(env),connection.sealed,connection.networkCode)));
    const connected=async network=>{
      if(!bucket)fail('Skladište integracija nije povezano.',503);
      secret(env);const found=await read(bucket,connectionKey(network));if(!found)fail('Prvo povežite ovu GAM mrežu.',409);return found.value;
    };
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
      const item={id:crypto.randomUUID(),label,pattern:text(group.pattern,'Naziv'),count:Number(group.count),start:Number(group.start),sizes:group.sizes,description:String(group.description||'').slice(0,6000),createdBy:actor};
      if((await bucket.list({prefix:prefix+'templates/',limit:100})).objects.length>=100)fail('Dostignuto je 100 sačuvanih šablona.');
      await write(bucket,`${prefix}templates/${item.id}.json`,item);return json({template:item},201);
    }
    if(path==='/preview'&&request.method==='POST'){
      const plan=normalizePlan(await body(request)),connection=await connected(plan.networkCode);
      const client=await makeClient(connection),network=await client.network();
      const preview=await buildPreview(client,network,plan),id=crypto.randomUUID();
      const value={id,actor,origin:url.origin,createdAt:new Date().toISOString(),expiresAt:Date.now()+15*60*1000,connectionRevision:connection.revision,plan,preview,network};
      await write(bucket,jobKey(id),value,{onlyIf:{etagDoesNotMatch:'*'}});
      return json({id,...preview,network,expiresAt:value.expiresAt});
    }
    if(path==='/create'&&request.method==='POST'){
      if(!bucket)fail('Skladište integracija nije povezano.',503);
      const input=await body(request),id=uuid(input.id),job=await read(bucket,jobKey(id));
      if(!job||job.value.actor!==actor||job.value.origin!==url.origin)fail('Pregled nije pronađen. Ponovite proveru.',404);
      const review=job.value;
      if(input.confirmNetwork!==review.plan.networkCode)fail('Potvrdite prikazanu GAM mrežu.');
      const stored=await read(bucket,`${prefix}results/${id}.json`);if(stored)return json(stored.value);
      if(review.expiresAt<Date.now())fail('Pregled je istekao. Ponovite proveru u GAM-u.',409);
      const connection=await connected(review.plan.networkCode);
      if(connection.revision!==review.connectionRevision)fail('GAM konekcija je promenjena. Ponovite proveru.',409);
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
      const output=fresh.rows.filter(x=>x.state==='existing').map(x=>({name:x.name,code:x.code,id:x.existing.id,state:'existing',path:gamPath(network.networkCode,network.rootId,x.existing),differences:x.differences}));
      const pending=fresh.rows.filter(x=>x.state==='new');let error=null;
      // Bounded batches keep the API request below Worker subrequest limits.
      for(let offset=0;offset<pending.length;offset+=20){
        const batch=pending.slice(offset,offset+20);
        try{
          const created=await client.create(batch,parent.id);
          if(created.length!==batch.length||created.some(u=>u.parentId!==parent.id||!batch.some(b=>b.code===u.code&&b.name===u.name)))throw new GamError('GAM odgovor nije potvrdio ceo paket. Ponovite proveru.',502);
          output.push(...created.map(u=>({name:u.name,code:u.code,id:u.id,state:'created',path:gamPath(network.networkCode,network.rootId,u)})));
        }catch(e){error=e instanceof GamError?e.message:'Upis nije potvrđen. Ponovite proveru u GAM-u.';break;}
      }
      const result={id,networkCode:network.networkCode,siteLabel:review.plan.siteLabel,parentId:parent.id,completed:!error,error,createdAt:new Date().toISOString(),rows:review.plan.rows.map(r=>output.find(x=>x.code===r.code)||{name:r.name,code:r.code,state:'unconfirmed',id:null,path:null})};
      // This immutable result is also the GAM-ID/path mapping; no site runtime is rewritten.
      await write(bucket,`${prefix}results/${id}.json`,result,{onlyIf:{etagDoesNotMatch:'*'}});
      return json(result);
    }
    if(path==='/history'&&request.method==='GET'){
      const items=[];if(bucket){const list=await bucket.list({prefix:prefix+'results/',limit:100});for(const object of list.objects){const result=await read(bucket,object.key);if(result)items.push(result.value);}}
      return json({results:items.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }
    return json({error:'GAM operacija nije pronađena.'},404);
  }catch(error){return json({error:error instanceof GamError?error.message:'GAM operacija nije uspela. Sačuvani podaci nisu dostupni; pokušajte ponovo.'},error instanceof GamError?error.status:500);}
}
