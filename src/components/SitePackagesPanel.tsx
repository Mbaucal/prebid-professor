import ReleaseDeleteButton from './ReleaseDeleteButton';
import { useEffect,useState } from 'react';
import {downloadStoredPackage} from '../download/saved-package.mjs';
import ExternalDeploymentsPanel from './ExternalDeploymentsPanel';
import AbExperimentPanel from './AbExperimentPanel';
import ScriptLibraryPanel from './ScriptLibraryPanel';
import '../site-workspace/runtime.css';
import { runtimeLabel } from '../site-workspace/runtime-labels';
type Props={publisherId:string;endpoint?:string;onChanged?:()=>void|Promise<void>;onNavigate?:(destination:'prebid'|'versions')=>void};
export default function SitePackagesPanel({publisherId,endpoint,onChanged,onNavigate}:Props){
 const url=endpoint??`/api/publishers/${encodeURIComponent(publisherId)}/builtin-releases`;
 const [state,setState]=useState<any>(null),[notes,setNotes]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false);
 async function request(body?:any){const r=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!r.ok)throw Error((await r.json()).error||'Package request failed.');return r;}
 async function reload(){setState(await(await request()).json());}
 useEffect(()=>{let alive=true;setState(null);setMessage('');request().then(r=>r.json()).then(s=>{if(alive)setState(s);}).catch(e=>{if(alive){setMessage(e.message);setFailed(true);}});return()=>{alive=false;};},[url,publisherId]);
 async function run(fn:()=>Promise<void>){if(busy)return;setBusy(true);setFailed(false);try{await fn();}catch(e){setMessage(e instanceof Error?e.message:'Package action failed.');setFailed(true);}finally{setBusy(false);}}
 async function generate(){await request({action:'generate',revision:state.revision,notes});setNotes('');await reload();setMessage('Package saved in Releases. Your settings are unchanged.');await onChanged?.();}
 async function download(id:string){await downloadStoredPackage(id,setMessage,state.testOnly?{}:{siteId:publisherId});}
 async function restoreEarlier(r:any){
  if(!r.canRestore||!window.confirm(`Restore previously published version ${r.version} to Tessera's current channel?`))return;
  const response=await fetch(`/api/publishers/${encodeURIComponent(publisherId)}/releases/${encodeURIComponent(r.id)}/rollback`,{method:'POST',credentials:'same-origin'});
  if(!response.ok)throw Error((await response.json()).error||'Could not restore the earlier release.');
  await reload();await onChanged?.();setMessage('Earlier published package restored. Cloudflare site delivery remains a separate action.');
 }
 function deleteButton(r:any){return <ReleaseDeleteButton publisherId={publisherId} release={{...r,displayName:r.notes||r.version||r.id,manifest:null}} disabled={busy} onError={text=>{setFailed(true);setMessage(text);}} onDeleted={async text=>{await reload();await onChanged?.();setFailed(false);setMessage(text);}}/>;}
 async function channel(id:string,action:string){if(!window.confirm(`${action==='staging'?'Stage':action==='rollback'?'Restore':'Publish'} this complete saved package?`))return;await request({action,releaseId:id,channelRevision:state.channelRevision,acknowledge:true});await reload();await onChanged?.();setMessage('Release channel updated. Cloudflare site delivery is managed below.');}
 return <section className="site-runtime-panel" aria-label="Saved packages"><h2>Generate and releases</h2>
 {message?<p role="status" className={failed?'runtime-error':'runtime-message'}>{message}</p>:null}
 {!state?<p>Loading saved packages…</p>:<>
 <p>{state.site.name} · {state.runtime?runtimeLabel(state.runtime.runtimeVersion):'Setup needed'}</p>
 {state.error?<div className="runtime-error"><p>{state.error}</p>{state.nextStep&&onNavigate?<button onClick={()=>onNavigate(state.nextStep)}>{state.nextStep==='prebid'?'Open Prebid.js':'Choose ads.js version'}</button>:null}</div>:null}
 <p>Generate from this site’s saved ad units, size maps, bidders and script version. Each saved package keeps its original files.</p>
 <label>What changed?<input maxLength={160} value={notes} disabled={busy} onChange={e=>setNotes(e.target.value)} placeholder="Short release note"/></label>
 <div className="runtime-actions"><button disabled={busy||!state.ready} onClick={()=>void run(generate)}>{busy?'Working…':'Generate and save package'}</button><button disabled={busy} onClick={()=>void run(reload)}>Reload releases</button></div>
 {state.testOnly?<p>This is your TEST copy. Preview delivery is available in <a href="/deployments">TEST deployments</a>.</p>:<p>Stage a saved package before publishing. Existing site URLs stay the same.</p>}
 <h3>Saved versions</h3>{state.releases.length===0?<p>No built-in packages saved yet.</p>:state.releases.map((r:any)=><article key={r.id} className="runtime-release"><strong>{r.notes||'Generated package'}</strong><p>{new Date(r.createdAt).toLocaleString()} · {r.status}</p><details><summary>Package ID</summary><code>{r.id}</code></details><div className="runtime-actions"><button disabled={busy} onClick={()=>void run(()=>download(r.id))}>Download saved ZIP</button>{!state.testOnly?<><button disabled={busy||r.status==='production'} onClick={()=>void run(()=>channel(r.id,'staging'))}>Stage package</button>{r.status==='staging'?<button disabled={busy} onClick={()=>void run(()=>channel(r.id,'production'))}>Publish package</button>:null}{r.status==='archived'?<button disabled={busy} onClick={()=>void run(()=>channel(r.id,'rollback'))}>Restore published package</button>:null}{deleteButton(r)}</>:null}</div></article>)}
 {!state.testOnly&&state.earlierReleases?.length?<><h3>Earlier packages</h3><p>Packages created before the built-in generator remain available. Restore a previously published version without changing your current editor settings.</p>{state.earlierReleases.map((r:any)=><article key={r.id} className="runtime-release"><strong>{r.notes||r.version}</strong><p>{r.version} · {r.status} · {new Date(r.createdAt).toLocaleString()}</p>{r.canRestore?<button disabled={busy} onClick={()=>void run(()=>restoreEarlier(r))}>Restore earlier published package</button>:null}{deleteButton(r)}</article>)}</>:null}
 {!state.testOnly?<><ScriptLibraryPanel key={publisherId} publisherId={publisherId}/><AbExperimentPanel key={'earlier-'+publisherId} publisherId={publisherId} archiveOnly/><ExternalDeploymentsPanel publisherId={publisherId} releases={[...state.releases,...(state.earlierReleases??[])]} /></>:null}
 </>}
 </section>;
}
