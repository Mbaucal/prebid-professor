import ConfirmDeleteButton from './ConfirmDeleteButton';
import {useEffect, useRef, useState, type FormEvent} from 'react';
import {DEFAULT_PACKAGE_SETTINGS, validatePackageSettings} from '../../worker/experiments/package-settings-v1.mjs';
import './ab-experiments.css';

type Arm = {mode:'fresh-only'|'auction-with-cache'; refreshSeconds:number|null; maxBidAgeSeconds?:number};
type Settings = {schemaVersion:1; trafficBPercent:number; arms:{A:Arm; B:Arm}};
type Saved = {release:string; settings:Settings; notes:string; createdAt:string; bytes:number; sha256:string};
type State = {supported:boolean; revision:string; defaults:Settings; baseline:{release:string;positions:number;prebidVersion:string;sha256:string;bytes:number}; packages:Saved[]; deletedPackages:Saved[]; nextCursor:string|null};
type ArmForm = {mode:Arm['mode']; refreshMode:'preserve'|'fixed'; seconds:string; age:string};
const armForm=(a:Arm):ArmForm=>({mode:a.mode,refreshMode:a.refreshSeconds===null?'preserve':'fixed',seconds:String(a.refreshSeconds??30),age:String(a.maxBidAgeSeconds??60)});
const modeLabel=(a:Arm)=>a.mode==='fresh-only'?'Fresh auction':`Auction + cached bids (up to ${a.maxBidAgeSeconds} s)`;
const refreshLabel=(a:Arm)=>a.refreshSeconds===null?'Baseline position rules':`${a.refreshSeconds} s standard refresh`;

