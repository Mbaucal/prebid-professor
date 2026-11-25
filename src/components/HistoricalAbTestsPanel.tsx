import {useEffect,useRef,useState} from 'react';

import type {ScriptSettings as Settings} from '../../worker/experiments/saved-script-settings.mjs';
import type {AbHistoryCollection as Collection,AbHistoryListing as History,AbHistoryRow as Row} from '../../worker/experiments/ab-history-contracts.mjs';

const collections:Collection[]=['namedTests','generatedTests','scripts'];
const label=(kind:Collection)=>kind==='scripts'?'Earlier saved scripts':kind==='namedTests'?'Named A/B tests':'Earlier generated A/B tests';
const settings=(value:Settings)=>`${value.mode==='auction-with-cache'?`New auctions + cached bids, up to ${value.maxBidAgeSeconds??'unknown'} s`:'Fresh auction'} · ${value.refreshSeconds==null?'saved position refresh rules':`${value.refreshSeconds} s refresh`}`;
async function problem(response:Response,fallback:string){
  try{return new Error(((await response.json()) as {error?:string}).error||fallback);}catch{return new Error(fallback);}
}

/** Original pilot records are shown beside generic tests, without turning them into new experiments. */
export default function HistoricalAbTestsPanel({endpoint}:{endpoint:string}){
  const [history,setHistory]=useState<History|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const [notice,setNotice]=useState<{text:string;error:boolean}|null>(null),[busy,setBusy]=useState('');
  const active=useRef(true),ticket=useRef(0),lock=useRef(false),controller=useRef<AbortController|null>(null);
  useEffect(()=>{active.current=true;void load();return()=>{active.current=false;ticket.current++;controller.current?.abort();lock.current=false;};},[endpoint]);
  async function load(collection?:Collection,cursor?:string){
    if(lock.current)return;
    lock.current=true;setLoading(true);setError('');
    const current=++ticket.current;controller.current?.abort();controller.current=new AbortController();
    try{
      const query=collection&&cursor?`?collection=${collection}&cursor=${encodeURIComponent(cursor)}`:'';
      const response=await fetch(endpoint+'/history'+query,{credentials:'same-origin',cache:'no-store',signal:controller.current.signal});
      if(!response.ok)throw await problem(response,'Could not load earlier tests. Retry.');
      const next=await response.json() as History;
      if(!active.current||current!==ticket.current)return;
      setHistory(old=>{
        if(!collection||!old)return next;
        const section=next.sections[collection],previous=old.sections[collection];
        if(!section)return old;
        const merge=(left:Row[],right:Row[])=>[...new Map([...left,...right].map(row=>[row.id,row])).values()];
        return {...old,sections:{...old.sections,[collection]:{...section,items:merge(previous?.items??[],section.items),deleted:merge(previous?.deleted??[],section.deleted)}}};
      });
    }catch(failure){if(active.current&&current===ticket.current)setError(failure instanceof Error?failure.message:'Could not load earlier tests. Retry.');}
    finally{if(active.current&&current===ticket.current){setLoading(false);lock.current=false;}}
  }
  async function download(row:Row){
    if(lock.current||!row.downloadUrl||row.state!=='stored'||row.deletedAt)return;
    lock.current=true;setBusy(row.id);setNotice(null);
    try{
      const url=new URL(row.downloadUrl,location.origin);
      if(url.origin!==location.origin||!url.pathname.startsWith(endpoint+'/history/')||url.search||url.hash)throw Error('The saved download address is unavailable. Reload earlier tests.');
      const response=await fetch(url,{credentials:'same-origin',cache:'no-store'});
      if(!response.ok)throw await problem(response,'Could not read this saved ZIP. Retry.');
      const bytes=await response.arrayBuffer();
      const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
      const header=response.headers.get('x-package-sha256');
      if(bytes.byteLength!==row.bytes||sha!==row.sha256||(header&&header!==sha))throw Error('The downloaded ZIP differs from the saved package. Nothing was downloaded. Retry.');
      if(!active.current)return;
      const blob=URL.createObjectURL(new Blob([bytes],{type:'application/zip'})),link=document.createElement('a');
      link.href=blob;link.download=row.name.replace(/[\\/:*?"<>|]/g,'-')+'-'+row.id.slice(-8)+'.zip';link.click();setTimeout(()=>URL.revokeObjectURL(blob),60000);
      setNotice({text:`${row.name}: original ZIP downloaded and checked.`,error:false});
    }catch(failure){if(active.current)setNotice({text:failure instanceof Error?failure.message:'Could not download this saved ZIP. Retry.',error:true});}
    finally{if(active.current){setBusy('');lock.current=false;}}
  }
  function card(row:Row){
    return <article key={row.id} className="ab-tests-item historical-ab-item" aria-label={`Earlier version: ${row.name}`}>
      <h4 className="ab-tests-name">{row.name}</h4>
      <p>{row.createdAt?new Date(row.createdAt).toLocaleString():row.id==='tanjug-aa-1.0.2'?'Accepted baseline · save date not recorded':'Save date unavailable'}{row.deletedAt?' · Deleted':''} · {row.runtimeVersion?`script ${row.runtimeVersion}`:'Script version unavailable'}{row.prebidVersion?` · Prebid ${row.prebidVersion}`:''}</p>
      {typeof row.trafficBPercent==='number'?<p>A {100-row.trafficBPercent}% · B {row.trafficBPercent}%</p>:null}
      {row.scripts?<dl className="ab-tests-arms">{(['A','B'] as const).map(side=><div key={side}><dt>Version {side}</dt><dd><strong>{row.scripts![side].name}</strong> · {settings(row.scripts![side].settings)}</dd></div>)}</dl>:row.settings?<p>{settings(row.settings)}</p>:null}
      <p className="ab-tests-help">{row.reporting==='variant-only'?'Variant-only package.':'Standalone script without A/B labels.'} Version ID reporting is unavailable for this earlier version. This record does not confirm which ZIP is deployed.</p>
      {row.state==='unavailable'?<p role="alert" className="runtime-error">{row.reason||'This saved version could not be verified.'}</p>:null}
      {row.downloadUrl&&!row.deletedAt?<button type="button" disabled={loading||Boolean(busy)||row.state!=='stored'} onClick={()=>void download(row)}>{busy===row.id?'Reading original ZIP…':'Download original ZIP'}</button>:null}
      <details><summary>Version details</summary><p><code>{row.id}</code></p>{row.sha256?<p>ZIP SHA-256 <code>{row.sha256}</code></p>:null}</details>
    </article>;
  }
  function section(kind:Collection){
    const value=history?.sections[kind];
    if(!value)return null;
    return <div className="historical-ab-section" key={kind}>
      <h4>{label(kind)}</h4>
      {value.error?<p role="alert" className="runtime-error">{value.error} <button type="button" disabled={loading||Boolean(busy)} onClick={()=>void load()}>Retry earlier tests</button></p>:null}
      {value.items.map(card)}
      {value.nextCursor?<button type="button" disabled={loading||Boolean(busy)} onClick={()=>void load(kind,value.nextCursor!)}>Load more {kind==='scripts'?'earlier scripts':'earlier tests'}</button>:null}
      {value.deleted.length?<details><summary>Deleted earlier versions ({value.deleted.length})</summary>{value.deleted.map(card)}</details>:null}
    </div>;
  }
  const count=history?(history.baseline?1:0)+collections.reduce((sum,kind)=>sum+(history.sections[kind]?.items.length??0),0):0;
  return <section className="historical-ab-tests" aria-labelledby="historical-ab-tests-title">
    <div className="measurement-heading"><h3 id="historical-ab-tests-title">Earlier A/B tests</h3><button type="button" disabled={loading||Boolean(busy)} onClick={()=>void load()}>Reload earlier tests</button></div>
    <p>Previous tests and scripts are kept here with their original files. Create new source versions below to use Version ID reporting.</p>
    {error?<p role="alert" className="runtime-error">{error} <button type="button" disabled={loading||Boolean(busy)} onClick={()=>void load()}>Retry earlier tests</button></p>:null}
    {loading?<p role="status" className="ab-tests-status">Loading earlier tests…</p>:null}
    {notice?<p role={notice.error?'alert':'status'} className={notice.error?'runtime-error':'ab-tests-status'}>{notice.text}</p>:null}
    {history?<>
      {history.baselineError?<p role="alert" className="runtime-error">{history.baselineError}</p>:null}
      {history.baseline?card(history.baseline):null}
      {section('namedTests')}{section('generatedTests')}
      {history.sections.scripts?.items.length||history.sections.scripts?.deleted.length||history.sections.scripts?.error?<details><summary>Earlier saved scripts</summary>{section('scripts')}</details>:null}
      {!count&&!history.baselineError&&!collections.some(kind=>history.sections[kind]?.error)?<p>No earlier tests or scripts are saved for this site.</p>:null}
    </>:null}
  </section>;
}
