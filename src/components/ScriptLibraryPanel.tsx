import ConfirmDeleteButton from './ConfirmDeleteButton';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {displayName} from '../../worker/experiments/saved-script-settings.mjs';
import './ab-experiments.css';

type Settings={mode:'fresh-only'|'auction-with-cache';refreshSeconds:number|null;maxBidAgeSeconds?:number;positionOverrides?:Record<string,boolean>};
type ScriptRef={id:string;name:string;settings:Settings};
type Saved=ScriptRef&{collection:'scripts'|'tests';createdAt:string;bytes:number;sha256:string;trafficBPercent?:number;scripts?:{A:ScriptRef;B:ScriptRef}};
type Library={supported:boolean;revision:string;baseline:{release:string;positions:number;prebidVersion:string};prebid:{enabled:boolean;bidCache:{enabled:boolean;maxBidAgeSeconds:number;positionOverrides?:Record<string,boolean>}};scripts:Saved[];tests:Saved[];deletedScripts:Saved[];deletedTests:Saved[];nextCursors:{scripts:string|null;tests:string|null}};
type Kind='scripts'|'tests';
const description=(s:Settings)=>`${s.positionOverrides?'Site default: ':''}${s.mode==='fresh-only'?'Fresh auction':`Auction + cached bids, up to ${s.maxBidAgeSeconds} s`}${s.positionOverrides?' · '+Object.entries(s.positionOverrides).map(([code,on])=>`${code}: cache ${on?'On':'Off'}`).join(' · '):''} · ${s.refreshSeconds===null?'baseline refresh rules':`${s.refreshSeconds} s refresh`}`;
const merge=(items:Saved[],added:Saved[])=>[...new Map([...items,...added].map(p=>[p.id,p])).values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));