export default function AbExperimentPanel({publisherId,archiveOnly=false}:{publisherId:string;archiveOnly?:boolean}) {
  const base=`/api/publishers/${encodeURIComponent(publisherId)}/ab-experiments`;
  const [state,setState]=useState<State|null>(null),[arms,setArms]=useState({A:armForm(DEFAULT_PACKAGE_SETTINGS.arms.A as Arm),B:armForm(DEFAULT_PACKAGE_SETTINGS.arms.B as Arm)});
  const [traffic,setTraffic]=useState('50'),[notes,setNotes]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const lock=useRef(false);
  async function request(path='',init:RequestInit={}) {
    const response=await fetch(base+path,{credentials:'same-origin',cache:'no-store',...init});
    if(!response.ok){let text='A/B request failed. Please retry.';try{text=(await response.json()).error||text;}catch{}throw Error(text);}
    return response;
  }
  async function load(more=false) {
    const data:State=await(await request(more&&state?.nextCursor?'?cursor='+encodeURIComponent(state.nextCursor):'')).json();
    setState(old=>more&&old?{...data,packages:[...new Map([...old.packages,...data.packages].map(p=>[p.release,p])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),deletedPackages:[...new Map([...(old.deletedPackages||[]),...(data.deletedPackages||[])].map(p=>[p.release,p])).values()]}:data);
  }
  useEffect(()=>{let active=true;request().then(r=>r.json()).then(data=>{if(active)setState(data);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[base]);
  async function run(action:()=>Promise<void>) {
    if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');
    try{await action();}catch(e){setError(e instanceof Error?e.message:'A/B request failed.');}finally{lock.current=false;setBusy(false);}
  }
  function update(v:'A'|'B',patch:Partial<ArmForm>) {setArms(old=>({...old,[v]:{...old[v],...patch}}));setMessage('');}
  function settings():Settings {
    return validatePackageSettings({schemaVersion:1,trafficBPercent:Number(traffic),arms:Object.fromEntries((['A','B'] as const).map(v=>[v,{
      mode:arms[v].mode,refreshSeconds:arms[v].refreshMode==='preserve'?null:Number(arms[v].seconds),
      ...(arms[v].mode==='auction-with-cache'?{maxBidAgeSeconds:Number(arms[v].age)}:{}),
    }]))}) as Settings;
  }
  async function generate(event:FormEvent) {
    event.preventDefault();await run(async()=>{
      const selected=settings();
      const data=await(await request('',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state!.revision,settings:selected,notes})})).json();
      // Keep the successful generation visible even if a subsequent list reload fails.
      setState(old=>old?{...old,packages:[data.package,...old.packages.filter(p=>p.release!==data.package.release)]}:old);
      setNotes('');setMessage(data.alreadySaved?'This exact package is already saved. Download it below.':'New A/B package saved. Download the complete ZIP below.');
    });
  }
  function useSettings(p:Saved) {setTraffic(String(p.settings.trafficBPercent));setArms({A:armForm(p.settings.arms.A),B:armForm(p.settings.arms.B)});setNotes('');setMessage('Saved settings loaded into the editor. Generate to save any changes.');setError('');}
  async function download(path:string,name:string,expected:{bytes:number;sha256:string}) {
    const bytes=await(await request('/'+path+'.zip')).arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
    if(bytes.byteLength!==expected.bytes||hash!==expected.sha256)throw Error('Downloaded ZIP differs from the saved package. Please retry.');
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),a=document.createElement('a');a.href=url;a.download=name+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    setMessage('Complete ZIP downloaded. Upload it to the Tanjug Cloudflare Pages project when you are ready.');
  }
  async function removePackage(p:Saved,restore=false) {
    if(lock.current)throw Error('Another action is in progress.');lock.current=true;setBusy(true);setError('');
    try{await request('/'+p.release+'.zip',{method:restore?'PUT':'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmId:p.release,sha256:p.sha256})});await load();setMessage(restore?'Package restored.':'Package deleted. It can be restored from Deleted packages.');}
    finally{lock.current=false;setBusy(false);}
  }
  function deleteButton(p:Saved){return <ConfirmDeleteButton name={p.notes||'A/B package '+p.release.slice(-8)} description="Delete this saved package from the list? You can restore it from Deleted packages. Previously uploaded copies are unchanged." disabled={busy} onConfirm={()=>removePackage(p)}/>;}
  const deleted=state?.deletedPackages?.length?<details className="ab-baseline"><summary>Deleted packages</summary>{state.deletedPackages.map(p=><article className="ab-saved" key={p.release}><h4>{p.notes||'A/B package'} · {p.release.slice(-8)}</h4><button disabled={busy} onClick={()=>void removePackage(p,true).catch(e=>setError(e.message))}>Restore</button></article>)}</details>:null;
  if(state?.supported===false)return null;
  if(archiveOnly){
    if(!state&&!error)return null;
    return <details className="ab-editor"><summary>Earlier A/B packages</summary>
      {error?<p role="alert" className="runtime-error">{error}</p>:null}{message?<p role="status" className="runtime-message">{message}</p>:null}
      <p>Packages created before the script library keep their original files. Create new named versions in Scripts and A/B tests above.</p>
      {state?<button disabled={busy} onClick={()=>void run(()=>download('baseline',state.baseline.release,state.baseline))}>Download accepted A/A baseline</button>:null}
      {state?.packages.map(p=><article key={p.release} className="ab-saved"><h4>{p.notes||'Earlier A/B package'} · {p.release.slice(-8)}</h4><p>A {100-p.settings.trafficBPercent}% / B {p.settings.trafficBPercent}%</p><button disabled={busy} onClick={()=>void run(()=>download(p.release,p.release,p))}>Download earlier ZIP</button> {deleteButton(p)}</article>)}
      {state?.nextCursor?<button disabled={busy} onClick={()=>void run(()=>load(true))}>Load more packages</button>:null}
      {deleted}
    </details>;
  }
  return <section className="ab-editor" aria-label="A/B testing">
    <div className="ab-heading"><div><span className="panel-kicker">Experiments</span><h2>A/B testing</h2></div><button className="button secondary" disabled={busy} onClick={()=>void run(()=>load())}>Reload packages</button></div>
    {error?<p role="alert" className="runtime-error">{error}</p>:null}
    {message?<p role="status" className="runtime-message">{message}</p>:null}
    {!state?<p>Loading A/B packages…</p>:<>
      <p>One ads.js URL. Each page runs one variant and keeps <strong>Variant=A</strong> or <strong>Variant=B</strong> for all its ad requests.</p>
      <details className="ab-baseline"><summary>Starting point: Tanjug · {state.baseline.positions} positions · Prebid {state.baseline.prebidVersion}</summary>
        <p>Uses the reviewed {state.baseline.release} package. Its ad units, bidders and consent setup are fixed. Other Config changes are not included in this pilot package.</p>
        <button className="button secondary" disabled={busy} onClick={()=>void run(()=>download('baseline',state.baseline.release,state.baseline))}>Download baseline A/A ZIP</button>
      </details>
      <form onSubmit={generate}>
        <fieldset disabled={busy} className="ab-form">
          <legend>New package settings</legend>
          <label className="ab-traffic">Traffic to variant B (%)<input required type="number" min={0} max={100} step={1} value={traffic} onChange={e=>{setTraffic(e.target.value);setMessage('');}}/><span>A: {traffic!==''&&Number(traffic)>=0&&Number(traffic)<=100?100-Number(traffic):'—'}% · B: {traffic||'—'}%</span></label>
          <div className="ab-arms">{(['A','B'] as const).map(v=><fieldset key={v} className="ab-arm"><legend>Variant {v}</legend>
            <label>Auction mode<select aria-label="Auction mode" value={arms[v].mode} onChange={e=>update(v,{mode:e.target.value as Arm['mode']})}><option value="fresh-only">Fresh auction</option><option value="auction-with-cache">Auction + valid cached bids</option></select></label>
            {arms[v].mode==='auction-with-cache'?<label>Maximum bid age (seconds)<input required type="number" min={1} max={300} step={1} value={arms[v].age} onChange={e=>update(v,{age:e.target.value})}/><span>A shorter bid TTL still applies. Every opportunity starts a new auction.</span></label>:null}
            <label>Refresh<select aria-label="Refresh" value={arms[v].refreshMode} onChange={e=>update(v,{refreshMode:e.target.value as ArmForm['refreshMode']})}><option value="preserve">Keep baseline position rules</option><option value="fixed">Set standard interval</option></select></label>
            {arms[v].refreshMode==='fixed'?<label>Standard interval (seconds)<input required type="number" min={1} max={7200} step={1} value={arms[v].seconds} onChange={e=>update(v,{seconds:e.target.value})}/></label>:null}
          </fieldset>)}</div>
          <p className="ab-help">For the first cache comparison, keep the same refresh settings in both variants. Visibility, page activity and auction time can delay an ad request.</p>
          <label>Package note<input maxLength={160} value={notes} onChange={e=>setNotes(e.target.value)} placeholder="For example: fresh auctions vs bid cache"/></label>
          <button className="button primary" type="submit">{busy?'Generating…':'Generate and save A/B package'}</button>
        </fieldset>
      </form>
      <p>Generation saves a new package. To activate it, upload the <strong>complete ZIP</strong> to the existing Tanjug Pages project. The active Pages deployment is not tracked here.</p>
      <h3>Saved A/B packages</h3>
      {!state.packages.length?<p>No A/B packages generated yet.</p>:state.packages.map(p=><article className="ab-saved" key={p.release}>
        <h4>{p.notes||'A/B package'} <span>2.0 · {p.release.slice(-8)}</span></h4>
        <p>{new Date(p.createdAt).toLocaleString()} · A {100-p.settings.trafficBPercent}% / B {p.settings.trafficBPercent}% · Saved</p>
        <dl>{(['A','B'] as const).map(v=><div key={v}><dt>Variant {v}</dt><dd>{modeLabel(p.settings.arms[v])} · {refreshLabel(p.settings.arms[v])}</dd></div>)}</dl>
        <div className="runtime-actions"><button className="button primary" disabled={busy} onClick={()=>void run(()=>download(p.release,p.release,p))}>Download A/B ZIP</button><button className="button secondary" disabled={busy} onClick={()=>useSettings(p)}>Use these settings</button>{deleteButton(p)}</div>
        <details><summary>Package details</summary><code>{p.release}</code><p>{Math.round(p.bytes/1024)} KB · SHA-256 <code>{p.sha256}</code></p></details>
      </article>)}
      {deleted}
      {state.nextCursor?<button className="button secondary" disabled={busy} onClick={()=>void run(()=>load(true))}>Load more packages</button>:null}
    </>}
  </section>;
}
