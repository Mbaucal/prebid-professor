import { XMLParser } from '../../vendor/gam-xml-parser/parser.mjs';
import { GamError, numericId, parseSizes } from '../../shared/gam/plan.mjs';

export const API_VERSION = 'v202608';
const encoder = new TextEncoder();
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const b64url = bytes => base64(bytes).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
export const xml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const array = value => value == null || value === '' ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({removeNSPrefix:true,parseTagValue:false,ignoreAttributes:true});
// workerd requires the native fetch receiver; do not store native fetch as a class method.
const runtimeFetch = (url, options) => fetch(url, options);
const redirected = response => response.status >= 300 && response.status < 400;

export function validateCredential(input) {
  if (!input || input.type !== 'service_account' || typeof input.client_email !== 'string' || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/.test(input.client_email)
      || typeof input.private_key !== 'string' || input.private_key.length > 12000 || !input.private_key.startsWith('-----BEGIN PRIVATE KEY-----')) throw new GamError('Izaberite Google service account JSON ključ.');
  return {type:'service_account',client_email:input.client_email,private_key:input.private_key};
}
export async function accessToken(input, fetcher = runtimeFetch) {
  const account = validateCredential(input), now = Math.floor(Date.now()/1000);
  let key;
  try {
    const der = Uint8Array.from(atob(account.private_key.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),c=>c.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8',der,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  } catch { throw new GamError('Privatni ključ nije ispravan. Ponovo izaberite originalni JSON fajl.'); }
  const claims = {iss:account.client_email,scope:'https://www.googleapis.com/auth/admanager',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600};
  const unsigned = `${b64url(encoder.encode(JSON.stringify({alg:'RS256',typ:'JWT'})))}.${b64url(encoder.encode(JSON.stringify(claims)))}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,encoder.encode(unsigned));
  let response;
  // Workers reject redirect:'error' before sending; manual + status check also prevents forwarding credentials.
  try { response = await fetcher('https://oauth2.googleapis.com/token',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(20000),headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${unsigned}.${b64url(signature)}`})}); }
  catch { throw new GamError('Google prijava trenutno nije dostupna. Pokušajte ponovo.',502); }
  if (redirected(response)) throw new GamError('Google prijava je vratila neočekivano preusmerenje. Zahtev nije prosleđen.',502);
  const result = await response.json().catch(()=>({}));
  if (!response.ok || typeof result.access_token !== 'string') throw new GamError('Google nije prihvatio service account ključ. Proverite da li je ključ aktivan.',502);
  return result.access_token;
}

