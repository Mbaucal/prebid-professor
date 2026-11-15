import {useEffect,useRef,useState} from 'react';
import {evaluateBidderRule,normalizeBidderRules} from '../../shared/bidder-rules/settings.mjs';
import type {BidderRule,BidderRules,DeviceLayout} from '../../shared/bidder-rules/settings.mjs';
import {normalizeCountry} from '../../shared/geo-country.mjs';
import '../bidder-rules.css';

type Props={publisherId:string;onChanged?:()=>void|Promise<void>;endpoint?:string};
type Payload={revision:string;settings:BidderRules;bidders:{bidder:string;enabled:boolean;configured:boolean}[];positions:{code:string;enabled:boolean;configured:boolean}[];enablePrebid:boolean;runtimeEligible:boolean;published:false};
type RuleDraft=Omit<BidderRule,'countries'>&{scope:'all'|'selected';countries:Omit<BidderRule['countries'],'values'>&{codes:string}};
type Draft=Omit<BidderRules,'rules'>&{rules:RuleDraft[]};
const layouts:{id:DeviceLayout;label:string}[]=[{id:'mobile',label:'Mobile · below 768px'},{id:'tablet',label:'Tablet · 768–1023px'},{id:'desktop',label:'Desktop · 1024px and above'}];
const reasons:Record<string,string>={disabled:'Bidder rules are off.', 'no-rule':'No matching rule. Normal bidder setup applies.', 'layout-excluded':'This viewport layout is excluded.', 'layout-unknown':'Viewport width is unknown and the rule allows only selected layouts.', 'country-unknown-allowed':'Country is unknown; this rule allows it.', 'country-unknown-skipped':'Country is unknown; this rule skips it.', 'country-excluded':'This country is excluded.',allowed:'Country and viewport layout match.'};
function draftFor(settings:BidderRules):Draft{
  return {...structuredClone(settings),rules:settings.rules.map(rule=>({...structuredClone(rule),scope:rule.positions.length?'selected':'all',countries:{mode:rule.countries.mode,unknown:rule.countries.unknown,codes:rule.countries.values.join(', ')}}))};
}
function settingsFromDraft(draft:Draft):BidderRules{
  return {...draft,rules:draft.rules.map(({scope,countries,...rule})=>({...rule,positions:scope==='all'?[]:rule.positions,countries:{mode:countries.mode,unknown:countries.unknown,values:countries.mode==='all'?[]:countries.codes.split(/[\s,]+/).filter(Boolean)}}))};
}
function validated(draft:Draft):BidderRules{
  const empty=draft.rules.find(rule=>rule.scope==='selected'&&!rule.positions.length);
  if(empty)throw Error(`${empty.name||'Rule'}: select at least one position, or choose All positions.`);
  return normalizeBidderRules(settingsFromDraft(draft));
}

