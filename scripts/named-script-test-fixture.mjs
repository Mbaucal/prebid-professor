// LOCAL compiled TEST Worker, ephemeral real D1/R2, no Cloudflare or outbound traffic.
import {Miniflare} from './local-miniflare.mjs';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {initializeTestSchema} from '../worker/test-workspace/schema.mjs';

export const ORIGIN='https://prebid-professor-test.mbaucal.workers.dev';
export const EMAIL='tester@example.invalid';
export const PASSWORD='Local-named-fixture-only-927!';
export async function namedScriptFixture(){
  const directory=await mkdtemp(join(tmpdir(),'named-script-test-'));
  const config=JSON.parse(await readFile('ops/runtime-test/wrangler.active.jsonc','utf8'));
  const compiled='.generated/test-workspace-active-dry-run';
  const files=(await readdir(compiled)).filter(name=>/\.m?js$/.test(name));
  if(files.length!==1)throw Error('Compile the exact active TEST Worker first.');
  let outbound=0;
  const mf=new Miniflare({modules:true,script:await readFile(join(compiled,files[0]),'utf8'),
    compatibilityDate:config.compatibility_date,compatibilityFlags:config.compatibility_flags,cf:false,
    resourcePersistencePath:directory,d1Databases:{DB:'local-named-script'},r2Buckets:{BUILDS:'local-named-script'},
    bindings:{...config.vars,TEST_ADMIN_EMAIL:EMAIL,TEST_ADMIN_PASSWORD:PASSWORD,TEST_SESSION_SECRET:randomBytes(48).toString('hex')},
    outboundService:()=>{outbound++;return new Response('External traffic forbidden',{status:503});}});
  await mf.ready;
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('BUILDS');
  // Only prepares the original empty synthetic workspace. Named setup stays an explicit HTTP action.
  await initializeTestSchema(db,EMAIL);
  return {mf,db,bucket,outbound:()=>outbound,async close(){await mf.dispose();await rm(directory,{recursive:true,force:true});}};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  const fixture=await namedScriptFixture();
  if(process.env.NAMED_TEST_SCENARIO==='collision')await fixture.db.prepare("UPDATE publishers SET domain='tanjug.rs' WHERE id='test-site'").run();
  console.log(JSON.stringify({ready:true}));
  try{for await(const line of createInterface({input:process.stdin})){
    try{
      const input=JSON.parse(line);
      if(new URL(input.path,ORIGIN).origin!==ORIGIN||!input.path.startsWith('/'))throw Error('Only local fixture paths are allowed.');
      const response=await fixture.mf.dispatchFetch(ORIGIN+input.path,{method:input.method,redirect:'manual',headers:input.headers||{},body:input.body||undefined});
      console.log(JSON.stringify({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer()).toString('base64')}));
    }catch(error){console.log(JSON.stringify({error:error.message}));}
  }}finally{await fixture.close();}
}