export default function ScriptLibraryPanel({publisherId,onOpenDemand}:{publisherId:string;onOpenDemand?:()=>void}) {
  const base=`/api/publishers/${encodeURIComponent(publisherId)}/script-library`;
  const [library,setLibrary]=useState<Library|null>(null),[name,setName]=useState('');
  const [refresh,setRefresh]=useState('preserve'),[seconds,setSeconds]=useState('30');
  const [testName,setTestName]=useState(''),[a,setA]=useState(''),[b,setB]=useState(''),[traffic,setTraffic]=useState('50');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');const lock=useRef(false);
  async function request(path='',init:RequestInit={}) {
    const response=await fetch(base+path,{credentials:'same-origin',cache:'no-store',...init});
    if(!response.ok){let text='Could not complete the request.';try{text=(await response.json()).error||text;}catch{}throw Error(text);}return response;
  }
  useEffect(()=>{let active=true;request().then(r=>r.json()).then(s=>{if(active)setLibrary(s);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[base]);
  async function run(fn:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setError('');setMessage('');try{await fn();}catch(e){setError(e instanceof Error?e.message:'Could not complete the request.');}finally{lock.current=false;setBusy(false);}}
  async function save(kind:Kind,payload:object) {
    const data=await(await request('/'+kind,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:library!.revision,...payload})})).json();
    setLibrary(old=>old?{...old,[kind]:merge(old[kind],[data.item])}:old);
    setMessage(data.alreadySaved?'This named version is already saved. Download it below.':`${kind==='scripts'?'Script':'A/B test'} saved. Download its complete ZIP below.`);
    return data.item as Saved;
  }
  async function saveScript(e:FormEvent){e.preventDefault();await run(async()=>{
    const saved=await save('scripts',{name:displayName(name),refreshSeconds:refresh==='preserve'?null:Number(seconds)});if(!a)setA(saved.id);else if(!b)setB(saved.id);
  });}
  async function saveTest(e:FormEvent){e.preventDefault();await run(async()=>{await save('tests',{name:displayName(testName),scriptA:a,scriptB:b,trafficBPercent:Number(traffic)});});}
  async function download(p:Saved) {
    const bytes=await(await request(`/${p.collection}/${p.id}.zip`)).arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    if(bytes.byteLength!==p.bytes||hash!==p.sha256)throw Error('Downloaded ZIP differs from the saved version.');
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),link=document.createElement('a');link.href=url;
    link.download=p.name.replace(/[\\/:*?"<>|]/g,'-')+'-'+p.id.slice(-8)+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
    setMessage(`${p.name} downloaded. Upload the complete ZIP to the existing Tanjug Pages project to activate it.`);
  }
  async function more(kind:Kind) {
    const page=await(await request(`?collection=${kind}&cursor=${encodeURIComponent(library!.nextCursors[kind]!)}`)).json();
    setLibrary(old=>old?{...old,[kind]:merge(old[kind],page.items),[kind==='scripts'?'deletedScripts':'deletedTests']:merge(old[kind==='scripts'?'deletedScripts':'deletedTests']||[],page.deleted||[]),nextCursors:{...old.nextCursors,[kind]:page.nextCursor}}:old);
  }
  async function removeSaved(p:Saved,restore=false) {
    if(lock.current)throw Error('Another action is in progress.');lock.current=true;setBusy(true);setError('');
    try {
      await request(`/${p.collection}/${p.id}.zip`,{method:restore?'PUT':'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({confirmId:p.id,sha256:p.sha256})});
      setLibrary(await(await request()).json());
      if(!restore&&p.collection==='scripts'){if(a===p.id)setA('');if(b===p.id)setB('');}
      setMessage(restore?`${p.name} restored.`:`${p.name} deleted. You can restore it from Deleted scripts and tests.`);
    }finally{lock.current=false;setBusy(false);}
  }
  function deleteButton(p:Saved){return <ConfirmDeleteButton name={p.name} disabled={busy} description={p.collection==='scripts'?'Delete this saved script from the list? Saved tests keep their own copy. You can restore this version from Deleted scripts and tests.':'Delete this saved test from the list? Its source scripts stay available. You can restore this test from Deleted scripts and tests.'} onConfirm={()=>removeSaved(p)}/>;}
  function useScript(s:ScriptRef){setName((s.name+' copy').slice(0,80));setRefresh(s.settings.refreshSeconds===null?'preserve':'fixed');setSeconds(String(s.settings.refreshSeconds??30));setMessage('Name and refresh copied. The new version will use the saved Demand → Prebid cache settings shown above.');}
  function option(s:Saved){return <option key={s.id} value={s.id}>{s.name} · {s.id.slice(-8)}</option>;}
  function details(s:Saved){return <details><summary>Version details</summary><code>{s.id}</code><p>SHA-256 <code>{s.sha256}</code></p></details>;}
  if(library?.supported===false)return null;
  return <section className="ab-editor" aria-label="Script library">
    <div className="ab-heading"><div><span className="panel-kicker">Saved versions</span><h2>Scripts and A/B tests</h2></div><button className="button secondary" disabled={busy} onClick={()=>void run(async()=>setLibrary(await(await request()).json()))}>Reload library</button></div>
    {error?<p role="alert" className="runtime-error">{error}</p>:null}{message?<p role="status" className="runtime-message">{message}</p>:null}
    {!library?<p>Loading saved scripts…</p>:<>
      <p>Name and save each script once. Use it on its own, or select two saved versions for an A/B test.</p>
      <details className="ab-baseline"><summary>Starting point: Tanjug · {library.baseline.positions} positions · Prebid {library.baseline.prebidVersion}</summary><p>Uses the reviewed {library.baseline.release} inventory, bidders and consent setup. Bid caching uses the saved Demand → Prebid default and Ad units position choices. Other Config changes are not included in this pilot.</p></details>
      {!library.prebid.enabled?<p className="ab-help">Prebid is off. Enable it in Config → Demand → Prebid to create a new script. {onOpenDemand?<button type="button" onClick={onOpenDemand}>Edit Prebid settings</button>:null}</p>:null}
      <form onSubmit={saveScript}><fieldset className="ab-form" disabled={busy || !library.prebid.enabled}><legend>New script</legend>
        <label>Script name<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)} placeholder="For example: Standard 30s or Cache 60s"/></label>
        <div className="ab-arms"><div>
          <div className="ab-help" aria-label="Saved bid caching settings"><strong>{library.prebid.bidCache.positionOverrides?'Site default — bid caching: ':'Bid caching: '}{library.prebid.bidCache.enabled?'On':'Off'}</strong>
            {library.prebid.bidCache.positionOverrides?<p>{Object.entries(library.prebid.bidCache.positionOverrides).map(([code,on])=>`${code}: cache ${on?'On':'Off'}`).join(' · ')} · Maximum bid age: {library.prebid.bidCache.maxBidAgeSeconds} s</p>:null}
            <p>{library.prebid.bidCache.positionOverrides?'Positions without an override: ':''}{library.prebid.bidCache.enabled?`New auctions + valid cached bids, up to ${library.prebid.bidCache.maxBidAgeSeconds} s.`:'Fresh auction only.'}</p>
            <p>Site default: Config → Demand → Prebid. Position choices: Config → Ad units.</p>
            {onOpenDemand?<button className="button secondary" type="button" onClick={onOpenDemand}>Edit Prebid settings</button>:null}
          </div>
        </div><div>
          <label>Refresh<select aria-label="Refresh" value={refresh} onChange={e=>setRefresh(e.target.value)}><option value="preserve">Keep baseline position rules</option><option value="fixed">Set standard interval</option></select></label>
          {refresh==='fixed'?<label>Standard interval (seconds)<input type="number" required min={1} max={7200} step={1} value={seconds} onChange={e=>setSeconds(e.target.value)}/></label>:null}
        </div></div>
        <button type="submit" className="button primary">Save script version</button>
      </fieldset></form>
      <h3>Saved scripts</h3>{!library.scripts.length?<p>No saved scripts yet. Create your first version above.</p>:library.scripts.map(s=><article className="ab-saved" key={s.id} aria-label={'Script: '+s.name}>
        <h4>{s.name}</h4><p>{description(s.settings)}</p><p>Version {s.id.slice(-8)} · {new Date(s.createdAt).toLocaleString()}</p>
        <div className="runtime-actions"><button className="button primary" disabled={busy} onClick={()=>void run(()=>download(s))}>Download standalone ZIP</button><button className="button secondary" disabled={busy} onClick={()=>useScript(s)}>Create new version</button>{deleteButton(s)}</div>{details(s)}
      </article>)}
      {library.nextCursors.scripts?<button disabled={busy} onClick={()=>void run(()=>more('scripts'))}>Load more scripts</button>:null}
      <hr/><h3>A/B testing</h3><p>Choose saved versions. Their settings and original files stay unchanged. Each page runs one script with Variant=A or Variant=B.</p>
      <form onSubmit={saveTest}><fieldset className="ab-form" disabled={busy||!library.scripts.length}><legend>New A/B test</legend>
        <label>Test name<input required maxLength={80} value={testName} onChange={e=>setTestName(e.target.value)} placeholder="For example: Standard vs Cache"/></label>
        <div className="ab-arms">{(['A','B'] as const).map(v=>{const id=v==='A'?a:b,s=library.scripts.find(s=>s.id===id);return <div key={v}><label>Script {v}<select aria-label={'Script '+v} required value={id} onChange={e=>(v==='A'?setA:setB)(e.target.value)}><option value="">Choose a saved script</option>{library.scripts.map(option)}</select></label>{s?<p className="ab-help">{description(s.settings)}</p>:null}</div>;})}</div>
        <label className="ab-traffic">Traffic to B (%)<input aria-label="Traffic to B (%)" type="number" required min={0} max={100} step={1} value={traffic} onChange={e=>setTraffic(e.target.value)}/><span>A: {traffic!==''&&Number(traffic)>=0&&Number(traffic)<=100?100-Number(traffic):'—'}% · B: {traffic||'—'}%</span></label>
        {a&&a===b?<p className="ab-help">Both variants use the same script. This is an A/A check.</p>:null}
        <button className="button primary" type="submit">Save A/B test</button>
      </fieldset></form>
      <h3>Saved tests</h3>{!library.tests.length?<p>No saved tests yet.</p>:library.tests.map(t=><article className="ab-saved" key={t.id} aria-label={'Test: '+t.name}>
        <h4>{t.name}</h4><p>Version {t.id.slice(-8)} · A {100-t.trafficBPercent!}% / B {t.trafficBPercent}%</p>
        <dl>{(['A','B'] as const).map(v=><div key={v}><dt>{v}: {t.scripts![v].name}</dt><dd>{description(t.scripts![v].settings)} · Version {t.scripts![v].id.slice(-8)}</dd></div>)}</dl>
        <button className="button primary" disabled={busy} onClick={()=>void run(()=>download(t))}>Download A/B ZIP</button> {deleteButton(t)}{details(t)}
      </article>)}
      {library.nextCursors.tests?<button disabled={busy} onClick={()=>void run(()=>more('tests'))}>Load more tests</button>:null}
      {(library.deletedScripts?.length||library.deletedTests?.length)?<details className="ab-baseline"><summary>Deleted scripts and tests</summary>
        <p>Deleted versions are kept here for recovery. They are not offered when creating a new test.</p>
        {[...(library.deletedScripts||[]),...(library.deletedTests||[])].map(p=><article className="ab-saved" key={p.id} aria-label={'Deleted: '+p.name}><h4>{p.name}</h4><p>{p.collection==='scripts'?'Script':'A/B test'} · Version {p.id.slice(-8)}</p><button type="button" disabled={busy} onClick={()=>void removeSaved(p,true).catch(e=>setError(e.message))}>Restore</button></article>)}
      </details>:null}
      <p>Saving creates a version. Upload its <strong>complete ZIP</strong> to the existing Tanjug Pages project to activate a standalone script or an A/B test. The active Pages deployment is not tracked here.</p>
    </>}
  </section>;
}
