import {useEffect,useRef,useState} from 'react';
type Deal={id:string;name:string;bidder:string;dealId:string;positions:string[];startsAt:string;endsAt:string;enabled:boolean;mode:'price'|'contract-priority'};
type Settings={schemaVersion:1;entries:Deal[]};
type Payload={revision:string;settings:Settings;bidders:{bidder:string;enabled:boolean}[];units:{code:string;enabled:boolean}[];notice:string;validationIssue:string|null;servingAvailable:boolean;plan:{entries:{id:string;name:string;startsAt:string;endsAt:string;inventory:{code:string;adUnitPath:string;sizeMap:{viewport:number[];sizes:(number[]|string)[]}[]|null}[];priorityInstruction:string;creativeAdIdMacro:string;targeting:{key:string;value:string};eligibility:string}[]}};
async function api(endpoint:string,body?:unknown){
 const response=await fetch(endpoint,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'content-type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
 const data=await response.json();if(!response.ok)throw Error(data.error||'Deals could not be saved.');return data;
}
export default function DealsPanel({publisherId,onChanged,endpoint}:{publisherId:string;onChanged?:()=>void|Promise<void>;endpoint?:string}){
 const url=endpoint??`/api/publishers/${encodeURIComponent(publisherId)}/deals`;
 const [payload,setPayload]=useState<Payload|null>(null),[entries,setEntries]=useState<Deal[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const generation=useRef(0),currentSite=useRef(publisherId);currentSite.current=publisherId;
 async function load(){const token=++generation.current,site=publisherId;setBusy(true);setError('');try{const value:Payload=await api(url);if(token!==generation.current||currentSite.current!==site)return;setPayload(value);setEntries(value.settings.entries);setMessage(value.validationIssue||'Saved deals loaded.');}catch(e){if(token===generation.current&&currentSite.current===site)setError(e instanceof Error?e.message:'Deals could not be loaded.');}finally{if(token===generation.current&&currentSite.current===site)setBusy(false);}}
 useEffect(()=>{setPayload(null);setEntries([]);setMessage('');void load();return()=>{generation.current++;};},[publisherId,url]); // Site identity invalidates every pending operation.
 function update(id:string,patch:Partial<Deal>){setEntries(rows=>rows.map(row=>row.id===id?{...row,...patch}:row));setMessage('Unsaved deals.');}
 async function save(){if(!payload)return;const token=++generation.current,site=publisherId;setBusy(true);setError('');try{const value=await api(url,{revision:payload.revision,settings:{schemaVersion:1,entries}});if(token!==generation.current||currentSite.current!==site)return;setPayload({...payload,revision:value.revision,settings:value.settings,plan:value.plan});setEntries(value.settings.entries);setMessage('Deals saved for the next generated script. Select Tessera 3.16.0 in Script setup to apply them. Existing scripts are unchanged.');await onChanged?.();}catch(e){if(token===generation.current&&currentSite.current===site)setError(e instanceof Error?e.message:'Deals could not be saved.');}finally{if(token===generation.current&&currentSite.current===site)setBusy(false);}}
 return <section className="config-page global-card" aria-labelledby="deals-title" aria-busy={busy}>
  <h2 id="deals-title">Deals</h2><p>Record the deal agreed with your partner. Saving here does not create an SSP deal or change GAM.</p>
  {error&&<div className="form-error" role="alert">{error}</div>}<p role="status">{busy?'Loading or saving deals…':message}</p>
  {!payload?<button className="button" disabled={busy} onClick={()=>void load()}>Retry deals</button>:<>
   <p>{payload.notice}</p>{!payload.servingAvailable&&<p className="form-error">Your selected script does not apply Deals. Select Tessera 3.16.0 in Script setup before generating a new script. Existing scripts are unchanged.</p>}
   <fieldset disabled={busy} style={{border:0,padding:0,minWidth:0}}>
    {entries.map(row=><div className="publisher-form" key={row.id} style={{marginBottom:24,padding:0}}>
     <label><span>Deal name</span><input value={row.name} maxLength={100} onChange={e=>update(row.id,{name:e.target.value})}/></label>
     <label><span>Bidder</span><select aria-label="Bidder" value={row.bidder} onChange={e=>update(row.id,{bidder:e.target.value})}><option value="">Choose bidder</option>{payload.bidders.map(b=><option key={b.bidder} value={b.bidder}>{b.bidder}{b.enabled?'':' (disabled)'}</option>)}</select></label>
     <label><span>Deal ID</span><input value={row.dealId} maxLength={128} onChange={e=>update(row.id,{dealId:e.target.value})}/></label>
     <label><span>Starts (UTC)</span><input type="datetime-local" value={row.startsAt.slice(0,16)} onChange={e=>update(row.id,{startsAt:e.target.value?e.target.value+':00.000Z':''})}/></label>
     <label><span>Ends (UTC)</span><input type="datetime-local" value={row.endsAt.slice(0,16)} onChange={e=>update(row.id,{endsAt:e.target.value?e.target.value+':00.000Z':''})}/></label>
     <label><span>Commercial mode</span><select aria-label="Commercial mode" value={row.mode} onChange={e=>update(row.id,{mode:e.target.value as Deal['mode']})}><option value="price">Compete by price</option><option value="contract-priority">Agreed deal priority in GAM</option></select></label>
     <label className="check-row"><input type="checkbox" checked={row.enabled} onChange={e=>update(row.id,{enabled:e.target.checked})}/> Active</label>
     <p style={{gridColumn:"1 / -1"}}>Positions · leave all unchecked for all site positions</p>{payload.units.map(unit=><label className="check-row" key={unit.code} style={{display:'inline-flex',marginRight:12,gap:5}}><input type="checkbox" checked={row.positions.includes(unit.code)} onChange={e=>update(row.id,{positions:e.target.checked?[...row.positions,unit.code]:row.positions.filter(p=>p!==unit.code)})}/>{unit.code}</label>)}
     <p style={{gridColumn:"1 / -1"}}>{row.bidder==='pubmatic'?'Active IDs are sent in PubMatic’s documented deals field.':'No outgoing deal parameter is added. The partner must return the agreed deal.'}</p>
     <button className="button" onClick={()=>{setEntries(rows=>rows.filter(e=>e.id!==row.id));setMessage('Unsaved deals.');}}>Remove deal</button>
    </div>)}
    <div className="form-actions" style={{display:"flex",gap:8,flexWrap:"wrap"}}><button className="button" disabled={entries.length>=50} onClick={()=>{setEntries(rows=>[...rows,{id:crypto.randomUUID(),name:'',bidder:'',dealId:'',positions:[],startsAt:'',endsAt:'',enabled:false,mode:'price'}]);setMessage('Unsaved deals.');}}>Add deal</button><button className="button primary" onClick={()=>void save()}>Save deals</button><button className="button" onClick={()=>void load()}>Reload saved deals</button></div>
   </fieldset>
   <details><summary>Saved GAM plan · review only</summary><p>Configure the agreed dates, inventory, sizes and priority in GAM separately. No live changes are made here.</p>{payload.plan.entries.map(row=><div key={row.id}><strong>{row.name}</strong><p>{row.startsAt} → {row.endsAt}</p>{row.inventory.map(unit=><p key={unit.code}>{unit.code} · {unit.adUnitPath} · {unit.sizeMap?unit.sizeMap.map(map=>`${map.viewport.join("×")}: ${map.sizes.map(size=>Array.isArray(size)?size.join("×"):size).join(", ")||"disabled"}`).join("; "):"Size map unavailable — review inventory before setup"}</p>)}<p><code>{row.targeting.key} = {row.targeting.value}</code></p><p>Creative ad ID: <code>{row.creativeAdIdMacro}</code></p><p>{row.priorityInstruction}</p><p>{row.eligibility}</p></div>)}</details>
  </>}
 </section>;
}
