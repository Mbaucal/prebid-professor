import {useEffect,useRef,useState,type FormEvent} from 'react';
import {createPortal} from 'react-dom';
import {agencyFor,prepareAgencyLogo,type Agency,type OrganizationController} from '../organization';
import {AgencyLogo} from './AgencyHierarchy';
import type {PublisherAccount} from '../shared/types';

function AgencyEditor({agency,controller,onClose}:{agency:Agency|null;controller:OrganizationController;onClose:()=>void}){
  const [name,setName]=useState(agency?.name??''),[logo,setLogo]=useState(agency?.logo??null),[error,setError]=useState(''),[processing,setProcessing]=useState(false);
  const dialog=useRef<HTMLDialogElement>(null),busy=controller.saving||processing;
  useEffect(()=>{dialog.current?.showModal();},[]);
  async function submit(e:FormEvent){e.preventDefault();setError('');try{await controller.save(agency?'/agencies/'+agency.id:'/agencies',{name,logo,...(agency?{expectedRevision:agency.revision}:{})});onClose();}catch(e){setError((e as Error).message);}}
  return createPortal(<dialog ref={dialog} className="agency-dialog" onCancel={e=>{e.preventDefault();if(!busy)onClose();}} aria-labelledby="agency-editor-title"><form onSubmit={submit}>
    <div className="panel-heading"><h2 id="agency-editor-title">{agency?'Edit agency':'New agency'}</h2><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Close agency editor">×</button></div>
    <label><span>Agency name</span><input autoFocus required maxLength={120} placeholder="Example Agency" value={name} disabled={busy} onChange={e=>setName(e.target.value)}/></label>
    <div className="agency-logo-editor"><AgencyLogo agency={{name,logo}}/><label><span>Agency logo (optional)</span><input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={async e=>{const file=e.target.files?.[0];e.target.value='';if(!file)return;setProcessing(true);setError('');try{setLogo(await prepareAgencyLogo(file));}catch(e){setError((e as Error).message);}finally{setProcessing(false);}}}/><small>PNG, JPG or WebP, up to 5 MB. Initials appear when no logo is added.</small></label></div>
    {logo?<button type="button" className="button secondary" disabled={busy} onClick={()=>setLogo(null)}>Remove logo</button>:null}
    {error?<p className="form-error" role="alert">{error}</p>:null}
    <div className="modal-actions"><button type="button" className="button secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{processing?'Processing logo…':controller.saving?'Saving…':'Save agency'}</button></div>
  </form></dialog>,document.body);
}
function PublisherAssignment({publisher,controller,onOpen}:{publisher:PublisherAccount;controller:OrganizationController;onOpen:(id:string)=>void}){
  const membership=controller.data.memberships.find(m=>m.publisherId===publisher.id),actual=membership?.agencyId??'';
  const [target,setTarget]=useState(actual),[expected,setExpected]=useState(membership?.revision??0),[message,setMessage]=useState('');
  // A refreshed snapshot resets the draft; stale saves are rejected by the API.
  useEffect(()=>{setTarget(actual);setExpected(membership?.revision??0);},[actual,membership?.revision]);
  async function save(){setMessage('');try{await controller.save('/publishers/'+publisher.id+'/agency',{agencyId:target||null,expectedRevision:expected});setMessage('Agency saved.');}catch(e){setMessage((e as Error).message);}}
  return <div className="agency-assignment"><div><button type="button" className="agency-publisher-open" onClick={()=>onOpen(publisher.id)}>{publisher.name}</button><small>{publisher.sitesCount} site(s)</small></div><select aria-label={`Agency for ${publisher.name}`} value={target} disabled={controller.saving||controller.loading||!!controller.error} onChange={e=>{setTarget(e.target.value);setMessage('');}}><option value="">Without agency</option>{controller.data.agencies.map(a=><option value={a.id} key={a.id}>{a.name}</option>)}</select><button className="button secondary" type="button" disabled={target===actual||controller.saving||controller.loading||!!controller.error} onClick={()=>void save()}>Save assignment</button>{message?<p role="status">{message}</p>:null}</div>;
}
export default function AgenciesPanel({controller,publishers,onOpenPublisher,onOpenAgency}:{controller:OrganizationController;publishers:PublisherAccount[];onOpenPublisher:(id:string)=>void;onOpenAgency:(id:string)=>void}){
  const [editing,setEditing]=useState<Agency|null|undefined>(undefined),[search,setSearch]=useState('');
  const visible=publishers.filter(p=>[p.name,p.id,agencyFor(controller.data,p.id)?.name??'Without agency',...p.sites.map(s=>s.domain)].some(s=>s.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  return <section className="content-page agency-page"><article className="panel"><div className="panel-heading"><div><span className="panel-kicker">Organization</span><h2>Agency → Publisher → Site</h2></div><div className="agency-actions"><button className="button secondary" type="button" disabled={controller.saving||controller.loading} onClick={()=>void controller.reload()}>Reload agencies</button><button className="button primary" type="button" disabled={controller.saving||controller.loading||!!controller.error} onClick={()=>setEditing(null)}>＋ New agency</button></div></div><p>Group publishers under an agency and add its logo. Choose an agency for each publisher below.</p>{controller.loading?<p role="status">Loading agencies…</p>:null}{controller.error?<p role="alert" className="form-error">{controller.error}</p>:null}
    <div className="agency-cards">{[...controller.data.agencies,null].map(a=>{const pubs=publishers.filter(p=>(agencyFor(controller.data,p.id)?.id??null)===(a?.id??null));return <article className="agency-card" key={a?.id??'none'}><div className="agency-card-heading"><AgencyLogo agency={a}/><h3>{a?.name??'Without agency'}</h3></div><p>{pubs.length} publisher(s) · {pubs.reduce((n,p)=>n+p.sitesCount,0)} site(s)</p><div className="agency-actions"><button className="button secondary" type="button" onClick={()=>onOpenAgency(a?.id??'none')}>Open publishers</button>{a?<button type="button" className="button secondary" disabled={controller.loading||controller.saving||!!controller.error} onClick={()=>setEditing(a)}>Edit {a.name}</button>:null}</div></article>;})}</div>
  </article><article className="panel"><div className="panel-heading"><h2>Publisher assignments</h2><label><span>Find publisher</span><input type="search" value={search} placeholder="Agency, publisher or domain" onChange={e=>setSearch(e.target.value)}/></label></div>{visible.length?visible.map(p=><PublisherAssignment key={p.id} publisher={p} controller={controller} onOpen={onOpenPublisher}/>):<p>No matching publishers.</p>}</article>{editing!==undefined?<AgencyEditor agency={editing} controller={controller} onClose={()=>setEditing(undefined)}/>:null}</section>;
}
