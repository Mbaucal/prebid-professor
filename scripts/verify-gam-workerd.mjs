/** Real compiled TEST Worker and native workerd fetch; all Google responses stay local.
 * Fresh synthetic credentials exist only in memory. No remote account or inventory is touched.
 */
import assert from 'node:assert/strict';
import {generateKeyPairSync, randomBytes, verify} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Miniflare} from 'miniflare';
import {soapTrafficFixture} from '../tests/gam/soap-traffic-fixture.mjs';
import {prebidPlan} from '../tests/gam/traffic-fixture.mjs';
const traffic=soapTrafficFixture();let trafficMode=false;

const compiled = process.argv[2] || '.generated/gam-worker-dry-run';
const names = (await readdir(compiled)).filter(name => /\.(mjs|js)$/.test(name));
assert.equal(names.length, 1, 'One Wrangler-compiled Worker is required');
const script = await readFile(join(compiled, names[0]), 'utf8');
const config = JSON.parse(await readFile('ops/runtime-test/wrangler.active.jsonc', 'utf8'));
assert.equal(config.name, 'prebid-professor-test');
const origin = config.vars.TEST_PUBLIC_ORIGIN;
const directory = await mkdtemp(join(tmpdir(), 'tessera-gam-workerd-'));
const {privateKey, publicKey} = generateKeyPairSync('rsa', {modulusLength:2048});
const credentials = {type:'service_account', client_email:'fixture@fixture.iam.gserviceaccount.com',
  private_key:privateKey.export({type:'pkcs8', format:'pem'}), token_uri:'https://unexpected.invalid/token'};
const bindings = {...config.vars, TEST_ADMIN_EMAIL:'fixture@example.invalid',
  TEST_ADMIN_PASSWORD:randomBytes(24).toString('base64url'),
  TEST_SESSION_SECRET:randomBytes(48).toString('base64url'),
  GAM_CREDENTIALS_KEY:randomBytes(48).toString('base64url')};
