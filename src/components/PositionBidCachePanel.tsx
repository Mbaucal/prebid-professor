import {useEffect,useRef,useState} from 'react';

export type BidCachePayload={revision:string;bidCacheAvailable:boolean;bidCachePositions:string[];
  prebidMode:{enabled:boolean;bidCache:{enabled:boolean;maxBidAgeSeconds:number;positionOverrides?:Record<string,boolean>}}};
export async function fetchBidCacheSettings(site:string,body?:unknown):Promise<BidCachePayload>{
  const response=await fetch(`/api/publishers/${encodeURIComponent(site)}/prebid-mode`,{
    method:body?'PUT':'GET',credentials:'same-origin',cache:'no-store',
    ...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),
  });
  const data=await response.json();if(!response.ok)throw Error(data.error||'Could not load bid cache settings.');return data;
}
export default function PositionBidCachePanel({publisherId,code,onClose,onSaved}:{publisherId:string;code:string;onClose:()=>void;onSaved:(data:BidCachePayload)=>void}){
  const dialog=useRef<HTMLElement>(null);
  useEffect(()=>{const previous=document.activeElement as HTMLElement|null;dialog.current?.focus();return()=>previous?.focus();},[]);
  const [data,setData]=useState<BidCachePayload|null>(null),[choice,setChoice]=useState('inherit');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  function accept(next:BidCachePayload){setData(next);const override=next.prebidMode.bidCache.positionOverrides?.[code];setChoice(override===undefined?'inherit':override?'on':'off');}
  async function reload(){setBusy(true);setError('');setMessage('');try{accept(await fetchBidCacheSettings(publisherId));}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  useEffect(()=>{let active=true;fetchBidCacheSettings(publisherId).then(next=>{if(active)accept(next);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[publisherId,code]);
  async function save(){if(!data)return;setBusy(true);setError('');setMessage('');try{
    const bidCache={...data.prebidMode.bidCache,positionOverrides:{...data.prebidMode.bidCache.positionOverrides}};
    if(choice==='inherit')delete bidCache.positionOverrides[code];else bidCache.positionOverrides[code]=choice==='on';
    const next=await fetchBidCacheSettings(publisherId,{revision:data.revision,enabled:data.prebidMode.enabled,bidCache});
    accept(next);onSaved(next);setMessage('Saved. Generate a new named script to apply this setting.');
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const inherited=data?.prebidMode.bidCache.enabled??false;
  const effective=choice==='inherit'?inherited:choice==='on';
  const original=data?.prebidMode.bidCache.positionOverrides?.[code];
  const dirty=choice!==(original===undefined?'inherit':original?'on':'off');
  const supported=data?.bidCacheAvailable&&data.bidCachePositions.includes(code);
  return <div className="modal-backdrop"><section className="modal-card ad-unit-modal" ref={dialog} tabIndex={-1} onKeyDown={event=>{
      if(event.key==='Escape'&&!busy){event.preventDefault();onClose();}
      if(event.key==='Tab'){
        const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select:not(:disabled)')??[]);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialog.current)){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }} role="dialog" aria-modal="true" aria-labelledby="position-cache-heading">
    <div className="modal-heading"><div><span className="panel-kicker">Ad position</span><h2 id="position-cache-heading">Bid cache · {code}</h2></div><button className="icon-button" aria-label="Close bid cache settings" disabled={busy} onClick={onClose}>×</button></div>
    <div className="publisher-form" style={{gridTemplateColumns:"minmax(0,1fr)"}}>
    {error?<p className="form-error" role="alert">{error}</p>:null}
    {message?<p role="status">{message}</p>:null}
    {!data&&!error?<p>Loading bid cache settings…</p>:null}
    {data&&supported?<>
      <label><span>Bid cache for {code}</span><select aria-label={`Bid cache for ${code}`} value={choice} disabled={busy||!data.prebidMode.enabled} onChange={e=>{setChoice(e.target.value);setMessage('');}}>
        <option value="inherit">Use site setting ({inherited?'On':'Off'})</option><option value="on">On — allow valid cached bids</option><option value="off">Off — current auction only</option>
      </select></label>
      <p><strong>Effective: {!data.prebidMode.enabled?'Inactive — Prebid is off':effective?'On':'Off'}</strong></p>
      <p>Every refresh still starts a new auction. {effective?'Valid, unused bids from earlier auctions for this position may also compete.':'This position uses only bids from its current auction.'}</p>
      {effective?<p>Maximum cached bid age: {data.prebidMode.bidCache.maxBidAgeSeconds} seconds, or less if its original TTL expires.</p>:null}
      <p>Applies to the next named script in Releases → Scripts and A/B tests.</p>
      <button className="button primary" disabled={busy||!dirty||!data.prebidMode.enabled} onClick={()=>void save()}>{busy?'Saving…':'Save position setting'}</button>
    </>:data?<p>Position cache settings are not supported by this site's current generator.</p>:null}
    {error?<button className="button secondary" disabled={busy} onClick={()=>void reload()}>Reload bid cache settings</button>:null}
    </div>
  </section></div>;
}
