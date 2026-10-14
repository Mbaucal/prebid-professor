import {organizationDdl,validOrganizationObjects} from './schema.mjs';

class OrganizationError extends Error { constructor(status,message){super(message);this.status=status;} }
const fail=(status,message)=>{throw new OrganizationError(status,message);};
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'private, no-store','x-content-type-options':'nosniff'}});
const idPattern=/^[a-z0-9][a-z0-9-]{0,97}$/;
const sources={
  production:'SELECT id,created_at FROM publisher_accounts',
  // Examples in the isolated TEST UI only. Never sourced from live publishers.
  test:"SELECT 'example-publisher' AS id,'test-example-v1' AS created_at UNION ALL SELECT 'example-news','test-example-v1' UNION ALL SELECT 'example-media','test-example-v1'",
};
async function schemaReady(db) {
  const {results}=await db.prepare("SELECT name,type,sql FROM sqlite_master WHERE name GLOB 'organization_*' ORDER BY name").all();
  if(!results.length)return false;
  if(!validOrganizationObjects(results))fail(409,'Agency storage does not match the supported schema. No changes were made.');
  return true;
}
async function ensureSchema(db) {
  if(await schemaReady(db))return;
  try {await db.batch(organizationDdl.map(sql=>db.prepare(sql)));}
  catch(error){if(!await schemaReady(db))throw error;}
}
function logoValue(value) {
  if(value===null)return null;
  if(typeof value!=='string'||value.length>180000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value))fail(422,'Use a PNG logo up to 128 KB.');
  let bytes;try{bytes=Uint8Array.from(atob(value.slice(22)),c=>c.charCodeAt(0));}catch{fail(422,'Invalid PNG logo.');}
  const bad=()=>fail(422,'Invalid PNG logo.');
  if(bytes.length>131072||bytes.length<45||[137,80,78,71,13,10,26,10].some((b,i)=>bytes[i]!==b))bad();
  const view=new DataView(bytes.buffer);let offset=8,hasData=false,ended=false;
  while(offset+12<=bytes.length){
    const length=view.getUint32(offset),type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
    if(length>bytes.length-offset-12)bad();
    if(offset===8&&(type!=='IHDR'||length!==13||view.getUint32(offset+8)<1||view.getUint32(offset+8)>512||view.getUint32(offset+12)<1||view.getUint32(offset+12)>512))bad();
    if(type==='IDAT')hasData=true;
    offset+=length+12;
    if(type==='IEND'){if(length!==0||offset!==bytes.length)bad();ended=true;break;}
  }
  if(!hasData||!ended)bad();
  return value;
}
async function body(request,allowed) {
  if(request.headers.get('content-type')?.split(';')[0]!=='application/json')fail(415,'Send JSON.');
  const reader=request.body?.getReader();if(!reader)fail(400,'JSON body required.');
  let size=0,chunks=[];
  while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>190000){await reader.cancel();fail(413,'Request is too large.');}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let data;try{data=JSON.parse(new TextDecoder().decode(bytes));}catch{fail(400,'Invalid JSON.');}
  if(!data||Array.isArray(data)||typeof data!=='object'||Object.keys(data).some(key=>!allowed.includes(key)))fail(422,'Unexpected agency fields.');
  return data;
}
function revision(value){if(!Number.isSafeInteger(value)||value<0)fail(422,'Reload before saving: expected revision is required.');return value;}
function agencyFields(input){
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120)fail(422,'Agency name must contain 1–120 characters.');
  return {name:input.name.trim(),logo:logoValue(input.logo??null)};
}
async function snapshot(db,source){
  if(!await schemaReady(db))return {agencies:[],memberships:[]};
  const [agencies,links]=await db.batch([
    db.prepare('SELECT id,name,logo,revision,created_at AS createdAt,updated_at AS updatedAt FROM organization_agencies ORDER BY name COLLATE NOCASE,id'),
    db.prepare(`SELECT l.publisher_id AS publisherId,l.agency_id AS agencyId,l.revision FROM organization_links l JOIN (${source}) p ON p.id=l.publisher_id AND p.created_at=l.publisher_created_at ORDER BY l.publisher_id`),
  ]);
  return {agencies:agencies.results,memberships:links.results};
}
export async function organizationResponse(request,env,actor,{prefix='/api/organization',mode='production'}={}) {
  try{
    const url=new URL(request.url),path=url.pathname.slice(prefix.length),source=sources[mode];
    if(!actor)fail(401,'Sign in to manage agencies.');
    if(!source||!url.pathname.startsWith(prefix)||url.search)fail(404,'Unknown agency operation.');
    if(!['GET','POST'].includes(request.method))fail(405,'Method not allowed.');
    if(request.method==='POST'&&request.headers.get('origin')!==url.origin)fail(403,'Same-origin request required.');
    const db=env.DB?.withSession?env.DB.withSession('first-primary'):env.DB;
    if(!db)fail(503,'Agency storage is unavailable.');
    if(path===''&&request.method==='GET')return reply(await snapshot(db,source));
    const edit=path.match(/^\/agencies\/([a-z0-9-]+)$/),move=path.match(/^\/publishers\/([a-z0-9-]+)\/agency$/);
    if(request.method!=='POST'||(!edit&&!move&&path!=='/agencies'))fail(404,'Unknown agency operation.');
    const now=new Date().toISOString(),operation=crypto.randomUUID();
    if(move){
      const input=await body(request,['agencyId','expectedRevision']);
      const expected=revision(input.expectedRevision),publisherId=move[1];
      if(!idPattern.test(publisherId)||(input.agencyId!==null&&(typeof input.agencyId!=='string'||!idPattern.test(input.agencyId))))fail(422,'Invalid publisher or agency.');
      if(!await db.prepare(`SELECT id FROM (${source}) WHERE id=?`).bind(publisherId).first())fail(404,'Publisher no longer exists. Reload the hierarchy.');
      await ensureSchema(db);
      if(input.agencyId!==null&&!await db.prepare('SELECT id FROM organization_agencies WHERE id=?').bind(input.agencyId).first())fail(404,'Agency no longer exists. Reload the hierarchy.');
      const result=await db.batch([
        db.prepare(`INSERT INTO organization_links (publisher_id,publisher_created_at,agency_id,revision,updated_at,mutation_id)
          SELECT id,created_at,?,1,?,? FROM (${source}) p WHERE id=? AND (?=0 OR EXISTS(SELECT 1 FROM organization_links l WHERE l.publisher_id=p.id AND l.publisher_created_at=p.created_at))
          ON CONFLICT(publisher_id) DO UPDATE SET publisher_created_at=excluded.publisher_created_at,agency_id=excluded.agency_id,revision=CASE WHEN organization_links.publisher_created_at=excluded.publisher_created_at THEN organization_links.revision+1 ELSE 1 END,updated_at=excluded.updated_at,mutation_id=excluded.mutation_id
          WHERE (organization_links.publisher_created_at=excluded.publisher_created_at AND organization_links.revision=?) OR (organization_links.publisher_created_at<>excluded.publisher_created_at AND ?=0)`)
          .bind(input.agencyId,now,operation,publisherId,expected,expected,expected),
        db.prepare("INSERT INTO organization_events SELECT ?,?,'publisher.agency_changed',?,?,? WHERE EXISTS(SELECT 1 FROM organization_links WHERE mutation_id=?)")
          .bind(operation,actor,publisherId,JSON.stringify({agencyId:input.agencyId,previousRevision:expected}),now,operation),
      ]);
      if(result[0].meta.changes!==1)fail(409,'This publisher changed in another window. Reload before moving it.');
    }else{
      const input=await body(request,edit?['name','logo','expectedRevision']:['name','logo']);
      const fields=agencyFields(input),expected=edit?revision(input.expectedRevision):null,id=edit?edit[1]:crypto.randomUUID();
      if(!idPattern.test(id))fail(422,'Invalid agency ID.');
      await ensureSchema(db);
      const write=edit?db.prepare('UPDATE organization_agencies SET name=?,logo=?,revision=revision+1,updated_at=?,mutation_id=? WHERE id=? AND revision=?').bind(fields.name,fields.logo,now,operation,id,expected)
        :db.prepare('INSERT INTO organization_agencies VALUES (?,?,?,1,?,?,?)').bind(id,fields.name,fields.logo,now,now,operation);
      const result=await db.batch([write,db.prepare('INSERT INTO organization_events SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM organization_agencies WHERE mutation_id=?)')
        .bind(operation,actor,edit?'agency.updated':'agency.created',id,JSON.stringify({name:fields.name,hasLogo:!!fields.logo}),now,operation)]);
      if(result[0].meta.changes!==1)fail(409,'This agency changed in another window. Reload before saving.');
    }
    return reply(await snapshot(db,source),path==='/agencies'?201:200);
  }catch(error){
    if(error instanceof OrganizationError)return reply({error:error.message},error.status);
    if(/UNIQUE constraint failed: organization_agencies.name/i.test(String(error)))return reply({error:'An agency with this name already exists.'},409);
    return reply({error:'Agency changes could not be confirmed. Reload the hierarchy before retrying.'},503);
  }
}
