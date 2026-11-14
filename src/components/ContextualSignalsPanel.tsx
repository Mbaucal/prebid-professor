import {useEffect,useRef,useState} from 'react';
import type {ContextualSignals} from '../../shared/contextual-signals/settings.mjs';
import type {ContextualPrebidStatus} from '../../worker/site-runtime/contextual-prebid-status.mjs';
import '../contextual-signals.css';

type Props={publisherId:string;onChanged?:()=>void|Promise<void>;endpoint?:string};
type ContextualSignalsPayload={revision:string;settings:ContextualSignals;bidders:{bidder:string;enabled:boolean;configured:boolean}[];enablePrebid:boolean;prebidVersion:string|null;runtimeEligible:boolean;compatibility:{bidder:string;delivery:string;note:string;source:string|null;evidence:string;serverAcceptance:string}[];taxonomies:{id:string;label:string;segtax:number;categories:{id:string;name:string}[]}[];published:false;prebidIntegration:ContextualPrebidStatus};
type MappingDraft={value:string;ids22:string;ids30:string};
type Draft=Omit<ContextualSignals,'mappings'>&{mappings:MappingDraft[]};
const splitIds=(value:string)=>value.split(/[\s,]+/).filter(Boolean);
function draftFor(settings:ContextualSignals):Draft{
  return {...structuredClone(settings),mappings:settings.mappings.map(row=>({value:row.value,ids22:(row.taxonomies['iab-content-2.2']??[]).join(', '),ids30:(row.taxonomies['iab-content-3.0']??[]).join(', ')}))};
}
export function contextualSignalsFromDraft(draft:Draft):ContextualSignals{
  return {...draft,mappings:draft.mappings.map(row=>({value:row.value,taxonomies:{'iab-content-2.2':splitIds(row.ids22),'iab-content-3.0':splitIds(row.ids30)}}))};
}
export default function ContextualSignalsPanel({publisherId,onChanged,endpoint}:Props){
  const [data,setData]=useState<ContextualSignalsPayload|null>(null);
  const [draft,setDraft]=useState<Draft|null>(null);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false);
  const [error,setError]=useState(''),[message,setMessage]=useState('');
  const [reload,setReload]=useState(0);
  const alive=useRef(false),operation=useRef(0),savingRef=useRef(false);
  const saveFeedback=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(error||message)saveFeedback.current?.scrollIntoView({block:'nearest'});},[error,message]);
  const url=endpoint??`/api/publishers/${encodeURIComponent(publisherId)}/contextual-signals`;
  async function request(body?:unknown,signal?:AbortSignal):Promise<ContextualSignalsPayload>{
    const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const value=await response.json() as ContextualSignalsPayload&{error?:string};
    if(!response.ok)throw Error(value.error||'Could not load contextual signals.');
    return value;
  }
  useEffect(()=>{
    alive.current=true;const id=++operation.current,controller=new AbortController();
    savingRef.current=false;setSaving(false);
    setLoading(true);setError('');setMessage('');setData(null);setDraft(null);
    void request(undefined,controller.signal).then(value=>{
      if(alive.current&&id===operation.current){setData(value);setDraft(draftFor(value.settings));}
    }).catch(e=>{if(alive.current&&id===operation.current&&!controller.signal.aborted)setError((e as Error).message);})
      .finally(()=>{if(alive.current&&id===operation.current)setLoading(false);});
    return()=>{alive.current=false;controller.abort();};
  },[url,reload]);
  function change(update:Partial<Draft>){setDraft(value=>value?{...value,...update}:value);setMessage('');}
  function changeRow(index:number,update:Partial<MappingDraft>){if(draft)change({mappings:draft.mappings.map((row,i)=>i===index?{...row,...update}:row)});}
  async function save(){
    if(!data||!draft||savingRef.current)return;
    savingRef.current=true;setSaving(true);setError('');setMessage('');const id=operation.current;
    try{
      const value=await request({revision:data.revision,settings:contextualSignalsFromDraft(draft)});
      if(!alive.current||id!==operation.current)return;
      setData(value);setDraft(draftFor(value.settings));setMessage('Saved. Generate a new script with version 3.21.0, 3.21.1 or 3.21.2 to use these settings. Existing scripts are unchanged.');
      try{await onChanged?.();}catch{ /* The settings save succeeded; a parent refresh does not undo it. */ }
    }catch(e){if(alive.current&&id===operation.current)setError((e as Error).message);}
    finally{if(id===operation.current){savingRef.current=false;if(alive.current)setSaving(false);}}
  }
  const dirty=Boolean(data&&draft&&JSON.stringify(contextualSignalsFromDraft(draft))!==JSON.stringify(contextualSignalsFromDraft(draftFor(data.settings))));
  function selectedLabels(ids:string,taxonomy:string){
    const categories=data?.taxonomies.find(item=>item.id===taxonomy)?.categories??[];
    return splitIds(ids).map(id=>`${id}: ${categories.find(item=>item.id===id)?.name??'Unknown ID in this version'}`).join(' · ');
  }
  const hasPrebidRoutes=Boolean(draft?.bidders.length);
  return <section className="contextual-signals-page" aria-labelledby="contextual-signals-heading" aria-busy={loading||saving}>
    <div className="config-toolbar"><div><span className="panel-kicker">Page context</span><h2 id="contextual-signals-heading">Contextual signals</h2><p>Map your page categories to IAB categories for Google PPS and selected bidders.</p></div></div>
    {loading?<p role="status">Loading contextual signals…</p>:null}
    {error&&!draft?<div className="form-error config-error" role="alert">{error}</div>:null}
    {!loading&&error&&!draft?<button className="button secondary" disabled={saving} type="button" onClick={()=>setReload(value=>value+1)}>Reload saved settings</button>:null}
    {!loading&&data&&draft?<>
      <fieldset className="contextual-signals-card" disabled={saving}>
        <legend>1. Category source</legend>
        <label className="check-row"><input type="checkbox" checked={draft.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>Enable contextual signals for this site</span></label>
        <label className="contextual-signals-field"><span>Page category key</span><input value={draft.sourceKey} onChange={event=>change({sourceKey:event.target.value})} placeholder="category" autoComplete="off"/><small>Reads <code>window.adsKeywords[{JSON.stringify(draft.sourceKey||'category')}]</code>. Set it before ads.js. Values match exactly; a missing or unmapped category sends no mapped signals and never delays ads.</small></label>
        {!data.runtimeEligible?<p className="contextual-signals-note">You can save the setup now. Select and save script version 3.21.2 before generating a package with contextual signals.</p>:null}
      </fieldset>
      <fieldset className="contextual-signals-card" disabled={saving}>
        <legend>2. Destinations and taxonomy versions</legend>
        <label className="check-row"><input type="checkbox" checked={draft.gam.enabled} onChange={event=>change({gam:{enabled:event.target.checked}})}/><span>Google Ad Manager PPS · IAB Content 2.2</span></label>
        <p className="contextual-signals-help">Google currently lists PPS for GAM 360. Requires PPS availability in your network and enabled demand-channel sharing. IAB Content 3.0 is not sent to Google PPS.</p>
        <p className="contextual-signals-help">This script manages page-level GAM PPS. Do not enable it alongside another PPS configuration.</p>
        <p>Choose a taxonomy only after checking support with that SSP for your account and Prebid build. Adapter forwarding alone does not confirm SSP acceptance.</p>
        {!data.enablePrebid&&hasPrebidRoutes?<p className="contextual-signals-note">Prebid is off. Bidder choices remain saved and are omitted from a GAM-only package.</p>:null}
        {data.bidders.length?<div className="contextual-signals-bidders">{data.bidders.map(bidder=>{
          const route=draft.bidders.find(item=>item.bidder===bidder.bidder);
          const compatibility=data.compatibility.find(item=>item.bidder===bidder.bidder);
          return <label className="contextual-signals-field" key={bidder.bidder}><span>{bidder.bidder}{!bidder.configured?' · not configured':!bidder.enabled?' · disabled':''}</span>
            <select aria-label={`Taxonomy for ${bidder.bidder}`} value={route?.taxonomy??''} onChange={event=>{
              const without=draft.bidders.filter(item=>item.bidder!==bidder.bidder);
              change({bidders:event.target.value?[...without,{bidder:bidder.bidder,taxonomy:event.target.value as ContextualSignals['bidders'][number]['taxonomy']}]:without});
            }}><option value="">Off</option>{data.taxonomies.map(taxonomy=><option key={taxonomy.id} value={taxonomy.id}>{taxonomy.label}</option>)}</select>
            {compatibility?<small>{compatibility.note}{compatibility.source?<> <a href={compatibility.source} target="_blank" rel="noreferrer">Adapter source</a></>:null}</small>:null}
          </label>;
        })}</div>:<p className="contextual-signals-help">No bidders configured. You can still configure Google PPS independently.</p>}
        {data.prebidVersion?<p className="contextual-signals-help">Current Prebid build: {data.prebidVersion}. Verify support again when changing adapters or versions.</p>:null}
        {hasPrebidRoutes&&data.enablePrebid?<div className="contextual-signals-note" data-contextual-build-status={data.prebidIntegration?.status??'unknown'}>
          {data.prebidIntegration?.status==='modules-present'
            ?<p>The current build lists the required contextual modules. Confirm the active provider and outgoing request on the page; module presence does not confirm SSP receipt.</p>
            :<p><strong>Bidder signals need a compatible Prebid build.</strong> {data.prebidIntegration?.status==='modules-missing'
              ?<>The current build is missing: {data.prebidIntegration.missingModules.join(', ')}.</>
              :data.prebidIntegration?.status==='no-build'?'No current Prebid build is available.':'The current build’s module list could not be verified.'} Ads can continue, but these bidder signals are not confirmed. Use the integration kit below.</p>}
          {data.prebidIntegration?.selectedBuildId&&!data.prebidIntegration.selectionMatches?<p>The saved script selection refers to a different Prebid build. Save the intended build selection before generating.</p>:null}
          <p>If your page uses another real-time data provider, include all providers, including contextualSignals, in the first realTimeData configuration before ads.js. A later configuration cannot activate a new provider.</p>
        </div>:null}
        <details className="contextual-signals-integration"><summary>Prebid integration required</summary><p>Build the custom contextual signals module into your Prebid file. It is not available on Prebid.org. Without it, ads continue and these bidder signals are omitted.</p><a className="button secondary" href={`${url}/build-kit`} download>Download Prebid integration kit</a></details>
      </fieldset>
      <fieldset className="contextual-signals-card" disabled={saving}>
        <legend>3. Category mappings</legend>
        <p>Each taxonomy has its own IDs. Enter IDs separated by commas. Mapping one version never converts IDs to another version.</p>
        {data.taxonomies.map(taxonomy=><datalist key={taxonomy.id} id={`contextual-${publisherId}-${taxonomy.id}`}>{taxonomy.categories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</datalist>)}
        {draft.mappings.length===0?<p className="contextual-signals-help">No mappings yet. Add the exact category values supplied by your site.</p>:null}
        <div className="contextual-signals-mappings">{draft.mappings.map((row,index)=><article className="contextual-signals-mapping" key={index}>
          <div className="contextual-signals-row-heading"><strong>Mapping {index+1}</strong><button type="button" className="button secondary" onClick={()=>change({mappings:draft.mappings.filter((_,i)=>i!==index)})}>Remove mapping {index+1}</button></div>
          <label className="contextual-signals-field"><span>Page category value</span><input aria-label={`Page category ${index+1}`} value={row.value} onChange={event=>changeRow(index,{value:event.target.value})} placeholder="e.g. Sport" autoComplete="off"/></label>
          <div className="contextual-signals-id-fields">
            <label className="contextual-signals-field"><span>IAB Content 2.2 IDs · Google and selected SSPs</span><input aria-label={`Content 2.2 IDs for mapping ${index+1}`} list={`contextual-${publisherId}-iab-content-2.2`} value={row.ids22} onChange={event=>changeRow(index,{ids22:event.target.value})} placeholder="e.g. 483" autoComplete="off"/><small>{selectedLabels(row.ids22,'iab-content-2.2')||'Choose IDs from Content 2.2.'}</small></label>
            <label className="contextual-signals-field"><span>IAB Content 3.0 IDs · selected SSPs only</span><input aria-label={`Content 3.0 IDs for mapping ${index+1}`} list={`contextual-${publisherId}-iab-content-3.0`} value={row.ids30} onChange={event=>changeRow(index,{ids30:event.target.value})} placeholder="Select from Content 3.0" autoComplete="off"/><small>{selectedLabels(row.ids30,'iab-content-3.0')||'Choose IDs independently from Content 3.0.'}</small></label>
          </div>
        </article>)}</div>
        <button type="button" className="button secondary" onClick={()=>change({mappings:[...draft.mappings,{value:'',ids22:'',ids30:''}]})}>Add category mapping</button>
      </fieldset>
      {error||message?<div ref={saveFeedback} className="contextual-signals-feedback">
        {error?<><div className="form-error config-error" role="alert">{error}</div><p className="contextual-signals-help">Your edits are kept. Reloading replaces them with the saved settings.</p><button className="button secondary" disabled={saving} type="button" onClick={()=>setReload(value=>value+1)}>Reload saved settings</button></>:null}
        {message?<p className="prebid-mode-message" role="status">{message}</p>:null}
      </div>:null}
      <div className="contextual-signals-actions"><button type="button" className="button primary" disabled={saving||!dirty} onClick={()=>void save()}>{saving?'Saving…':'Save contextual signals'}</button><button type="button" className="button secondary" disabled={saving||!dirty} onClick={()=>{setDraft(draftFor(data.settings));setError('');setMessage('');}}>Reset changes</button></div>
      <p className="contextual-signals-help">This configures page context only. It does not collect user interests or identifiers. Saving does not publish a script or change consent handling.</p>
    </>:null}
  </section>;
}