export function parseResponse(source, operation) {
  if (source.length > 3000000 || /<!DOCTYPE|<!ENTITY/i.test(source)) throw new GamError('Neočekivan GAM odgovor.',502);
  let body;
  try { body = parser.parse(source)?.Envelope?.Body; } catch { throw new GamError('GAM je vratio neispravan odgovor.',502); }
  if (body?.Fault) {
    const errors = array(body.Fault.detail?.ApiExceptionFault?.errors);
    const reasons = errors.map(x=>x.reason).filter(x=>typeof x==='string'&&/^[A-Z0-9_]+$/.test(x));
    throw new GamError(`GAM je odbio zahtev${reasons.length ? ': '+[...new Set(reasons)].join(', ') : '. Proverite API pristup i prava service account-a'}.`,502);
  }
  if (!body || !Object.hasOwn(body,`${operation}Response`)) throw new GamError('GAM odgovor nema očekivani rezultat.',502);
  return body[`${operation}Response`]?.rval;
}
export function normalizeUnit(row) {
  return {id:numericId(String(row.id)),parentId:row.parentId?String(row.parentId):'',name:String(row.name),code:String(row.adUnitCode),status:String(row.status),description:String(row.description || ''),
    sizes:array(row.adUnitSizes).map(x=>({width:Number(x.size?.width),height:Number(x.size?.height)})),fluid:row.isFluid==='true',
    parentPath:array(row.parentPath).map(x=>({id:String(x.id),code:String(x.adUnitCode),name:String(x.name)}))};
}
export function unitPayload(row, parentId) {
  const parsed = row.sizes ? parseSizes(row.sizes) : null;
  return `<adUnits><parentId>${xml(numericId(parentId))}</parentId><name>${xml(row.name)}</name><description>${xml(row.description || '')}</description><adUnitCode>${xml(row.code)}</adUnitCode>`+
    (parsed ? parsed.sizes.map(s=>`<adUnitSizes><size><width>${s.width}</width><height>${s.height}</height><isAspectRatio>false</isAspectRatio></size><environmentType>BROWSER</environmentType></adUnitSizes>`).join('')+`<isFluid>${parsed.fluid}</isFluid>` : '')+'</adUnits>';
}
export class GamClient {
  constructor(networkCode, token, fetcher = runtimeFetch) { this.networkCode=numericId(networkCode);this.token=token;this.fetcher=fetcher; }
  async call(service,operation,content='') {
    const ns = `https://www.google.com/apis/ads/publisher/${API_VERSION}`;
    const body = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header><RequestHeader xmlns="${ns}"><networkCode>${this.networkCode}</networkCode><applicationName>Tessera API Integrations</applicationName></RequestHeader></soap:Header><soap:Body><${operation} xmlns="${ns}">${content}</${operation}></soap:Body></soap:Envelope>`;
    let response;
    try { response = await this.fetcher(`https://ads.google.com/apis/ads/publisher/${API_VERSION}/${service}`,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(25000),headers:{authorization:`Bearer ${this.token}`,'content-type':'text/xml; charset=utf-8',SOAPAction:''},body}); }
    catch { throw new GamError(operation.startsWith('create')?'Ishod GAM upisa nije poznat. Ponovite proveru postojećih entiteta pre nastavka.':'GAM trenutno nije dostupan. Pokušajte ponovo.',502); }
    if (redirected(response)) throw new GamError('GAM je vratio neočekivano preusmerenje. Zahtev nije prosleđen.',502);
    const result = parseResponse(await response.text(),operation);
    if (!response.ok) throw new GamError('GAM zahtev nije uspeo. Ponovite proveru pre nastavka.',502);
    return result;
  }
  async network() {
    const n=await this.call('NetworkService','getCurrentNetwork');
    if(String(n?.networkCode)!==this.networkCode)throw new GamError('GAM mreža ne odgovara izabranom network code-u.',409);
    return {networkCode:this.networkCode,name:String(n.displayName),rootId:numericId(String(n.effectiveRootAdUnitId))};
  }
  async list(where) {
    const result=[];
    for(let offset=0;offset<10000;offset+=500){
      const page=await this.call('InventoryService','getAdUnitsByStatement',`<filterStatement><query>${xml(`WHERE ${where} ORDER BY id ASC LIMIT 500 OFFSET ${offset}`)}</query></filterStatement>`);
      const rows=array(page?.results).map(normalizeUnit);result.push(...rows);
      if(offset+rows.length>=Number(page?.totalResultSetSize || 0))return result;
      if(!rows.length)throw new GamError('GAM nije vratio kompletnu listu. Suzite izbor parenta.',502);
    }
    throw new GamError('Parent ima previše pozicija za ovaj grupni unos. Izaberite uži parent.');
  }
  async get(id) { const rows=await this.list(`id = ${numericId(id)}`);if(rows.length!==1)throw new GamError('Parent nije pronađen u ovoj GAM mreži.',404);return rows[0]; }
  children(id) { return this.list(`parentId = ${numericId(id)}`); }
  async create(rows,parentId) { return array(await this.call('InventoryService','createAdUnits',rows.map(r=>unitPayload(r,parentId)).join(''))).map(normalizeUnit); }
}
export function gamPath(networkCode, rootId, unit) {
  return '/'+[networkCode,...unit.parentPath.filter(p=>p.id!==rootId).map(p=>p.code),...(unit.id===rootId?[]:[unit.code])].join('/');
}