export default function BidderRulesPanel({publisherId,onChanged,endpoint}:Props){
  const [data,setData]=useState<Payload|null>(null),[draft,setDraft]=useState<Draft|null>(null);
  const [loading,setLoading]=useState(true),[saving,setSaving]=useState(false),[reload,setReload]=useState(0);
  const [error,setError]=useState(''),[message,setMessage]=useState('');
  const [simulation,setSimulation]=useState({bidder:'',code:'',country:'',width:'1024'});
  const alive=useRef(false),operation=useRef(0),savingRef=useRef(false),saveFeedback=useRef<HTMLDivElement>(null);
  const url=endpoint??`/api/publishers/${encodeURIComponent(publisherId)}/bidder-rules`;
  useEffect(()=>{if(error||message)saveFeedback.current?.scrollIntoView({block:'nearest'});},[error,message]);
  async function request(body?:unknown,signal?:AbortSignal):Promise<Payload>{
    const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',signal,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});
    const value=await response.json() as Payload&{error?:string};
    if(!response.ok)throw Error(value.error||'Could not load or save bidder rules.');
    return value;
  }
  useEffect(()=>{
    alive.current=true;const id=++operation.current,controller=new AbortController();
    savingRef.current=false;setSaving(false);setLoading(true);setError('');setMessage('');setData(null);setDraft(null);
    void request(undefined,controller.signal).then(value=>{
      if(alive.current&&id===operation.current){setData(value);setDraft(draftFor(value.settings));setSimulation({bidder:value.bidders[0]?.bidder??'',code:value.positions[0]?.code??'',country:'',width:'1024'});}
    }).catch(e=>{if(alive.current&&id===operation.current&&!controller.signal.aborted)setError((e as Error).message);})
      .finally(()=>{if(alive.current&&id===operation.current)setLoading(false);});
    return()=>{alive.current=false;controller.abort();};
  },[url,reload]);
  function change(update:Partial<Draft>){setDraft(value=>value?{...value,...update}:value);setMessage('');}
  function changeRule(id:string,update:Partial<RuleDraft>){if(draft)change({rules:draft.rules.map(rule=>rule.id===id?{...rule,...update}:rule)});}
  async function save(){
    if(!data||!draft||savingRef.current)return;
    savingRef.current=true;setSaving(true);setError('');setMessage('');const id=operation.current;
    try{
      const value=await request({revision:data.revision,settings:validated(draft)});
      if(!alive.current||id!==operation.current)return;
      setData(value);setDraft(draftFor(value.settings));setMessage('Saved. Generate a new script with version 3.22.0 or later to apply these rules. Existing scripts are unchanged.');
      try{await onChanged?.();}catch{/* A parent refresh does not undo the successful save. */}
    }catch(e){if(alive.current&&id===operation.current)setError((e as Error).message);}
    finally{if(id===operation.current){savingRef.current=false;if(alive.current)setSaving(false);}}
  }
  const dirty=Boolean(data&&draft&&JSON.stringify(draft)!==JSON.stringify(draftFor(data.settings)));
  const bidders=data?.bidders??[],positions=data?.positions??[];
  let preview:{allowed:boolean;message:string;rule:string|null;layout:string}|null=null,previewError='';
  if(draft&&data&&simulation.bidder&&simulation.code){
    try{
      const settings=validated(draft),country=simulation.country.trim()?normalizeCountry(simulation.country.trim().toUpperCase()):null;
      if(simulation.country.trim()&&!country)throw Error('Enter a supported two-letter country code, or leave it blank for unknown.');
      const width=simulation.width.trim()?Number(simulation.width):null;
      if(width!==null&&(!Number.isFinite(width)||width<=0))throw Error('Enter a viewport width greater than zero, or leave it blank for unknown.');
      const result=evaluateBidderRule(settings,{bidder:simulation.bidder,code:simulation.code,country,width});
      const bidder=bidders.find(item=>item.bidder===simulation.bidder),position=positions.find(item=>item.code===simulation.code);
      const inactive=!data.enablePrebid||!bidder?.configured||!bidder.enabled||!position?.configured||!position.enabled;
      preview={allowed:result.allowed&&!inactive,message:!data.enablePrebid?'Prebid is off for this site.':!bidder?.configured||!bidder.enabled?'This bidder is not configured or is disabled.':!position?.configured||!position.enabled?'This position is not configured or is disabled.':reasons[result.reason]??result.reason,rule:result.ruleName,layout:result.device};
    }catch(e){previewError=(e as Error).message;}
  }
  return <section className="bidder-rules-page" aria-labelledby="bidder-rules-heading" aria-busy={loading||saving}>
    <div className="config-toolbar"><div><span className="panel-kicker">Demand eligibility</span><h2 id="bidder-rules-heading">Bidder rules</h2><p>Choose where each bidder may receive requests. Google Ad Manager positions keep working when bidders are skipped.</p></div></div>
    {loading?<p role="status">Loading bidder rules…</p>:null}
    {error&&!draft?<div className="form-error config-error" role="alert">{error}</div>:null}
    {!loading&&error&&!draft?<button className="button secondary" type="button" onClick={()=>setReload(value=>value+1)}>Reload saved settings</button>:null}
    {!loading&&data&&draft?<>
      <fieldset className="bidder-rules-card" disabled={saving}>
        <legend>1. Enable rules</legend>
        <label className="check-row"><input type="checkbox" checked={draft.enabled} onChange={event=>change({enabled:event.target.checked})}/><span>Enable bidder rules for this site</span></label>
        <p className="bidder-rules-help">A bidder with no matching rule keeps its normal behavior. A rule for selected positions overrides that bidder’s All positions rule. Country and viewport layout must both match.</p>
        {!data.runtimeEligible?<p className="bidder-rules-note">You can save rules now. Select and save script version 3.22.0 or later before generating a package that uses them.</p>:null}
        {!data.enablePrebid?<p className="bidder-rules-note">Prebid is off. Rules remain saved and are not applied in a GAM-only package.</p>:null}
      </fieldset>
      <fieldset className="bidder-rules-card" disabled={saving}>
        <legend>2. Bidder rules</legend>
        {draft.rules.length===0?<p className="bidder-rules-help">No rules yet. Add a bidder and choose its eligible countries, positions and layouts.</p>:null}
        {draft.rules.map((rule,index)=>{
          const bidder=bidders.find(item=>item.bidder===rule.bidder),missingPositions=rule.positions.filter(code=>!positions.some(item=>item.code===code&&item.configured));
          return <article className="bidder-rule" key={rule.id} aria-label={`Rule ${index+1}`}>
            <div className="bidder-rules-row-heading"><h3>Rule {index+1}</h3><button type="button" className="button secondary" onClick={()=>change({rules:draft.rules.filter(item=>item.id!==rule.id)})}>Remove rule {index+1}</button></div>
            <label className="check-row"><input aria-label={`Enable rule ${index+1}`} type="checkbox" checked={rule.enabled} onChange={event=>changeRule(rule.id,{enabled:event.target.checked})}/><span>Use this rule</span></label>
            <div className="bidder-rules-columns">
              <label className="bidder-rules-field"><span>Rule name</span><input aria-label={`Rule ${index+1} name`} value={rule.name} maxLength={100} onChange={event=>changeRule(rule.id,{name:event.target.value})}/></label>
              <label className="bidder-rules-field"><span>Bidder or alias</span><select aria-label={`Bidder for rule ${index+1}`} value={rule.bidder} onChange={event=>changeRule(rule.id,{bidder:event.target.value})}>{bidders.map(item=><option key={item.bidder} value={item.bidder}>{item.bidder}{!item.configured?' · not configured':!item.enabled?' · disabled':''}</option>)}{!bidder?<option value={rule.bidder}>{rule.bidder} · not configured</option>:null}</select><small>Matches the exact configured bidder or alias code.</small></label>
            </div>
            {!bidder?.configured||!bidder.enabled?<p className="bidder-rules-note">This bidder is not configured or is disabled. The rule is kept; it does not activate a bidder.</p>:null}
            <label className="bidder-rules-field"><span>Positions</span><select aria-label={`Positions for rule ${index+1}`} value={rule.scope} onChange={event=>changeRule(rule.id,{scope:event.target.value as RuleDraft['scope']})}><option value="all">All positions</option><option value="selected">Selected positions</option></select></label>
            {rule.scope==='selected'?<fieldset className="bidder-rules-position-list"><legend>Choose positions for rule {index+1}</legend>{[...new Set([...positions.map(item=>item.code),...rule.positions])].map(code=>{
              const position=positions.find(item=>item.code===code);
              return <label className="check-row" key={code}><input type="checkbox" checked={rule.positions.includes(code)} onChange={event=>changeRule(rule.id,{positions:event.target.checked?[...rule.positions,code]:rule.positions.filter(value=>value!==code)})}/><span>{code}{!position?.configured?' · not configured':!position.enabled?' · disabled':''}</span></label>;
            })}{!positions.length&&!rule.positions.length?<p className="bidder-rules-help">Add an ad unit in Inventory first.</p>:null}</fieldset>:null}
            {missingPositions.length&&rule.scope==='selected'?<p className="bidder-rules-note">Some selected positions are no longer configured. Their names are kept so you can update the rule.</p>:null}
            <div className="bidder-rules-columns">
              <label className="bidder-rules-field"><span>Countries</span><select aria-label={`Country policy for rule ${index+1}`} value={rule.countries.mode} onChange={event=>changeRule(rule.id,{countries:{...rule.countries,mode:event.target.value as BidderRule['countries']['mode']}})}><option value="all">All countries</option><option value="include">Only these countries</option><option value="exclude">All except these countries</option></select></label>
              {rule.countries.mode!=='all'?<label className="bidder-rules-field"><span>Country codes</span><input aria-label={`Country codes for rule ${index+1}`} value={rule.countries.codes} onChange={event=>changeRule(rule.id,{countries:{...rule.countries,codes:event.target.value}})} placeholder="RS, BA, ME" autoComplete="off"/><small>Two-letter country codes, separated by commas.</small></label>:null}
            </div>
            {rule.countries.mode!=='all'?<label className="bidder-rules-field"><span>When country is unknown</span><select aria-label={`Unknown country for rule ${index+1}`} value={rule.countries.unknown} onChange={event=>changeRule(rule.id,{countries:{...rule.countries,unknown:event.target.value as BidderRule['countries']['unknown']}})}><option value="allow">Allow this bidder</option><option value="skip">Skip this bidder</option></select><small>Applies while country detection is pending or unavailable. A later country result takes effect on the next normal auction; it does not delay the page or trigger another auction.</small></label>:null}
            <fieldset className="bidder-rules-layouts"><legend>Viewport layouts for rule {index+1}</legend>{layouts.map(layout=><label className="check-row" key={layout.id}><input type="checkbox" checked={rule.devices.includes(layout.id)} onChange={event=>changeRule(rule.id,{devices:event.target.checked?[...rule.devices,layout.id]:rule.devices.filter(value=>value!==layout.id)})}/><span>{layout.label}</span></label>)}<p className="bidder-rules-help">Uses the browser viewport width at request time, not the device model.</p></fieldset>
          </article>;
        })}
        <button type="button" className="button secondary bidder-rules-add" disabled={!bidders.length||draft.rules.length>=200} onClick={()=>change({rules:[...draft.rules,{id:crypto.randomUUID(),name:`Rule ${draft.rules.length+1}`,enabled:true,bidder:bidders[0]?.bidder??'',positions:[],scope:'all',countries:{mode:'all',codes:'',unknown:'allow'},devices:['mobile','tablet','desktop']}]})}>Add bidder rule</button>
        {!bidders.length?<p className="bidder-rules-help">Configure a bidder in Demand → Bidders first.</p>:null}
      </fieldset>
      <fieldset className="bidder-rules-card" disabled={saving}>
        <legend>3. Preview a decision</legend>
        <p className="bidder-rules-help">Checks your current edits without sending requests. This previews eligibility only; normal slot, consent and auction checks still apply.</p>
        <div className="bidder-rules-columns">
          <label className="bidder-rules-field"><span>Bidder</span><select aria-label="Preview bidder" value={simulation.bidder} onChange={event=>setSimulation({...simulation,bidder:event.target.value})}><option value="">Choose bidder</option>{bidders.map(item=><option key={item.bidder} value={item.bidder}>{item.bidder}</option>)}</select></label>
          <label className="bidder-rules-field"><span>Position</span><select aria-label="Preview position" value={simulation.code} onChange={event=>setSimulation({...simulation,code:event.target.value})}><option value="">Choose position</option>{positions.map(item=><option key={item.code} value={item.code}>{item.code}</option>)}</select></label>
          <label className="bidder-rules-field"><span>Country</span><input aria-label="Preview country" value={simulation.country} maxLength={2} onChange={event=>setSimulation({...simulation,country:event.target.value})} placeholder="Unknown" autoComplete="off"/><small>Leave blank to test unknown country.</small></label>
          <label className="bidder-rules-field"><span>Viewport width (px)</span><input aria-label="Preview viewport width" value={simulation.width} inputMode="numeric" onChange={event=>setSimulation({...simulation,width:event.target.value})} placeholder="Unknown"/><small>Leave blank to test unknown viewport width.</small></label>
        </div>
        {previewError?<p className="bidder-rules-note" role="status">Preview unavailable: {previewError}</p>:preview?<div className={`bidder-rules-decision ${preview.allowed?'allowed':'skipped'}`} role="status" aria-label="Rule preview"><strong>{preview.allowed?'Eligible':'Skipped'}</strong><p>{preview.message}</p><small>{preview.rule?`Rule: ${preview.rule} · `:''}Layout: {preview.layout}</small></div>:<p className="bidder-rules-help">Choose a bidder and position to preview a decision.</p>}
      </fieldset>
      {error||message?<div ref={saveFeedback} className="bidder-rules-feedback">{error?<><div className="form-error config-error" role="alert">{error}</div><p className="bidder-rules-help">Your edits are kept. Reloading replaces them with the saved settings.</p><button className="button secondary" disabled={saving} type="button" onClick={()=>setReload(value=>value+1)}>Reload saved settings</button></>:null}{message?<p className="prebid-mode-message" role="status">{message}</p>:null}</div>:null}
      <div className="bidder-rules-actions"><button type="button" className="button primary" disabled={saving||!dirty} onClick={()=>void save()}>{saving?'Saving…':'Save bidder rules'}</button><button type="button" className="button secondary" disabled={saving||!dirty} onClick={()=>{setDraft(draftFor(data.settings));setError('');setMessage('');}}>Reset changes</button></div>
      <p className="bidder-rules-help">Saving does not publish a script, activate bidders or change consent handling.</p>
    </>:null}
  </section>;
}