const events = [], checks = [], failures = [];
const token = 'synthetic-oauth-access-token';
const safeMarker = 'SYNTHETIC_UPSTREAM_DETAIL_MUST_STAY_PRIVATE';
let mode = 'success', cookie = '', mf;
const checked = (name, condition = true) => { assert(condition, name); checks.push(name); };
const soap = (operation, value) => new Response(`<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${operation}Response><rval>${value}</rval></${operation}Response></soap:Body></soap:Envelope>`, {headers:{'content-type':'text/xml'}});
async function outbound(request) {
  try {
    const url = new URL(request.url);
    events.push({host:url.hostname, path:url.pathname, method:request.method, mode});
    assert.equal(request.method, 'POST');
    // The Node outbound bridge reconstructs Request metadata; verify redirect
    // refusal by the observable 307 response and absence of a second destination.
    if (request.url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, payload, signature] = form.get('assertion').split('.');
      assert(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
      const claims = JSON.parse(Buffer.from(payload, 'base64url'));
      assert.equal(claims.iss, credentials.client_email);
      assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
      assert.equal(claims.exp - claims.iat, 3600);
      if (mode === 'oauth-redirect') return new Response(null, {status:307, headers:{location:'https://unexpected.invalid/capture'}});
      if (mode === 'oauth-rejected') return Response.json({error:'invalid_grant', error_description:safeMarker}, {status:400});
      return Response.json({access_token:token});
    }
    assert.equal(url.hostname, 'ads.google.com');
    assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
    const body = await request.text();
    if (mode === 'soap-redirect') return new Response(null, {status:307, headers:{location:'https://unexpected.invalid/capture'}});
    if (mode === 'soap-rejected') return new Response(`<Envelope><Body><Fault><detail><ApiExceptionFault><errors><reason>PERMISSION_DENIED</reason><trigger>${safeMarker}</trigger></errors></ApiExceptionFault></detail></Fault></Body></Envelope>`, {status:500});
    if (url.pathname.endsWith('/NetworkService')) {
      assert(body.includes('<getCurrentNetwork '));
      return soap('getCurrentNetwork', '<networkCode>123456</networkCode><displayName>Synthetic GAM</displayName><effectiveRootAdUnitId>1</effectiveRootAdUnitId><currencyCode>EUR</currencyCode><timeZone>Europe/Belgrade</timeZone>');
    }
    if(trafficMode)return await traffic.respond(body,url.pathname);
    assert(url.pathname.endsWith('/InventoryService'));
    assert(body.includes('<getAdUnitsByStatement '));
    assert(!body.includes('createAdUnits'));
    if (body.includes('WHERE id = 1 ')) return soap('getAdUnitsByStatement', '<totalResultSetSize>1</totalResultSetSize><results><id>1</id><name>Root</name><adUnitCode>root</adUnitCode><status>ACTIVE</status></results>');
    assert(body.includes('WHERE parentId = 1 '));
    return soap('getAdUnitsByStatement', '<totalResultSetSize>0</totalResultSetSize>');
  } catch (error) {
    failures.push({name:error.name, message:error.message});
    return new Response('Synthetic outbound verification failed', {status:500});
  }
}
async function call(path, body) {
  const response = await mf.dispatchFetch(origin + '/test-api/integrations/gam' + path, {
    method:body ? 'POST' : 'GET', headers:{cookie, origin, 'content-type':'application/json'},
    body:body ? JSON.stringify(body) : undefined,
  });
  return {status:response.status, data:await response.json()};
}
const connect = () => call('/connect', {networkCode:'123456', credentials});
try {
  mf = new Miniflare({modules:true, script, compatibilityDate:config.compatibility_date,
    cf:false, host:'127.0.0.1', port:0, resourcePersistencePath:directory, bindings,
    d1Databases:{DB:'local-gam-database'}, r2Buckets:{BUILDS:'local-gam-files'}, outboundService:outbound});
  const login = await mf.dispatchFetch(origin + '/api/auth/login', {method:'POST', redirect:'manual',
    headers:{origin, 'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({email:bindings.TEST_ADMIN_EMAIL, password:bindings.TEST_ADMIN_PASSWORD}).toString()});
  assert.equal(login.status, 303);
  cookie = login.headers.get('set-cookie').split(';')[0];

  const connected = await connect();
  assert.equal(failures.length, 0, JSON.stringify(failures));
  assert.equal(connected.status, 201, connected.data.error);
  checked('Native Worker fetch completes OAuth and GAM network verification', connected.data.connection.networkCode === '123456');
  checked('Connection response excludes credentials', !('sealed' in connected.data.connection) && !JSON.stringify(connected).includes('PRIVATE KEY'));
  const bucket = await mf.getR2Bucket('BUILDS');
  const stored = await (await bucket.get('api-integrations/gam/v1/connections/123456.json')).text();
  checked('Real local R2 stores only encrypted private-key material', !stored.includes('PRIVATE KEY') && Boolean(JSON.parse(stored).sealed));
  const parents = await call('/parents?network=123456');
  assert.equal(parents.status, 200, parents.data.error);
  checked('Stored credential decrypts and native class-backed SOAP fetch reads inventory', parents.data.parent.id === '1' && parents.data.units.length === 0);

  trafficMode=true;
  const users=await call('/line-items/lookups?network=123456&kind=user');
  assert.equal(users.status,200,JSON.stringify(users.data));
  checked('Trafficker lookup uses supported status PQL and excludes inactive users',users.data.items.length===1&&users.data.items[0].id==='30');
  async function trafficJob(plan){
    let r=await call('/line-items/preview',plan);assert.equal(r.status,201,JSON.stringify(r.data));let j=r.data;
    while(j.status==='reviewing'){r=await call(`/line-items/jobs/${j.id}/review`,{cursor:j.cursor});assert.equal(r.status,200,JSON.stringify(r.data));j=r.data;}
    assert.equal(j.conflictCount,0,JSON.stringify(j.conflicts));
    r=await call(`/line-items/jobs/${j.id}/start`,{confirm:true,confirmNetwork:'123456'});assert.equal(r.status,200,JSON.stringify(r.data));j=r.data;
    for(let i=0;j.status==='creating'&&i<100;i++){r=await call(`/line-items/jobs/${j.id}/step`,{cursor:j.cursor});assert.equal(r.status,200,JSON.stringify(r.data));j=r.data;assert.equal(j.error,'',JSON.stringify(j));}
    assert.equal(j.status,'completed');return j;
  }
  const prebid=await trafficJob({...prebidPlan(),creative:{...prebidPlan().creative,layout:'per-price'},advertiser:{mode:'new',name:'Native Prebid'},order:{mode:'new',name:'Native Prebid order',traffickerId:'30'}});
  checked('Native SOAP creates advertiser, order, hb_pb values, CPM-named creatives, priced line items and size-override links',prebid.counts.lineItem.created===3&&prebid.counts.creative.created===6&&prebid.counts.association.created===6);
  const count=traffic.calls.length;
  await trafficJob({...prebidPlan(),creative:{...prebidPlan().creative,layout:'per-price'},advertiser:{mode:'new',name:'Native Prebid'},order:{mode:'new',name:'Native Prebid order',traffickerId:'30'}});
  checked('Native SOAP replay reuses matching entities without new writes',traffic.calls.length===count);
  const single=await trafficJob({...prebidPlan(),mode:'single',name:'Native Standard',lineItemType:'STANDARD',rate:'2.50',costType:'CPM',goal:100000,end:'2099-01-01T12:00',creative:{mode:'none'}});
  checked('Native SOAP ordinary Standard line item preserves goal and end date',single.counts.lineItem.created===1&&single.counts.creative.total===0);
  trafficMode=false;

  for (const nextMode of ['oauth-redirect', 'soap-redirect', 'oauth-rejected', 'soap-rejected']) {
    mode = nextMode;
    const before = events.length;
    const result = await connect();
    assert.equal(result.status, 502);
    assert(!JSON.stringify(result).includes(safeMarker));
    if (mode.endsWith('redirect')) {
      checked(`${mode} is rejected without following Location`, /preusmerenje/.test(result.data.error) && events.length - before === (mode === 'oauth-redirect' ? 1 : 2));
    } else checked(`${mode} returns the correct sanitized error`, result.data.error.includes(mode === 'oauth-rejected' ? 'nije prihvatio' : 'PERMISSION_DENIED'));
    assert.equal(await (await bucket.get('api-integrations/gam/v1/connections/123456.json')).text(), stored);
  }
  checked('No unexpected outbound requests or failed fixture checks', failures.length === 0 && events.every(e => ['oauth2.googleapis.com', 'ads.google.com'].includes(e.host)));
  const report = {scope:'Local Wrangler-compiled Worker in workerd; synthetic Google only', checks, events,
    realGoogleRequests:0, realInventoryWrites:0, passed:true};
  await mkdir('.generated/gam-ui-evidence', {recursive:true});
  await writeFile('.generated/gam-ui-evidence/workerd.json', JSON.stringify(report, null, 2));
  console.log(`PASS ${checks.length} compiled Worker OAuth/SOAP checks; no real Google requests`);
} finally {
  if (mf) await mf.dispose();
  await rm(directory, {recursive:true, force:true});
}
