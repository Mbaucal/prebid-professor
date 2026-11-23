import {useEffect,useRef,useState} from 'react';
import ScriptSetupPanel from './ScriptSetupPanel';
import PrebidBuildsPanel from './PrebidBuildsPanel';
import {runtimeLabel} from '../site-workspace/runtime-labels';

type State={site:{id:string;name:string};runtime:{runtimeVersion:string}|null;revision:string;ready:boolean;error:string|null;nextStep:string|null;warnings?:string[]};
type Props={publisherId:string;siteName:string;availableVersions:number|null;disabled?:boolean;onSaved:(id:string)=>void|Promise<void>;onReload:()=>void|Promise<void>};

/** Reuses the saved editor setup and generator; no script version is generated or selected by visiting this view. */
export default function AbSourceVersionsPanel({publisherId,siteName,availableVersions,disabled=false,onSaved,onReload}:Props){
  const [state,setState]=useState<State|null>(null),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[setupDirty,setSetupDirty]=useState(false);
  const [prebidOpen,setPrebidOpen]=useState(false),[setupRefresh,setSetupRefresh]=useState(0),[open,setOpen]=useState(false);
  const [uncertain,setUncertain]=useState(false);
  const active=useRef(true),ticket=useRef(0),lock=useRef(false);
  const endpoint=`/api/publishers/${encodeURIComponent(publisherId)}/builtin-releases`;
  useEffect(()=>{active.current=true;void reload();return()=>{active.current=false;ticket.current++;};},[endpoint]);
  useEffect(()=>{if(availableVersions!==null&&availableVersions<2)setOpen(true);},[availableVersions]);
  async function request(body?:unknown){
    const response=await fetch(endpoint,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
      headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    if(!response.ok){let text='Could not read or save a script version. Retry.';try{text=((await response.json()) as {error?:string}).error||text;}catch{/* Keep the readable fallback. */}throw Object.assign(new Error(text),{status:response.status});}
    return response;
  }
  async function reload(){
    const current=++ticket.current;
    try{const next=await(await request()).json() as State;if(active.current&&current===ticket.current){setState(next);setError('');}}
    catch(failure){if(active.current&&current===ticket.current)setError(failure instanceof Error?failure.message:'Could not read source version readiness. Retry.');}
  }
  async function generate(){
    if(lock.current||!state?.ready||setupDirty||disabled||uncertain)return;
    lock.current=true;setBusy(true);setError('');setMessage('Saving script version…');
    let savedId:string|null=null;
    try{
      const response=await request({action:'generate',revision:state.revision,notes:name});
      const saved=await response.json() as {release?:{id?:string}};
      if(typeof saved.release?.id!=='string'||!/^builtin-release-[a-f0-9]{64}$/.test(saved.release.id))throw Error('The saved version response could not be confirmed.');
      savedId=saved.release.id;
      if(!active.current)return;
      setName('');setUncertain(false);setMessage('Script version saved. It is available in the A/B choices below.');await reload();await onSaved(savedId);
    }catch(failure){if(active.current){setUncertain(true);const status=failure&&typeof failure==='object'&&'status' in failure?failure.status:undefined;const message=failure instanceof Error?failure.message:'Could not confirm this script version.';if(savedId){setMessage(`Script version ${savedId.slice(-8)} was saved.`);setError(message+' Reload source versions to select it.');}else{setMessage('');setError(message+(typeof status!=='number'||status>=500?' The version may already have been saved.':'')+' Reload source versions and review the saved choices before creating another copy.');}}}
    finally{if(active.current){setBusy(false);lock.current=false;}}
  }
  async function prebidChanged(){await reload();if(active.current)setSetupRefresh(value=>value+1);}
  return <details id="ab-source-versions" className="ab-source-versions" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Save a script version{availableVersions!==null&&availableVersions<2?' — create the sources for A and B':''}</summary>
    <p>Choose a script version, save its setup, then save a named snapshot of your current Config. Repeat for the other A/B source. Existing saved versions and deployed files stay unchanged.</p>
    <fieldset className="ab-source-setup" disabled={busy||disabled}><ScriptSetupPanel publisherId={publisherId} refreshKey={setupRefresh} onDirtyChange={setSetupDirty} preserveChoicesOnReload
      onOpenPrebid={()=>setPrebidOpen(true)} onChanged={reload}/>
    {prebidOpen?<div className="measurement-prebid-setup"><div className="measurement-heading"><h3>Prebid.js setup</h3><button type="button" onClick={()=>setPrebidOpen(false)}>Close Prebid.js setup</button></div>
      <PrebidBuildsPanel publisherId={publisherId} siteName={siteName} onChanged={prebidChanged}/>
    </div>:null}</fieldset>
    {error?<p role="alert" className="runtime-error">{error}</p>:null}
    {message?<p role="status" className="ab-tests-status">{message}</p>:null}
    {!state&&!error?<p role="status" className="ab-tests-status">Loading source version readiness…</p>:null}
    {state?.error?<p role="alert" className="runtime-error">{state.error}</p>:null}
    {state?.warnings?.map(warning=><p key={warning} className="ab-tests-help">{warning}</p>)}
    {state?.runtime?<p>Saved generator script: <strong>{runtimeLabel(state.runtime.runtimeVersion)}</strong></p>:null}
    <label>Version name<input maxLength={160} value={name} disabled={busy||disabled} onChange={event=>setName(event.target.value)} placeholder="For example: Current settings — cache off"/></label>
    {setupDirty?<p className="ab-tests-note">Save the script setup above before generating this version.</p>:null}
    <div className="runtime-actions"><button type="button" disabled={busy||disabled||!state?.ready||setupDirty||uncertain} onClick={()=>void generate()}>Generate and save package</button>
      <button type="button" disabled={busy||disabled} onClick={()=>void (async()=>{await reload();await onReload();if(active.current){setSetupDirty(true);setSetupRefresh(value=>value+1);setUncertain(false);}})().catch(failure=>{if(active.current)setError(failure instanceof Error?failure.message:'Could not reload source versions. Retry.');})}>Reload source versions</button></div>
  </details>;
}
