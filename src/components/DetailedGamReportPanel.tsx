import {useEffect,useId,useRef,useState} from 'react';
import {GAM_REPORT_V2_CSV_LIMIT,GAM_REPORT_V2_DIMENSIONS,GAM_REPORT_V2_METRICS,GAM_REPORT_V2_PURPOSES,gamReportV2Columns} from '../../worker/experiments/gam-report-v2-contracts.mjs';
import type {GamReportV2Created,GamReportV2Detail,GamReportV2Dimension,GamReportV2Input,GamReportV2Listing,GamReportV2Metric,GamReportV2Preview,GamReportV2Purpose,GamReportV2Totals} from '../../worker/experiments/gam-report-v2-contracts.mjs';
import './detailed-gam-report.css';

type Props={endpoint:string;experimentId:string;versionId:string;identityKey?:'TestId'|'VersionId';disabled?:boolean};
type Action=''|'save'|'template'|'file'|'review';
type Notice={text:string;error:boolean};
const empty:GamReportV2Input={networkCode:'',inventoryPath:'',startDate:'',endDate:'',currency:'',timeZone:'UTC',revenueBasis:'unknown',revenueMetric:'total',purpose:'overall',metricFamily:'total',scope:{orderIds:[],lineItemIds:[]},dimensions:['adUnit','deviceCategory'],metrics:['impressions','revenue','clicks','measurableImpressions','viewableImpressions'],sourceColumns:{},compatibilityMode:'unknown'};
const requestMetrics:readonly GamReportV2Metric[]=['adRequests','responsesServed','unfilledImpressions'];
const deliveryDimensions:readonly GamReportV2Dimension[]=['orderId','lineItemId','creativeId'];
const presets:Record<GamReportV2Purpose,{dimensions:GamReportV2Dimension[];metrics:GamReportV2Metric[];metricFamily:GamReportV2Input['metricFamily']}>={
  overall:{dimensions:['adUnit','deviceCategory'],metrics:['impressions','revenue','clicks','measurableImpressions','viewableImpressions'],metricFamily:'total'},
  prebid:{dimensions:['adUnit','lineItemId','aq_bid_origin'],metrics:['impressions','revenue','clicks','measurableImpressions','viewableImpressions'],metricFamily:'ad-server'},
  refresh:{dimensions:['adUnit','refresh_bucket','aq_bid_origin'],metrics:['impressions','revenue','measurableImpressions','viewableImpressions'],metricFamily:'total'},
  startup:{dimensions:['deviceCategory','aq_first_request','aq_consent_wait'],metrics:['impressions','revenue'],metricFamily:'total'},
  inventory:{dimensions:['adUnit','deviceCategory','requestedAdSizes'],metrics:['adRequests','responsesServed','unfilledImpressions'],metricFamily:'total'},
};
const purposeLabel=(key:GamReportV2Purpose)=>GAM_REPORT_V2_PURPOSES.find(item=>item.key===key)?.label??key;
const dimLabel=(key:GamReportV2Dimension)=>GAM_REPORT_V2_DIMENSIONS.find(item=>item.key===key)?.label??key;
const familyLabel=(key:GamReportV2Input['metricFamily'])=>key==='total'?'Total — all demand':'Ad server';
const number=(value:number|null)=>value===null?'Not available':value.toLocaleString('en-US',{maximumFractionDigits:4});
const ids=(text:string)=>[...new Set(text.split(/[\s,;]+/).filter(Boolean))];
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
function withColumns(report:GamReportV2Input):GamReportV2Input{
  return {...report,sourceColumns:Object.fromEntries(gamReportV2Columns(report).map(key=>[key,report.sourceColumns[key]??key]))};
}
async function problem(response:Response,fallback:string){
  try{return new Error(((await response.json()) as {error?:string}).error||fallback);}catch{return new Error(fallback);}
}
function download(value:BlobPart,type:string,name:string){
  const url=URL.createObjectURL(new Blob([value],{type})),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
function MetricCell({totals,metric}:{totals:GamReportV2Totals;metric:GamReportV2Metric}){
  const value=metric==='revenue'?totals.revenue:number(totals[metric]),coverage=totals.metricCoverage[metric];
  return <>{value??'Not available'}{coverage?.missing?<small>Incomplete: {coverage.missing} of {coverage.provided+coverage.missing} rows missing</small>:null}</>;
}
function TotalsTable({A,B,metrics,caption,currency}:{A:GamReportV2Totals;B:GamReportV2Totals;metrics:GamReportV2Metric[];caption:string;currency:string}){
  const rates:[string,number|null,number|null][]=[
    [`Revenue per 1,000 impressions (${currency})`,A.revenuePerThousandImpressions,B.revenuePerThousandImpressions],
    ['Click-through rate (%)',A.clickThroughRatePercent,B.clickThroughRatePercent],
    ['Response rate (%)',A.responseRatePercent,B.responseRatePercent],
    ['Viewability (%)',A.viewabilityPercent,B.viewabilityPercent],
    ['Measurability (%)',A.measurabilityPercent,B.measurabilityPercent],
  ];
  return <div className="detailed-gam-report-table"><table><caption>{caption}</caption><thead><tr><th scope="col">Metric</th><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody>
    <tr><th scope="row">Imported rows</th><td>{number(A.rowCount)}</td><td>{number(B.rowCount)}</td></tr>
    {GAM_REPORT_V2_METRICS.filter(item=>metrics.includes(item.key)).map(item=><tr key={item.key}><th scope="row">{item.label}{item.key==='revenue'?` (${currency})`:''}</th><td><MetricCell totals={A} metric={item.key}/></td><td><MetricCell totals={B} metric={item.key}/></td></tr>)}
    {rates.filter(([,a,b])=>a!==null||b!==null).map(([name,a,b])=><tr key={name}><th scope="row">{name}</th><td>{number(a)}</td><td>{number(b)}</td></tr>)}
  </tbody></table></div>;
}

/** Immutable report setup and in-memory review. The caller keys this component by site/package endpoint. */
export default function DetailedGamReportPanel({endpoint,experimentId,versionId,identityKey,disabled=false}:Props){
  const prefix=useId(),active=useRef(true),initialized=useRef(false),operation=useRef<Action>('');
  const listTicket=useRef(0),detailTicket=useRef(0),reviewTicket=useRef(0),fileTicket=useRef(0);
  const noticeRef=useRef<HTMLParagraphElement>(null),resultRef=useRef<HTMLElement>(null),errorRef=useRef<HTMLParagraphElement>(null),fileRef=useRef<HTMLInputElement>(null);
  const [listing,setListing]=useState<GamReportV2Listing|null>(null),[listError,setListError]=useState(''),[listLoading,setListLoading]=useState(false),[reload,setReload]=useState(0);
  const [report,setReport]=useState<GamReportV2Input>(()=>withColumns({...empty})),[orders,setOrders]=useState(''),[lineItems,setLineItems]=useState('');
  const [selected,setSelected]=useState(''),[detail,setDetail]=useState<GamReportV2Detail|null>(null),[detailError,setDetailError]=useState(''),[detailAttempt,setDetailAttempt]=useState(0);
  const [busy,setBusy]=useState<Action>(''),[notice,setNotice]=useState<Notice|null>(null),[csv,setCsv]=useState(''),[fileName,setFileName]=useState('');
  const [preview,setPreview]=useState<GamReportV2Preview|null>(null),[previewError,setPreviewError]=useState(''),[breakdown,setBreakdown]=useState<GamReportV2Dimension|''>('');
  const field=(name:string)=>prefix+'-'+name;
  useEffect(()=>{active.current=true;return()=>{active.current=false;listTicket.current++;detailTicket.current++;reviewTicket.current++;fileTicket.current++;};},[]);
  useEffect(()=>{if(!busy&&notice)noticeRef.current?.focus();},[busy,notice]);
  useEffect(()=>{if(!busy){if(previewError)errorRef.current?.focus();else if(preview)resultRef.current?.focus();}},[busy,previewError,preview]);
  async function request(path='',body?:unknown){
    return fetch(endpoint+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  }
  function clearReview(){reviewTicket.current++;setPreview(null);setPreviewError('');setBreakdown('');}
  function clearInput(){fileTicket.current++;clearReview();setCsv('');setFileName('');if(fileRef.current)fileRef.current.value='';}
  function choose(id:string){
    if(id===selected){if(!detail)setDetailAttempt(value=>value+1);return;}
    detailTicket.current++;clearInput();setDetail(null);setDetailError('');setNotice(null);setSelected(id);
  }
  async function load(preferred?:string){
    const ticket=++listTicket.current;setListLoading(true);
    try{
      const response=await request();if(!response.ok)throw await problem(response,'Could not load detailed reports. Retry.');
      const next=await response.json() as GamReportV2Listing;
      if(!active.current||ticket!==listTicket.current)return;
      if(next.plans.some(plan=>plan.versionId!==versionId))throw new Error('The report list belongs to another version. Reload it.');
      setListing(next);setListError('');
      if(!initialized.current){
        initialized.current=true;
        setReport(withColumns({...empty,...next.defaults,networkCode:next.defaults.networkCode??'',inventoryPath:next.defaults.inventoryPath??'',startDate:'',endDate:'',currency:'',...presets.overall,purpose:'overall'}));
      }
      setSelected(current=>next.plans.some(plan=>plan.id===(preferred??current))?preferred??current:next.plans[0]?.id??'');
    }catch(error){if(active.current&&ticket===listTicket.current){clearReview();setListError(error instanceof Error?error.message:'Could not load detailed reports. Retry.');}}
    finally{if(active.current&&ticket===listTicket.current)setListLoading(false);}
  }
  useEffect(()=>{void load();},[endpoint,reload]);
  useEffect(()=>{
    const ticket=++detailTicket.current;setDetail(null);setDetailError('');clearInput();
    if(!selected)return;
    void(async()=>{
      try{
        const response=await request('/'+selected);if(!response.ok)throw await problem(response,'Could not read the selected detailed report. Retry.');
        const next=await response.json() as GamReportV2Detail;
        if(next.plan.id!==selected||next.plan.experimentId!==experimentId||next.plan.versionId!==versionId)throw new Error('This report belongs to another version. Reload the reports.');
        if(active.current&&ticket===detailTicket.current)setDetail(next);
      }catch(error){if(active.current&&ticket===detailTicket.current)setDetailError(error instanceof Error?error.message:'Could not read the detailed report. Retry.');}
    })();
  },[selected,detailAttempt]);
  const locked=disabled||busy!==''||listLoading;
  const idsAllowed=report.purpose!=='overall'&&report.purpose!=='inventory';
  const scope={orderIds:ids(orders),lineItemIds:ids(lineItems)};
  const scoped=scope.orderIds.length>0||scope.lineItemIds.length>0;
  const columns=gamReportV2Columns(report);
  const mappingError=columns.some(key=>!report.sourceColumns[key]?.trim())?'Each selected column needs an exact source header.':new Set(columns.map(key=>report.sourceColumns[key])).size!==columns.length?'Source headers must be unique.':'';
  const scopeError=[...scope.orderIds,...scope.lineItemIds].some(id=>!/^[1-9]\d*$/.test(id))?'Use positive numeric IDs separated by commas, spaces or new lines.':report.purpose==='prebid'&&!scoped?'Prebid delivery needs at least one order ID or line-item ID.':'';
  const combinationError=(scoped||report.dimensions.some(key=>deliveryDimensions.includes(key)))&&report.metrics.some(key=>requestMetrics.includes(key))?'Request metrics need a separate inventory report without delivery filters or delivery dimensions.':report.dimensions.includes('creativeSize')&&report.metrics.includes('unfilledImpressions')?'Use Requested ad sizes with unfilled impressions, rather than Creative size.':report.purpose==='overall'&&(!report.metrics.includes('impressions')||!report.metrics.includes('revenue'))?'Overall results require impressions and revenue.':!report.metrics.length?'Select at least one raw metric.':'';
  const canSave=Boolean(listing&&!listing.sourceError&&report.networkCode.trim()&&report.inventoryPath.trim()&&report.startDate&&report.endDate&&/^[A-Z]{3}$/.test(report.currency)&&report.timeZone.trim()&&!mappingError&&!scopeError&&!combinationError);
  async function run(action:Action,work:()=>Promise<string|void>){
    if(operation.current||disabled)return;operation.current=action;setBusy(action);setNotice(null);
    try{const text=await work();if(active.current&&text)setNotice({text,error:false});}
    catch(error){if(active.current)setNotice({text:error instanceof Error?error.message:'The detailed report action failed. Retry.',error:true});}
    finally{operation.current='';if(active.current)setBusy('');}
  }
  function edit<K extends keyof GamReportV2Input>(key:K,value:GamReportV2Input[K]){clearReview();setNotice(null);setReport(current=>({...current,[key]:value}));}
  function purpose(value:GamReportV2Purpose){
    clearReview();setNotice(null);
    if(value==='overall'||value==='inventory'){setOrders('');setLineItems('');}
    setReport(current=>withColumns({...current,...presets[value],purpose:value,scope:{orderIds:[],lineItemIds:[]}}));
  }
  function dimension(key:GamReportV2Dimension,checked:boolean){
    clearReview();setNotice(null);setReport(current=>withColumns({...current,dimensions:GAM_REPORT_V2_DIMENSIONS.map(item=>item.key).filter(value=>value===key?checked:current.dimensions.includes(value))}));
  }
  function metric(key:GamReportV2Metric,checked:boolean){
    const pair:GamReportV2Metric[]=key==='adRequests'||key==='responsesServed'?['adRequests','responsesServed']:key==='measurableImpressions'||key==='viewableImpressions'?['measurableImpressions','viewableImpressions']:[key];
    clearReview();setNotice(null);setReport(current=>withColumns({...current,metrics:GAM_REPORT_V2_METRICS.map(item=>item.key).filter(value=>pair.includes(value)?checked:current.metrics.includes(value))}));
  }
  function scopeText(kind:'orders'|'lineItems',value:string){
    clearReview();setNotice(null);if(kind==='orders')setOrders(value);else setLineItems(value);
    const required:GamReportV2Dimension=kind==='orders'?'orderId':'lineItemId';
    if(ids(value).length)setReport(current=>withColumns({...current,dimensions:GAM_REPORT_V2_DIMENSIONS.map(item=>item.key).filter(key=>key===required||current.dimensions.includes(key))}));
  }
  async function save(){
    const input=withColumns({...report,scope});
    const response=await request('',input);if(!response.ok)throw await problem(response,'The detailed report save is unconfirmed. Retry with the same fields.');
    const saved=await response.json() as GamReportV2Created;
    if(saved.plan.experimentId!==experimentId||saved.plan.versionId!==versionId)throw new Error('The save response belongs to another version. Reload reports before retrying.');
    if(!active.current)return;
    await load(saved.plan.id);
    return saved.created?'Detailed report saved. Its filters and column mapping are fixed. Download its template and review the matching GAM CSV.':'This detailed report is already saved. The existing report is selected.';
  }
  async function template(){
    if(!detail)return;const response=await request('/'+detail.plan.id+'/template.csv');if(!response.ok)throw await problem(response,'Could not download the detailed CSV template. Retry.');
    const bytes=await response.arrayBuffer();if(!active.current)return;download(bytes,'text/csv',`gam-detailed-template-${versionId}-${detail.plan.id.slice(-8)}.csv`);
    return 'Detailed CSV template downloaded. It uses this saved report’s exact headers.';
  }
  async function file(file:File){
    clearInput();const ticket=++fileTicket.current;
    if(file.size>GAM_REPORT_V2_CSV_LIMIT)throw new Error('Detailed CSV must be at most 1 MB. Export a smaller period or fewer dimensions.');
    let value:string;try{value=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw new Error('Use a UTF-8 CSV file.');}
    if(!active.current||ticket!==fileTicket.current)return;setCsv(value);setFileName(file.name);return 'CSV loaded. Review it to validate the rows and declared scope.';
  }
  async function review(){
    clearReview();if(!detail)return;
    if(new TextEncoder().encode(csv).length>GAM_REPORT_V2_CSV_LIMIT)throw new Error('Detailed CSV must be at most 1 MB. Reduce the input before reviewing.');
    const ticket=++reviewTicket.current,plan=detail.plan;
    try{
      const response=await request('/'+plan.id+'/preview',{csv});if(!response.ok)throw await problem(response,'The detailed CSV could not be reviewed. Correct it and retry.');
      const next=await response.json() as GamReportV2Preview;
      if(next.planId!==plan.id||next.experimentId!==experimentId||next.versionId!==versionId||next.identityKey!==plan.identityKey||next.period.startDate!==plan.report.startDate||next.period.endDate!==plan.report.endDate||next.period.timeZone!==plan.report.timeZone||next.source.currency!==plan.report.currency||next.source.revenueBasis!==plan.report.revenueBasis||next.source.revenueMetric!==plan.report.revenueMetric||next.source.purpose!==plan.report.purpose||next.source.metricFamily!==plan.report.metricFamily||!same(next.source.scope,plan.report.scope)||!same(next.source.dimensions,plan.report.dimensions)||!same(next.source.metrics,plan.report.metrics)||!same(next.source.sourceColumns,plan.report.sourceColumns)||next.source.compatibilityMode!==plan.report.compatibilityMode)
        throw new Error('The review does not match this saved report’s version, scope or columns. Reload the report and retry.');
      if(active.current&&ticket===reviewTicket.current){setPreview(next);setBreakdown(next.breakdowns[0]?.dimension??'');}
    }catch(error){if(active.current&&ticket===reviewTicket.current)setPreviewError(error instanceof Error?error.message:'The detailed CSV could not be reviewed. Retry.');}
  }
  function example(){
    const headers=['date','VersionId','Variant','adUnit','deviceCategory','impressions','revenue','clicks','measurableImpressions','viewableImpressions'];
    const rows=[headers.join(','),'2026-11-22,example_version_01,A,Example slot,mobile,1000,1.500000,2,800,520','2026-11-22,example_version_01,B,Example slot,mobile,1000,1.520000,2,800,528'];
    download(rows.join('\r\n')+'\r\n','text/csv','gam-detailed-example-FICTITIOUS-DATA.csv');setNotice({text:'Fictitious example downloaded. Its Version ID and numbers are not live data; use your saved report template for a real import.',error:false});
  }
  const selectedReport=detail?.plan.report,selectedBreakdown=preview?.breakdowns.find(item=>item.dimension===breakdown);
  const progress=busy==='save'?'Saving detailed report…':busy==='template'?'Downloading detailed CSV template…':busy==='file'?'Reading detailed CSV…':busy==='review'?'Reviewing detailed GAM CSV…':'';
  const knownIdentityKey=detail?.plan.identityKey??identityKey;
  return <section className="detailed-gam-report" aria-label="Measurement and GAM report">
    <h5>Prepare a detailed GAM report</h5>
    <p>Choose the report’s purpose, exact filters, dimensions and raw metrics. A saved setup keeps its scope fixed; it does not change GAM or publish scripts.</p>
    <p>Version ID <code>{versionId}</code>{knownIdentityKey?<> · GAM key <code>{knownIdentityKey}</code>.</>:'. The saved report confirms the GAM key used by this package.'} Both A and B belong to this package version.</p>
    <p className="ab-tests-note">Filters are your declaration of the GAM export. The file does not authenticate its source. Page RPM, uplift and a winner remain unavailable.</p>
    <button type="button" disabled={locked} onClick={example}>Download fictitious detailed CSV example</button>
    {listError?<p role="alert" className="runtime-error">{listError} <button type="button" disabled={locked} onClick={()=>setReload(value=>value+1)}>Reload detailed reports</button></p>:!listing?<p role="status">Loading detailed reports…</p>:<>
      <label htmlFor={field('saved')}>Saved detailed report</label>
      <select id={field('saved')} value={selected} disabled={locked||!listing.plans.length} onChange={event=>choose(event.target.value)}>
        <option value="">Choose a detailed report</option>
        {listing.plans.map(item=><option key={item.id} value={item.id}>{purposeLabel(item.report.purpose)} · {item.report.startDate} – {item.report.endDate} · {item.report.currency} · {item.id.slice(-8)}</option>)}
      </select>
      <button type="button" disabled={locked} onClick={()=>setReload(value=>value+1)}>Reload detailed reports</button>
      {listLoading?<p role="status">Reloading detailed reports…</p>:null}
      {!listing.plans.length?<p>No detailed reports saved yet. Prepare the setup below.</p>:null}
      <details className="detailed-gam-report-form" open={listing.plans.length===0}>
        <summary>New detailed report</summary>
        <p>Changing the purpose applies a starting selection of fields. Saving these fields creates a separate immutable report setup.</p>
        {listing.sourceError?<p role="alert" className="runtime-error">New report setups are unavailable: {listing.sourceError} Existing reports can still be opened.</p>:null}
        <form onSubmit={event=>{event.preventDefault();if(canSave)void run('save',save);}}>
          <fieldset disabled={locked||Boolean(listing.sourceError)}><legend>1. Purpose and scope</legend>
            <div className="detailed-gam-report-grid">
              <div><label htmlFor={field('purpose')}>Report purpose</label><select id={field('purpose')} value={report.purpose} onChange={event=>purpose(event.target.value as GamReportV2Purpose)}>{GAM_REPORT_V2_PURPOSES.map(item=><option key={item.key} value={item.key}>{item.label}</option>)}</select></div>
              <div><label htmlFor={field('family')}>Metric family</label><select id={field('family')} value={report.metricFamily} disabled={report.purpose==='overall'||report.purpose==='inventory'||report.purpose==='prebid'} onChange={event=>edit('metricFamily',event.target.value as GamReportV2Input['metricFamily'])}><option value="total">Total — all demand</option><option value="ad-server">Ad server</option></select></div>
              <div><label htmlFor={field('orders')}>Prebid order IDs</label><input id={field('orders')} value={orders} disabled={!idsAllowed} onChange={event=>scopeText('orders',event.target.value)} placeholder="For example: 123456, 123457" autoComplete="off"/></div>
              <div><label htmlFor={field('line-items')}>Prebid line-item IDs</label><input id={field('line-items')} value={lineItems} disabled={!idsAllowed} onChange={event=>scopeText('lineItems',event.target.value)} placeholder="For example: 234567, 234568" autoComplete="off"/></div>
            </div>
            <p className="ab-tests-help">Overall and inventory reports include all demand. Prebid delivery needs your exact Prebid IDs, rather than all Price Priority items. If both lists are supplied, a row must match both. ID filters automatically add the matching ID dimension.</p>
            {report.purpose==='prebid'?<p className="ab-tests-note">Ad server revenue can reflect the line item’s price bucket. Reconcile settled net revenue against SSP reports. Primary bid origin and bidder labels do not by themselves identify the creative that served.</p>:null}
            {report.purpose==='startup'?<p className="ab-tests-note">First-request and CMP buckets persist on later requests. Their GAM distributions count requests or impressions, not unique pages or precise render latency.</p>:null}
            <div className="detailed-gam-report-grid">
              <div><label htmlFor={field('network')}>GAM network code</label><input id={field('network')} required value={report.networkCode} onChange={event=>edit('networkCode',event.target.value)} autoComplete="off"/></div>
              <div><label htmlFor={field('inventory')}>Inventory path</label><input id={field('inventory')} required value={report.inventoryPath} onChange={event=>edit('inventoryPath',event.target.value)} autoComplete="off"/></div>
              <div><label htmlFor={field('start')}>Report start date</label><input id={field('start')} type="date" required value={report.startDate} onChange={event=>edit('startDate',event.target.value)}/></div>
              <div><label htmlFor={field('end')}>Report end date</label><input id={field('end')} type="date" required value={report.endDate} onChange={event=>edit('endDate',event.target.value)}/></div>
              <div><label htmlFor={field('currency')}>Report currency</label><input id={field('currency')} required maxLength={3} pattern="[A-Z]{3}" value={report.currency} placeholder="For example: EUR" onChange={event=>edit('currency',event.target.value.toUpperCase())} autoComplete="off"/></div>
              <div><label htmlFor={field('timezone')}>GAM report time zone</label><input id={field('timezone')} required value={report.timeZone} onChange={event=>edit('timeZone',event.target.value)} placeholder="For example: Europe/Belgrade" autoComplete="off"/></div>
              <div><label htmlFor={field('basis')}>Revenue basis</label><select id={field('basis')} value={report.revenueBasis} onChange={event=>edit('revenueBasis',event.target.value as GamReportV2Input['revenueBasis'])}><option value="unknown">Unknown</option><option value="gross">Gross</option><option value="net">Net</option></select></div>
              <div><label htmlFor={field('revenue')}>Revenue metric</label><select id={field('revenue')} value={report.revenueMetric} onChange={event=>edit('revenueMetric',event.target.value as GamReportV2Input['revenueMetric'])}><option value="total">{report.metricFamily==='total'?'Total revenue':'Ad server total revenue'}</option><option value="cpm-cpc">{report.metricFamily==='total'?'Total CPM and CPC revenue':'Ad server CPM and CPC revenue'}</option></select></div>
              <div><label htmlFor={field('compatibility')}>GAM compatibility setting</label><select id={field('compatibility')} value={report.compatibilityMode} onChange={event=>edit('compatibilityMode',event.target.value as GamReportV2Input['compatibilityMode'])}><option value="unknown">Unknown</option><option value="off">Access more dimension and metric combinations: off</option><option value="on">Access more dimension and metric combinations: on</option></select></div>
            </div>
            <p className="ab-tests-help">Use the exported report’s actual currency, time zone, revenue metric and gross/net basis, and complete days. Metric availability depends on your GAM network. This form does not enable paid features or compatibility settings.</p>
          </fieldset>
          <fieldset disabled={locked||Boolean(listing.sourceError)}><legend>2. Dimensions</legend>
            <p>Date, Version ID and Variant A/B are always included. Select only the additional breakdowns present together in each export row.</p>
            <div className="detailed-gam-report-choices">{GAM_REPORT_V2_DIMENSIONS.map(item=>{
              const forced=item.key==='orderId'&&scope.orderIds.length>0||item.key==='lineItemId'&&scope.lineItemIds.length>0;
              const incompatible=deliveryDimensions.includes(item.key)&&report.metrics.some(key=>requestMetrics.includes(key))||item.key==='creativeSize'&&report.metrics.includes('unfilledImpressions');
              return <label className="detailed-gam-report-choice" key={item.key}><input type="checkbox" checked={report.dimensions.includes(item.key)} disabled={forced||incompatible&&!report.dimensions.includes(item.key)} onChange={event=>dimension(item.key,event.target.checked)}/><span>{item.label}<small><code>{item.key}</code>{item.help?' · '+item.help:''}{forced?' · Required by the ID filter.':''}{incompatible?' · Use a separate delivery report with these request metrics.':''}</small></span></label>;
            })}</div>
          </fieldset>
          <fieldset disabled={locked||Boolean(listing.sourceError)}><legend>3. Raw metrics</legend>
            <p>Use counts and revenue from the same metric family. Rates are calculated from summed counts; unavailable cells remain unknown.</p>
            <div className="detailed-gam-report-choices">{GAM_REPORT_V2_METRICS.map(item=>{
              const incompatible=requestMetrics.includes(item.key)&&(scoped||report.dimensions.some(key=>deliveryDimensions.includes(key)))||item.key==='unfilledImpressions'&&report.dimensions.includes('creativeSize');
              return <label className="detailed-gam-report-choice" key={item.key}><input type="checkbox" checked={report.metrics.includes(item.key)} disabled={incompatible&&!report.metrics.includes(item.key)} onChange={event=>metric(item.key,event.target.checked)}/><span>{item.label}<small>{item.help??`${report.metricFamily==='total'?'Total':'Ad server'} metric family.`}{incompatible?' · Requires a separate inventory report.':''}</small></span></label>;
            })}</div>
            <p className="ab-tests-help">Ad requests and responses served are selected together, as are measurable and viewable impressions. Selecting a metric does not mean GAM supplies it for this report.</p>
          </fieldset>
          <details><summary>4. CSV column mapping · {columns.length} columns</summary>
            <p>Default headers use the normalized names below. To use another export header, enter it exactly. Unknown or duplicate headers, totals, preambles and overlapping raw Key-values rows are rejected.</p>
            <div className="detailed-gam-report-mapping">{columns.map(key=><div key={key} style={{display:'contents'}}><label htmlFor={field('column-'+key)}>CSV header for {key}</label><input id={field('column-'+key)} value={report.sourceColumns[key]??key} disabled={locked} maxLength={120} onChange={event=>edit('sourceColumns',{...report.sourceColumns,[key]:event.target.value})}/></div>)}</div>
          </details>
          {scopeError||mappingError||combinationError?<p className="ab-tests-help">{scopeError||mappingError||combinationError}</p>:null}
          <button type="submit" disabled={locked||!canSave}>Save detailed report</button>
        </form>
      </details>
      {selected&&!detail&&!detailError?<p role="status">Reading selected detailed report…</p>:null}
      {detailError?<p role="alert" className="runtime-error">{detailError} <button type="button" disabled={locked} onClick={()=>setDetailAttempt(value=>value+1)}>Retry detailed report</button></p>:null}
      {detail&&selectedReport?<>
        <h5>Selected detailed report</h5>
        <dl className="detailed-gam-report-context">
          <div><dt>Version ID</dt><dd><code>{detail.plan.versionId}</code> · GAM key <code>{detail.plan.identityKey}</code></dd></div>
          <div><dt>Purpose / family</dt><dd>{purposeLabel(selectedReport.purpose)} · {familyLabel(selectedReport.metricFamily)}</dd></div>
          <div><dt>Inventory</dt><dd>{selectedReport.networkCode} · <code>{selectedReport.inventoryPath}</code></dd></div>
          <div><dt>Period</dt><dd>{selectedReport.startDate} – {selectedReport.endDate} · {selectedReport.timeZone}</dd></div>
          <div><dt>Revenue</dt><dd>{selectedReport.currency} · {selectedReport.revenueBasis} · {selectedReport.revenueMetric==='total'?'All supported revenue types':'CPM and CPC'}</dd></div>
          <div><dt>Declared order IDs</dt><dd>{selectedReport.scope.orderIds.join(', ')||'All orders in the inventory scope'}</dd></div>
          <div><dt>Declared line-item IDs</dt><dd>{selectedReport.scope.lineItemIds.join(', ')||'All line items in the inventory scope'}</dd></div>
          <div><dt>Dimensions</dt><dd>Date, Version ID, Variant{selectedReport.dimensions.length?', '+selectedReport.dimensions.map(dimLabel).join(', '):''}</dd></div>
        </dl>
        <details><summary>Detailed GAM export guidance</summary><ol>
          <li>Use this exact network, inventory, date range and declared filters. Filter the GAM key <code>{detail.plan.identityKey}={versionId}</code> and include both Variant A and B.</li>
          <li>Use supported Custom or Enhanced key dimensions to place the identity, Variant and selected labels together on each row. Reportable alone does not guarantee that combination. Never sum overlapping raw Key-values rows.</li>
          <li>Use this report’s metric family, currency and revenue basis. Export raw counts rather than percentages or average eCPM. Keep the original GAM export to verify its source.</li>
          <li>Use the saved source headers. Required columns are shown in the downloaded template. Leave unavailable metric cells blank; do not replace missing rows with zero.</li>
        </ol><p className="ab-tests-help"><code>{gamReportV2Columns(selectedReport).map(key=>selectedReport.sourceColumns[key]).join(',')}</code></p></details>
        <button type="button" disabled={locked} onClick={()=>void run('template',template)}>Download detailed CSV template</button>
        <h5>Review detailed GAM CSV</h5>
        <p>Up to 1 MB and 10,000 data rows. The file and preview are processed in memory and are not stored. Download the review to keep it.</p>
        <label htmlFor={field('file')}>Upload detailed GAM CSV</label><input ref={fileRef} id={field('file')} type="file" accept=".csv,text/csv" disabled={locked} onChange={event=>{const selectedFile=event.target.files?.[0];if(selectedFile)void run('file',()=>file(selectedFile));}}/>
        {fileName?<p className="ab-tests-help">Loaded file: {fileName}</p>:null}
        <label htmlFor={field('csv')}>Detailed GAM CSV</label><textarea id={field('csv')} rows={8} value={csv} disabled={locked} spellCheck={false} onChange={event=>{clearReview();setNotice(null);setFileName('');setCsv(event.target.value);}}/>
        <div className="runtime-actions"><button type="button" disabled={locked||!csv.trim()} onClick={()=>void run('review',review)}>Review detailed GAM CSV</button><button type="button" disabled={locked||(!csv&&!preview&&!previewError)} onClick={()=>{clearInput();setNotice({text:'Detailed report input and review cleared.',error:false});}}>Clear detailed report input</button></div>
        {previewError?<p ref={errorRef} tabIndex={-1} role="alert" className="runtime-error">{previewError}</p>:null}
      </>:null}
    </>}
    {progress?<p role="status">{progress}</p>:null}
    {notice?<p ref={noticeRef} tabIndex={-1} role={notice.error?'alert':'status'} className={notice.error?'runtime-error':'ab-tests-status'}>{notice.text}</p>:null}
    {preview?<section ref={resultRef} tabIndex={-1} className="detailed-gam-report-review" aria-label="Detailed GAM CSV review">
      <h5>Imported detailed GAM results</h5>
      <p>{preview.providedRows} imported rows · {purposeLabel(preview.source.purpose)} · {familyLabel(preview.source.metricFamily)}. These results describe the supplied export only.</p>
      <p className="ab-tests-note">The GAM source and full dimensional coverage remain unverified. Page RPM, uplift and a winner are unavailable. A larger subtotal or eCPM does not establish a better overall result.</p>
      <TotalsTable A={preview.totals.A} B={preview.totals.B} metrics={preview.source.metrics} currency={preview.source.currency} caption="Imported GAM totals by Variant"/>
      {preview.breakdowns.length?<><label htmlFor={field('breakdown')}>Break down by</label><select id={field('breakdown')} value={breakdown} onChange={event=>setBreakdown(event.target.value as GamReportV2Dimension)}>{preview.breakdowns.map(item=><option key={item.dimension} value={item.dimension}>{dimLabel(item.dimension)} · {item.groupCount} groups</option>)}</select>
        {selectedBreakdown?<><p>{selectedBreakdown.groupCount} groups. Each breakdown is an alternative view of the same imported rows; do not add different breakdowns together.</p>
          {selectedBreakdown.groups.map(group=><details key={group.value}><summary>{group.value||'(Not provided)'}</summary><TotalsTable A={group.A} B={group.B} metrics={preview.source.metrics} currency={preview.source.currency} caption={`${dimLabel(selectedBreakdown.dimension)}: ${group.value||'(Not provided)'}`}/></details>)}
          {selectedBreakdown.other?<details><summary>{selectedBreakdown.other.groupCount} other groups combined</summary><TotalsTable A={selectedBreakdown.other.A} B={selectedBreakdown.other.B} metrics={preview.source.metrics} currency={preview.source.currency} caption="Remaining groups combined"/></details>:null}
        </>:null}
      </>:<p>No additional dimensions were selected.</p>}
      <h5>Coverage and interpretation</h5>
      {preview.missingDays.length?<p>{preview.missingDays.length} missing daily A/B combinations. Missing rows are unknown, not zero. The downloaded review lists them.</p>:<p>Every daily A/B combination has at least one supplied row. This does not prove complete coverage of the selected dimensions.</p>}
      <ul>{preview.blockers.map(message=><li key={message}>{message}</li>)}</ul>
      <p className="ab-tests-help">Rates use summed raw counts. Partial metrics show as unavailable. Delivery filters cannot supply the denominator of all inventory requests.</p>
      <details><summary>Review identity and notes</summary><dl className="detailed-gam-report-context"><div><dt>Report ID</dt><dd><code>{preview.planId}</code></dd></div><div><dt>CSV SHA-256</dt><dd><code>{preview.source.csvSha256}</code></dd></div></dl><ul>{preview.notes.map(message=><li key={message}>{message}</li>)}</ul></details>
      <button type="button" disabled={locked} onClick={()=>{download(JSON.stringify(preview,null,2)+'\n','application/json',`gam-detailed-review-${versionId}-${preview.planId.slice(-8)}.json`);setNotice({text:'Detailed review JSON downloaded. The source CSV was not stored.',error:false});}}>Download detailed review JSON</button>
    </section>:null}
  </section>;
}
