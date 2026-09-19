import {useEffect,useState} from 'react';
type Package={release:string;label:string;a:string;b:string;trafficB:number;positions:number;saved:boolean;sha256:string;bytes:number};
export default function AbPackagesPanel({publisherId}:{publisherId:string}){
 const base=`/api/publishers/${encodeURIComponent(publisherId)}/ab-packages`;
 const [state,setState]=useState<{supported:boolean;packages:Package[]}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false);
 async function response(url:string,options:RequestInit={}){const r=await fetch(url,{credentials:'same-origin',cache:'no-store',...options});if(!r.ok)throw Error((await r.json()).error||'A/B package request failed.');return r;}
 async function reload(){setState(await(await response(base)).json());}
 useEffect(()=>{let live=true;setState(null);setMessage('');response(base).then(r=>r.json()).then(s=>{if(live)setState(s);}).catch(e=>{if(live){setMessage(e.message);setFailed(true);}});return()=>{live=false;};},[base]);
 async function run(action:()=>Promise<void>){if(busy)return;setBusy(true);setFailed(false);try{await action();}catch(e){setFailed(true);setMessage(e instanceof Error?e.message:'Package action failed.');}finally{setBusy(false);}}
 async function save(p:Package,file:File){
  if(file.size!==p.bytes)throw Error('Choose the original complete ZIP for this version.');
  await response(`${base}/${p.release}`,{method:'PUT',headers:{'content-type':'application/zip'},body:file});
  await reload();setMessage('A/B package saved. You can download this exact version again at any time.');
 }
 async function download(p:Package){
  const bytes=await(await response(`${base}/${p.release}`)).arrayBuffer();
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  if(bytes.byteLength!==p.bytes||hash!==p.sha256)throw Error('Downloaded package differs. Please retry.');
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),a=document.createElement('a');a.href=url;a.download=p.release+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);setMessage('Complete A/B ZIP downloaded.');
 }
 if(state?.supported===false)return null;
 return <section aria-label="A/B packages"><h3>A/B packages</h3>
 {message?<p role="status" className={failed?'runtime-error':'runtime-message'}>{message}</p>:null}
 {!state?<p>Loading A/B packages…</p>:<><p>Keep the complete package used on Tanjug here. Both scripts use the same ads.js URL and report Variant A or B in Google Ad Manager.</p>
 {state.packages.map(p=><article key={p.release} className="runtime-release"><strong>{p.label}</strong><p>{p.release} · {p.positions} positions · A {100-p.trafficB}% / B {p.trafficB}%</p><p>A: {p.a} · B: {p.b}</p>
 {p.saved?<button disabled={busy} onClick={()=>void run(()=>download(p))}>Download A/B ZIP</button>:<label>Save the original ZIP<input type="file" accept=".zip,application/zip" disabled={busy} onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(f)void run(()=>save(p,f));}}/></label>}
 </article>)}<p>Upload the downloaded ZIP to the Cloudflare Pages project to publish it. Saving it here does not change the live site.</p></>}
 </section>;
}
