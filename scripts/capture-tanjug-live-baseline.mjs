import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {parsePrebidHeader} from '../worker/runtime/prebid-artifact-check.mjs';

// Read only. These exact public URLs were observed on the live publisher page.
export const LIVE_SCRIPTS=Object.freeze({
 'ads.js':'https://tanjug.pages.dev/ads.js',
 'prebid.js':'https://tanjug.pages.dev/prebid.js',
});
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const LIMIT=2*1024*1024;
async function readScript(url,fetcher){
 const response=await fetcher(url,{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(20000)});
 const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
 if(response.status!==200||response.redirected||response.url&&response.url!==url){await response.body?.cancel();throw Error('Unexpected response for '+url);}
 if(!['application/javascript','text/javascript','application/x-javascript'].includes(type)){await response.body?.cancel();throw Error('Non-JavaScript response for '+url);}
 const reader=response.body?.getReader();if(!reader)throw Error('Missing response body');
 const chunks=[];let size=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT)throw Error('Script exceeds capture limit');chunks.push(value);}}
 catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
 const bytes=Buffer.concat(chunks,size);
 if(!size||/^\s*</.test(bytes.toString('utf8',0,256)))throw Error('Empty or HTML script response');
 return {bytes,metadata:{url,byteSize:size,sha256:hash(bytes),contentType:type,cacheControl:response.headers.get('cache-control')}};
}
export async function captureBaseline(fetcher=fetch,now=()=>new Date().toISOString()){
 const startedAt=now(),first={},second={};
 // Two observations of each file detect a changing deployment during capture.
 // This is not an atomic snapshot or proof the CDN will remain unchanged.
 for(const [name,url] of Object.entries(LIVE_SCRIPTS))first[name]=await readScript(url,fetcher);
 for(const [name,url] of Object.entries(LIVE_SCRIPTS))second[name]=await readScript(url,fetcher);
 for(const name of Object.keys(LIVE_SCRIPTS))if(!first[name].bytes.equals(second[name].bytes))throw Error('Live bytes changed during capture: '+name);
 let prebidHeader=null;try{prebidHeader=parsePrebidHeader(first['prebid.js'].bytes.toString('utf8',0,65536));}catch{}
 return {files:Object.fromEntries(Object.entries(first).map(([name,r])=>[name,r.bytes])),report:{schemaVersion:1,status:'captured',startedAt,completedAt:now(),prebidHeader,
  scripts:Object.fromEntries(Object.entries(first).map(([name,r])=>[name,r.metadata])),repeatedReadsMatch:true,
  limitations:['Read-only CDN capture; no script was executed.','Two matching reads are not an atomic deployment snapshot.','Verify the live URLs again immediately before testing.','This does not verify CMP decisions, runtime initialization or revenue.']}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const out=new URL('../.generated/tanjug-live-capture/',import.meta.url);await mkdir(out,{recursive:true});
 try{
  const capture=await captureBaseline();
  for(const [name,bytes] of Object.entries(capture.files))await writeFile(new URL(name,out),bytes);
  await writeFile(new URL('capture.json',out),JSON.stringify(capture.report,null,2)+'\n');
  console.log(JSON.stringify(capture.report));
 }catch(error){
  await writeFile(new URL('capture.json',out),JSON.stringify({status:'unavailable',capturedAt:new Date().toISOString(),reason:error.message},null,2)+'\n');
  console.error('Tanjug baseline capture unavailable: '+error.message);process.exitCode=1;
 }
}
