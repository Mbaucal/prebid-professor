/** Actual built Worker HTTP route vs unchanged root compiler; local synthetic input only. */
import assert from 'node:assert/strict';
import {verifyIsolation} from '../scripts/verify-toolchain-isolation.mjs';
import {createHash,createHmac,randomBytes} from 'node:crypto';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {zipSync,unzipSync} from '../node_modules/fflate/esm/index.mjs';
import {fixture,configure,takeOver,pin} from '../tests/runtime/artifact-fixture.mjs';
import {buildArtifactCandidate} from '../worker/runtime/artifact-candidate.mjs';
import {readPreviewSnapshot,runtimeDescriptor} from '../worker/runtime/builtin-preview-service.mjs';
import {digest} from '../worker/runtime/preview-snapshot.mjs';
// ZIP DOS timestamps use local getters; workerd is UTC. Match that explicit environment.
process.env.TZ='UTC';
const root=resolve(import.meta.dirname,'..');
await verifyIsolation(root);
const script=await readFile(resolve(root,'dist/prebid_professor/index.js'),'utf8');
const sha=b=>createHash('sha256').update(b).digest('hex');
const secret=randomBytes(40).toString('hex'),email='fixture@example.invalid',origin='https://fixture.invalid';
let external=0;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,compatibilityDate:'2026-07-15',compatibilityFlags:['nodejs_compat'],cf:false,host:'127.0.0.1',port:0,d1Databases:{DB:'parity-local'},r2Buckets:{BUILDS:'parity-local'},bindings:{ADMIN_EMAIL:email,ADMIN_PASSWORD:'fixture-only-password',SESSION_SECRET:secret},outboundService:()=>{external++;return new Response('External traffic blocked',{status:503});}}));
try {
 await mf.ready;const db=await mf.getD1Database('DB');
 // Real local SQL storage, using the repository schema. No remote bindings.
 const schema=await readFile(resolve(root,'migrations/0001_initial.sql'),'utf8');
 for(const statement of schema.split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(statement).run();
 const source=configure(fixture(),c=>{c.enablePrebid=false;});
 for(const [table,rows] of Object.entries({publishers:[source.site],publisher_configs:[{id:'config',publisher_id:'test-site',...source.config}],ad_units:source.units,bidders:source.bidders,bidder_overrides:source.overrides,size_maps:source.maps,unit_rules:source.rules})){
  for(const [i,row] of rows.entries()){
   const data=['publishers','publisher_configs'].includes(table)?row:{id:`${table}-${i}`,publisher_id:'test-site',...row};
   const columns=Object.keys(data);await db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).bind(...Object.values(data)).run();
  }
 }
 const snapshot=await readPreviewSnapshot(db,'test-site');
 const now=Math.floor(Date.now()/1000),payload=Buffer.from(JSON.stringify({version:1,email,issuedAt:now,expiresAt:now+3600})).toString('base64url');
 const cookie=`__Host-pp_session=${payload}.${createHmac('sha256',secret).update(payload).digest('base64url')}`;
 const url=origin+'/api/publishers/test-site/builtin-runtime-bundle';
 const body=JSON.stringify({reviewHash:await digest(snapshot),runtimeVersion:runtimeDescriptor.version,runtimeSha256:runtimeDescriptor.codeSha256,allowPreview:true,takeOver:takeOver()});
 assert.equal((await mf.dispatchFetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body})).status,401);
 assert.equal((await mf.dispatchFetch(url,{method:'POST',headers:{cookie,origin:'https://foreign.invalid','content-type':'application/json'},body})).status,403);
 const response=await mf.dispatchFetch(url,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body});
 if(response.status!==200)throw Error(`Compiled generator returned ${response.status}: ${await response.text()}`);
 const buildTimestamp=response.headers.get('content-disposition').match(/candidate-(\d{8}_\d{6})\.zip/)[1];
 const actual=new Uint8Array(await response.arrayBuffer());
 const reference=await buildArtifactCandidate({snapshot,pin:pin(),takeOver:takeOver(),buildTimestamp,prebid:null});
 const files=Object.fromEntries(Object.entries(reference.files).map(([name,data])=>[name,[data,{level:0,mtime:new Date('1980-01-01T00:00:00Z')}]]));
 const expected=zipSync(files,{level:0});assert.deepEqual(actual,expected,'Compiled Worker ZIP must match the original compiler for identical input/time');
 const unpacked=unzipSync(actual);for(const [name,data] of Object.entries(reference.files))assert.deepEqual(unpacked[name],data,name);
 assert.equal(external,0);
 const report={passed:true,scope:'Local compiled Worker HTTP generator; same captured timestamp and SQL snapshot supplied to original compiler. No deployment or live ad traffic.',workerSha256:sha(script),runtimeSha256:runtimeDescriptor.codeSha256,buildTimestamp,zipSha256:sha(actual),fileHashes:Object.fromEntries(Object.entries(unpacked).map(([n,b])=>[n,sha(b)])),externalRequests:external,authAndOriginEnforced:true};
 await mkdir(resolve(root,'.generated/toolchain-validation'),{recursive:true});await writeFile(resolve(root,'.generated/toolchain-validation/compiled-parity.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
}finally{await mf.dispose();}
