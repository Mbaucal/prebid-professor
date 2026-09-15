import { useEffect, useState } from 'react';
import '../site-workspace/runtime.css';

type Position={code:string;type:string;sizeMap:string;enabled:boolean;display:string;overlay:any;lazy:any};
type State={site:{id:string;name:string;domain:string};revision:string;selected:any;validationIssue:string|null;enablePrebid:boolean;runtimes:Array<{version:string;pin:any}>;history:any[];positions:Position[]};
type Props={publisherId:string;view:'versions'|'positions';unitCode?:string;endpoint?:string;onChanged?:()=>void|Promise<void>};
const overlayDefaults={demand:'gam',desktopMinWidth:1024,desktopSeconds:10,mobileSeconds:5,countdown:true,frequencyMinutes:0};

export default function SiteRuntimePanel({publisherId,view,unitCode,endpoint,onChanged}:Props){
 const url=endpoint??`/api/publishers/${encodeURIComponent(publisherId)}/builtin-site-settings`;
 const [state,setState]=useState<State|null>(null),[version,setVersion]=useState(''),[approved,setApproved]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[failed,setFailed]=useState(false),[stale,setStale]=useState(false);
 const [draft,setDraft]=useState<Position|null>(null);
 async function request(body?:unknown){const r=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!r.ok){const e=await r.json();throw Error(e.error||'Request failed.');}return r;}
 function accept(data:State){setState(data);setVersion(data.selected?.runtimeSha256??'');setApproved(false);setDraft(null);setStale(false);}
 useEffect(()=>{let active=true;setState(null);setDraft(null);setMessage('');setFailed(false);setStale(false);setBusy(false);request().then(r=>r.json()).then(data=>{if(active)accept(data);}).catch(e=>{if(active){setMessage(e.message);setFailed(true);}});return()=>{active=false;};},[url,publisherId]);
 async function run(fn:()=>Promise<void>){if(busy)return;setBusy(true);setFailed(false);try{await fn();}catch(e){setMessage(e instanceof Error?e.message:'Could not complete this action.');setFailed(true);setStale(true);}finally{setBusy(false);}}
 async function reload(note='Saved settings loaded.'){accept(await(await request()).json());setMessage(note);}
 const selected=state?.runtimes.find(r=>r.pin.runtimeSha256===version);
 async function saveVersion(){if(!selected||!state)return;await request({action:'version',revision:state.revision,runtime:selected.pin,allowPreview:approved});await reload('Script version saved. Your site settings and Prebid choice are retained.');await onChanged?.();}
 async function savePosition(){if(!draft||!state)return;const position={code:draft.code,display:draft.display,overlay:draft.display==='takeover'?draft.overlay:null,lazy:draft.display==='takeover'?null:draft.lazy};await request({action:'position',revision:state.revision,position});await reload('Position settings saved. They apply to the next generated package.');await onChanged?.();}
 async function bundle(){if(!state)return;const response=await request({action:'bundle',revision:state.revision,acknowledge:true}),blob=await response.blob();const link=document.createElement('a'),objectUrl=URL.createObjectURL(blob);link.href=objectUrl;link.download=`${publisherId}-candidate.zip`;link.click();setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);setMessage('Candidate downloaded. It has not been published.');}
 const field=(label:string,key:string)=> <label key={key}>{label}<input type="number" min="0" step="1" value={draft?.overlay[key]??0} onChange={e=>setDraft(draft?{...draft,overlay:{...draft.overlay,[key]:Number(e.target.value)}}:null)}/></label>;
 return <section className="site-runtime-panel" aria-label={view==='versions'?'Script versions':'Ad position display settings'}>
  <h2>{view==='versions'?'ads.js versions':'Display and loading'}</h2>
  {state?<p>{state.site.name} · {state.site.domain}</p>:!failed?<p>Loading saved site settings…</p>:null}
  {message?<p role="status" className={failed?'runtime-error':'runtime-message'}>{message}</p>:null}
  {state?.validationIssue?<p className="runtime-error">{state.validationIssue}</p>:null}
  {state&&view==='versions'?<>
   <p>Tessera creates ads.js from this site’s saved settings. Choose a script version; no template upload is needed.</p>
   <label>Script version<select aria-label="Script version" value={version} disabled={busy} onChange={e=>{setVersion(e.target.value);setApproved(false);}}><option value="">Choose a version</option>{state.runtimes.map(r=><option key={r.pin.runtimeSha256} value={r.pin.runtimeSha256}>{r.version}</option>)}</select></label>
   <p>Saved version: <strong>{state.selected?.runtimeVersion??'Not selected'}</strong> · Prebid {state.enablePrebid?'enabled':'off'}</p>
   <label className="runtime-check"><input type="checkbox" checked={approved} disabled={busy} onChange={e=>setApproved(e.target.checked)}/>Use this Preview script for this site’s next package.</label>
   <div className="runtime-actions"><button disabled={busy||stale||!selected||!approved} onClick={()=>void run(saveVersion)}>Save script version</button><button disabled={busy||stale||!state.selected||Boolean(state.validationIssue)} onClick={()=>void run(bundle)}>Download candidate ZIP</button></div>
   <p>Downloads are review candidates. Saved releases and live files are unchanged.</p>
   <h3>Version history</h3>{state.history.map(r=><article className="runtime-release" key={r.codeSha256}><strong>{r.version} · {r.date}</strong><p>{r.title} · {r.available?'Available':'Saved packages only'}{r.saved?' · Selected on this site':''}</p><ul>{r.changes.map((c:string)=><li key={c}>{c}</li>)}</ul><details><summary>Build details</summary><code>{r.codeSha256}</code></details></article>)}
  </>:null}
  {state&&view==='positions'?<>
   <p>Use the ad unit’s existing size map and bidder overrides. These settings apply with script version 3.10.0.</p>
   {!state.selected?<p className="runtime-error">Save a Script version before changing display settings.</p>:null}
   {state.positions.filter(p=>!unitCode||p.code===unitCode).map(p=><article className="runtime-position" key={p.code}><strong>{p.code}</strong><p>{p.type} · Map: {p.sizeMap} · {p.display==='takeover'?'TakeOver':p.display==='sticky'?'Bottom Sticky':'Standard'}{p.display==='takeover'?` · ${p.overlay.demand==='site'?'Prebid + GAM':'GAM only'}`:''}</p><button disabled={busy||Boolean(draft)} onClick={()=>{setDraft(structuredClone(p));setMessage('');}}>Configure {p.code}</button></article>)}
   {draft?<fieldset disabled={busy} className="runtime-edit"><legend>{draft.code}</legend><label>Display<select aria-label="Display" value={draft.display} onChange={e=>setDraft({...draft,display:e.target.value,overlay:e.target.value==='takeover'?(draft.overlay??{...overlayDefaults}):null})}><option value="standard">Standard</option><option value="sticky">Bottom Sticky</option><option value="takeover">TakeOver</option></select></label><p>Size map: {draft.sizeMap}. Edit its dimensions under Size maps.</p>
    {draft.display==='takeover'?<><label>Demand<select aria-label="Demand" value={draft.overlay.demand} onChange={e=>setDraft({...draft,overlay:{...draft.overlay,demand:e.target.value}})}><option value="gam">GAM only</option><option value="site" disabled={!state.enablePrebid}>Prebid + GAM · site bidders{!state.enablePrebid ? " (enable Prebid first)" : ""}</option></select></label><div className="runtime-grid">{field('Desktop starts at (px)','desktopMinWidth')}{field('Desktop auto-close (seconds)','desktopSeconds')}{field('Mobile auto-close (seconds)','mobileSeconds')}{field('Minimum interval in this tab (minutes)','frequencyMinutes')}</div><label className="runtime-check"><input type="checkbox" checked={draft.overlay.countdown} onChange={e=>setDraft({...draft,overlay:{...draft.overlay,countdown:e.target.checked}})}/>Show countdown</label><p>One numeric size per map width; an empty row disables TakeOver at that width. Use 0 for manual close or no interval.</p></>:<><label>Loading<select aria-label="Loading" value={draft.lazy==null?'inherit':draft.lazy.enabled?'lazy':'immediate'} onChange={e=>setDraft({...draft,lazy:e.target.value==='inherit'?null:{enabled:e.target.value==='lazy',fetchMarginPx:500,renderMarginPx:0}})}><option value="inherit">Use group settings</option><option value="immediate">Immediately after consent</option><option value="lazy">Lazy load</option></select></label>{draft.lazy?.enabled?<div className="runtime-grid">{[['fetchMarginPx','Fetch ahead (px)'],['renderMarginPx','Render ahead (px)']].map(([key,label])=><label key={key}>{label}<input type="number" min="0" step="1" value={draft.lazy[key]} onChange={e=>setDraft({...draft,lazy:{...draft.lazy,[key]:Number(e.target.value)}})}/></label>)}</div>:null}</>}
    <div className="runtime-actions"><button disabled={stale||!state.selected} onClick={()=>void run(savePosition)}>Save position settings</button><button onClick={()=>setDraft(null)}>Cancel</button></div>
   </fieldset>:null}
  </>:null}
  <div className="runtime-actions"><button disabled={busy} onClick={()=>{if(draft&&!window.confirm('Discard unsaved position edits and reload?'))return;void run(()=>reload());}}>Reload saved settings</button></div>
 </section>;
}
