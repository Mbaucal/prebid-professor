import { zipSync } from 'fflate';
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
export async function downloadStoredPackage(id, progress=()=>{}) {
 if(!/^builtin-draft-[a-f0-9]{64}$/.test(id))throw Error('Invalid saved package.');
 const base='/test-api/releases/'+id;
 const indexResponse=await fetch(base+'/index',{credentials:'same-origin',cache:'no-store'});
 if(!indexResponse.ok)throw Error('Cannot read saved package. Sign in and try again.');
 const {descriptor}=await indexResponse.json(),files={};
 if(descriptor.releaseId!==id||!Array.isArray(descriptor.files)||descriptor.files.length<9||descriptor.files.length>10)throw Error('Invalid package inventory.');
 let total=0;
 for(const entry of descriptor.files){
  if(!['README.txt','ads.js','ads.min.js','config.json','div-export.csv','implementation.html','manifest.json','min-height.css','sticky.css','prebid.js'].includes(entry.name)||Object.hasOwn(files,entry.name)||!Number.isSafeInteger(entry.byteSize)||entry.byteSize<=0||entry.byteSize>8*1024*1024)throw Error('Invalid saved file.');
  total+=entry.byteSize;if(total>12*1024*1024)throw Error('Package exceeds limit.');
  progress('Downloading '+entry.name+'…');
  const response=await fetch(base+'/files/'+encodeURIComponent(entry.name),{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw Error('Could not download '+entry.name+'. Retry the saved package.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length!==entry.byteSize||await hash(bytes)!==entry.sha256)throw Error('Saved file checksum differs: '+entry.name);
  files[entry.name]=[bytes,{level:0,mtime:new Date(1980,0,1)}];
 }
 const inventory=descriptor.files;
 if(await hash(new TextEncoder().encode(JSON.stringify({siteId:descriptor.siteId,inventory})))!==id.slice('builtin-draft-'.length))throw Error('Package identity differs.');
 progress('Preparing ZIP…');
 const blob=new Blob([zipSync(files,{level:0})],{type:'application/zip'}),url=URL.createObjectURL(blob),a=document.createElement('a');
 a.href=url;a.download=id+'.zip';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
 progress('Saved ZIP downloaded.');
}
