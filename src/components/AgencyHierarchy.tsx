import {useState,type ReactNode} from 'react';
import {agencyFor,inAgency,type Agency,type Organization} from '../organization';
import type {PublisherAccount} from '../shared/types';
export function AgencyLogo({agency}:{agency:Pick<Agency,'name'|'logo'>|null}){
  const [failed,setFailed]=useState<string|null>(null);
  return <span className="agency-logo" aria-hidden="true">{agency?.logo&&failed!==agency.logo?<img src={agency.logo} alt="" onError={()=>setFailed(agency.logo)}/>:<span>{agency?.name.split(/\s+/).slice(0,2).map(s=>Array.from(s)[0]).join('').toUpperCase()||'—'}</span>}</span>;
}
export function AgencyFilter({data,value,onChange}:{data:Organization;value:string;onChange:(value:string)=>void}){
  return <label className="agency-filter"><span>Agency</span><select value={value} onChange={e=>onChange(e.target.value)}><option value="all">All agencies</option><option value="none">Without agency</option>{data.agencies.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>;
}
export default function AgencyHierarchy({data,publishers,filter,onFilter,onManage,renderPublisher}:{data:Organization;publishers:PublisherAccount[];filter:string;onFilter:(value:string)=>void;onManage:()=>void;renderPublisher:(publisher:PublisherAccount,searching:boolean)=>ReactNode}){
  const [query,setQuery]=useState(''),[closed,setClosed]=useState<Record<string,boolean>>({});
  const search=query.trim().toLocaleLowerCase(),groups=[...data.agencies,null];let matches=0;
  const rendered=groups.map(agency=>{
    const id=agency?.id??'none',name=agency?.name??'Without agency';
    if(filter!=='all'&&filter!==id)return null;
    const all=publishers.filter(p=>inAgency(data,p.id,id));
    const list=all.flatMap(p=>{
      if(!search||[name,p.name,p.id].some(s=>s.toLocaleLowerCase().includes(search)))return [p];
      const sites=p.sites.filter(s=>[s.name,s.domain,s.id].some(v=>v.toLocaleLowerCase().includes(search)));
      return sites.length?[{...p,sites}]:[];
    });
    if(search&&!list.length&&!name.toLocaleLowerCase().includes(search))return null;
    matches++;const expanded=!!search||!closed[id];
    return <section className="agency-tree-group" key={id}>
      <button className="agency-tree-heading" type="button" aria-expanded={expanded} onClick={()=>setClosed({...closed,[id]:expanded})}>
        <span>{expanded?'▾':'▸'}</span><AgencyLogo agency={agency}/><span className="agency-tree-name">{name}<small>{all.length} publisher(s) · {all.reduce((n,p)=>n+p.sitesCount,0)} site(s)</small></span>
      </button>
      {expanded?<div className="agency-tree-publishers">{list.length?list.map(p=>renderPublisher(p,!!search)):<p className="publisher-nav-message">No publishers in this agency.</p>}</div>:null}
    </section>;
  });
  return <div className="agency-hierarchy"><div className="agency-tree-tools"><AgencyFilter data={data} value={filter} onChange={onFilter}/><label><span>Search hierarchy</span><input type="search" placeholder="Agency, publisher or site" value={query} onChange={e=>setQuery(e.target.value)}/></label><button className="publisher-link muted" type="button" onClick={onManage}>Manage agencies</button></div>{matches?rendered:<p className="publisher-nav-message">No matching agencies, publishers or sites.</p>}</div>;
}
