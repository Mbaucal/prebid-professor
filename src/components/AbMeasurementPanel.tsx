import {useEffect,useId,useRef,useState} from 'react';
import {AB_GAM_COLUMNS,AB_GAM_CSV_LIMIT} from '../../worker/experiments/ab-measurement-contracts.mjs';
import type {GamReportPreview,MeasurementPlanDetail,MeasurementPlanListing,MeasurementReport} from '../../worker/experiments/ab-measurement-contracts.mjs';
import DetailedGamReportPanel from './DetailedGamReportPanel';
import './ab-measurement.css';

type Props={endpoint:string;experimentId:string;testId:string;identityKey?:'TestId'|'VersionId';disabled?:boolean;expanded?:boolean};
type Action='plan'|'template'|'upload'|'preview'|'';
const emptyReport:MeasurementReport={networkCode:'',inventoryPath:'',startDate:'',endDate:'',currency:'',timeZone:'UTC',revenueBasis:'unknown',revenueMetric:'total'};
const basis=(value:MeasurementReport['revenueBasis'])=>value==='unknown'?'Unknown':value==='gross'?'Gross':'Net';
const metric=(value:MeasurementReport['revenueMetric'])=>value==='total'?'Total revenue':'Total CPM and CPC revenue';
const count=(value:number|null)=>value===null?'Not provided':value.toLocaleString('en-US');
const rate=(value:number|null)=>value===null?'Not available':value.toLocaleString('en-US',{maximumFractionDigits:4});
async function problem(response:Response,fallback:string){
  try{return new Error(((await response.json()) as {error?:string}).error||fallback);}catch{return new Error(fallback);}
}
function download(bytes:BlobPart,type:string,name:string){
  const url=URL.createObjectURL(new Blob([bytes],{type})),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}

/** Each saved experiment has its own lazily opened report view. CSV and review results live only in React memory. */
export default function AbMeasurementPanel(props:Props){
  const [opened,setOpened]=useState(false);
  if(props.expanded)return <ReportViews key={props.endpoint} {...props}/>;
  return <details className="ab-measurement-disclosure" onToggle={event=>{if(event.currentTarget.open)setOpened(true);}}>
    <summary>Measurement and GAM report</summary>
    {opened?<ReportViews key={props.endpoint} {...props}/>:null}
  </details>;
}

function ReportViews(props:Props){
  const [mode,setMode]=useState<'detailed'|'summary'>('detailed'),[summaryOpened,setSummaryOpened]=useState(false);
  return <div className="ab-measurement-views">
    <div className="runtime-actions" role="group" aria-label="GAM report format">
      <button type="button" aria-pressed={mode==='detailed'} disabled={props.disabled} onClick={()=>setMode('detailed')}>Detailed report</button>
      <button type="button" aria-pressed={mode==='summary'} disabled={props.disabled} onClick={()=>{setSummaryOpened(true);setMode('summary');}}>Daily summary</button>
    </div>
    <div hidden={mode!=='detailed'}><DetailedGamReportPanel endpoint={props.endpoint.replace(/\/measurement\/plans$/,'/measurement/v2/plans')} experimentId={props.experimentId} versionId={props.testId} identityKey={props.identityKey} disabled={props.disabled}/></div>
    {summaryOpened?<div hidden={mode!=='summary'}><MeasurementContent {...props}/></div>:null}
  </div>;
}

function MeasurementContent({endpoint,experimentId,testId,identityKey,disabled=false}:Props){
  const prefix=useId(),active=useRef(true),listTicket=useRef(0),detailTicket=useRef(0),previewTicket=useRef(0),fileTicket=useRef(0);
  const initialized=useRef(false),operation=useRef<Action>(''),fileInput=useRef<HTMLInputElement>(null),noticeRef=useRef<HTMLParagraphElement>(null);
  const reviewRef=useRef<HTMLElement>(null),previewErrorRef=useRef<HTMLParagraphElement>(null);
  const [listing,setListing]=useState<MeasurementPlanListing|null>(null),[listError,setListError]=useState(''),[listLoading,setListLoading]=useState(false),[attempt,setAttempt]=useState(0);
  const [report,setReport]=useState<MeasurementReport>({...emptyReport}),[selected,setSelected]=useState('');
  const [detail,setDetail]=useState<MeasurementPlanDetail|null>(null),[detailError,setDetailError]=useState(''),[detailAttempt,setDetailAttempt]=useState(0);
  const [busy,setBusy]=useState<Action>(''),[notice,setNotice]=useState<{text:string;error:boolean}|null>(null);
  const [csv,setCsv]=useState(''),[fileName,setFileName]=useState(''),[inputError,setInputError]=useState('');
  const [preview,setPreview]=useState<GamReportPreview|null>(null),[previewError,setPreviewError]=useState('');
  useEffect(()=>{active.current=true;return()=>{active.current=false;listTicket.current++;detailTicket.current++;previewTicket.current++;fileTicket.current++;};},[]);
  useEffect(()=>{if(!busy&&notice)noticeRef.current?.focus();},[busy,notice]);
  useEffect(()=>{if(!busy){if(previewError)previewErrorRef.current?.focus();else if(preview)reviewRef.current?.focus();}},[busy,preview,previewError]);
  async function request(path='',body?:unknown){
    return fetch(endpoint+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',
      headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  }
  async function load(){
    const ticket=++listTicket.current;setListLoading(true);
    try{
      const response=await request();if(!response.ok)throw await problem(response,'Could not load reporting plans. Retry.');
      const next=await response.json() as MeasurementPlanListing;
      if(!active.current||ticket!==listTicket.current)return;
      setListing(next);setListError('');
      if(!initialized.current){
        initialized.current=true;
        setReport({...emptyReport,...next.defaults,networkCode:next.defaults.networkCode??'',inventoryPath:next.defaults.inventoryPath??'',
          startDate:'',endDate:'',currency:''});
      }
      setSelected(current=>next.plans.some(plan=>plan.id===current)?current:next.plans[0]?.id??'');
    }catch(error){if(active.current&&ticket===listTicket.current){clearReview();throw error;}}
    finally{if(active.current&&ticket===listTicket.current)setListLoading(false);}
  }
  useEffect(()=>{void load().catch(error=>setListError(error instanceof Error?error.message:'Could not load reporting plans. Retry.'));},[endpoint,attempt]);
  function clearReview(){previewTicket.current++;setPreview(null);setPreviewError('');}
  function clearInput(){
    fileTicket.current++;clearReview();setCsv('');setFileName('');setInputError('');
    if(fileInput.current)fileInput.current.value='';
  }
  function choosePlan(id:string){
    if(id===selected){if(!detail)setDetailAttempt(value=>value+1);return;}
    detailTicket.current++;clearInput();setDetail(null);setDetailError('');setNotice(null);setSelected(id);
  }
  useEffect(()=>{
    const ticket=++detailTicket.current;setDetail(null);setDetailError('');clearInput();
    if(!selected)return;
    void(async()=>{
      try{
        const response=await request('/'+selected);if(!response.ok)throw await problem(response,'Could not read this reporting plan. Retry.');
        const next=await response.json() as MeasurementPlanDetail;
        if(next.plan.id!==selected||next.plan.experimentId!==experimentId||next.plan.testId!==testId)throw new Error('The reporting plan belongs to a different test. Reload the plans.');
        if(active.current&&ticket===detailTicket.current)setDetail(next);
      }catch(error){if(active.current&&ticket===detailTicket.current)setDetailError(error instanceof Error?error.message:'Could not read this reporting plan. Retry.');}
    })();
  },[selected,detailAttempt]);
  const locked=disabled||busy!==''||listLoading;
  async function run(action:Action,work:()=>Promise<string|void>){
    if(operation.current||disabled)return;operation.current=action;setBusy(action);setNotice(null);
    try{const text=await work();if(active.current&&text)setNotice({text,error:false});}
    catch(error){if(active.current)setNotice({text:error instanceof Error?error.message:'The report action failed. Retry.',error:true});}
    finally{operation.current='';if(active.current)setBusy('');}
  }
  function edit<K extends keyof MeasurementReport>(field:K,value:MeasurementReport[K]){
    clearReview();setNotice(null);setReport(current=>({...current,[field]:value}));
  }
  async function create(){
    const response=await request('',{...report});if(!response.ok)throw await problem(response,'The reporting plan save is unconfirmed. Retry with the same fields.');
    const saved=await response.json() as MeasurementPlanDetail&{created:boolean};
    if(!active.current)return;
    await load();if(!active.current)return;choosePlan(saved.plan.id);
    return saved.created?'Reporting plan saved. Its report context is fixed; download the template and review the matching GAM CSV.':'This reporting plan is already saved. The existing plan is selected.';
  }
  async function template(){
    if(!detail)return;
    const response=await request('/'+detail.plan.id+'/template.csv');if(!response.ok)throw await problem(response,'Could not download the GAM CSV template. Retry.');
    const bytes=await response.arrayBuffer();if(!active.current)return;
    download(bytes,'text/csv',`gam-template-${testId}-${detail.plan.id.slice(-8)}.csv`);
    return 'GAM CSV template downloaded. Use the exact report context and columns shown below.';
  }
  async function upload(file:File){
    clearInput();const ticket=++fileTicket.current;
    if(file.size>AB_GAM_CSV_LIMIT)throw new Error('CSV must be at most 128 KB. Choose a smaller file.');
    let text:string;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw new Error('Use a UTF-8 CSV file.');}
    if(!active.current||ticket!==fileTicket.current)return;
    setCsv(text);setFileName(file.name);setInputError('');
    return 'CSV loaded into this page. Review it to check its rows and totals.';
  }
  async function review(){
    clearReview();setNotice(null);setInputError('');if(!detail)return;
    if(new TextEncoder().encode(csv).length>AB_GAM_CSV_LIMIT)throw new Error('CSV must be at most 128 KB. Reduce the input before reviewing.');
    const ticket=++previewTicket.current,plan=detail.plan;
    try{
      const response=await request('/'+plan.id+'/preview',{csv});if(!response.ok)throw await problem(response,'The CSV could not be reviewed. Correct the input and retry.');
      const next=await response.json() as GamReportPreview;
      if(next.planId!==plan.id||next.experimentId!==experimentId||next.testId!==testId||next.period.startDate!==plan.report.startDate||next.period.endDate!==plan.report.endDate||next.period.timeZone!==plan.report.timeZone||next.source.currency!==plan.report.currency||next.source.revenueBasis!==plan.report.revenueBasis||next.source.revenueMetric!==plan.report.revenueMetric)
        throw new Error('The CSV review does not match the selected reporting plan. Reload the plan and retry.');
      if(active.current&&ticket===previewTicket.current)setPreview(next);
    }catch(error){
      if(active.current&&ticket===previewTicket.current)setPreviewError(error instanceof Error?error.message:'The CSV could not be reviewed. Retry.');
    }
  }
  const canCreate=Boolean(listing&&!listing.sourceError&&report.networkCode.trim()&&report.inventoryPath.trim()&&report.startDate&&report.endDate&&/^[A-Z]{3}$/.test(report.currency)&&report.timeZone.trim());
  const field=(name:string)=>prefix+'-'+name;
  const context=detail?.plan.report;
  const progress=busy==='plan'?'Saving reporting plan…':busy==='template'?'Downloading GAM CSV template…':busy==='upload'?'Reading CSV file…':busy==='preview'?'Reviewing GAM CSV…':'';
  const rows=preview?[
    ['Imported daily rows',count(preview.totals.A.rowCount),count(preview.totals.B.rowCount)],
    ['Impressions',count(preview.totals.A.impressions),count(preview.totals.B.impressions)],
    [`Revenue (${preview.source.currency})`,preview.totals.A.revenue??'Not provided',preview.totals.B.revenue??'Not provided'],
    [`Revenue per 1,000 impressions (${preview.source.currency})`,rate(preview.totals.A.revenuePerThousandImpressions),rate(preview.totals.B.revenuePerThousandImpressions)],
    ['Ad requests',count(preview.totals.A.adRequests),count(preview.totals.B.adRequests)],
    ['Responses served',count(preview.totals.A.responsesServed),count(preview.totals.B.responsesServed)],
    ['Response rate (%)',rate(preview.totals.A.responseRatePercent),rate(preview.totals.B.responseRatePercent)],
    ['Measurable impressions',count(preview.totals.A.measurableImpressions),count(preview.totals.B.measurableImpressions)],
    ['Viewable impressions',count(preview.totals.A.viewableImpressions),count(preview.totals.B.viewableImpressions)],
    ['Viewability (%)',rate(preview.totals.A.viewabilityPercent),rate(preview.totals.B.viewabilityPercent)],
    ['Assigned page views','Unavailable','Unavailable'],['Page RPM','Unavailable','Unavailable'],
  ]:[];

  return <section className="ab-measurement-panel" aria-label="Measurement and GAM report">
    <h5>Prepare and review a GAM report</h5>
    <p>Bind a report to this saved test, then check its daily A/B rows. Saving a plan does not start the test or change GAM.</p>
    <p className="ab-tests-note">External page counting is disabled. Page-local loader diagnostics are not a count of all assigned page views. Page RPM, uplift and a winner remain unavailable.</p>
    {listError?<p role="alert" className="runtime-error">{listError} <button type="button" disabled={locked} onClick={()=>setAttempt(value=>value+1)}>Reload reporting plans</button></p>
    :!listing?<p role="status" className="ab-tests-status">Loading reporting plans…</p>:<>
      <label htmlFor={field('saved-plan')}>Saved reporting plan</label>
      <select id={field('saved-plan')} value={selected} disabled={locked||!listing.plans.length} onChange={event=>choosePlan(event.target.value)}>
        <option value="">Choose a reporting plan</option>
        {listing.plans.map(plan=><option key={plan.id} value={plan.id}>{metric(plan.report.revenueMetric)} · {plan.report.currency} · {basis(plan.report.revenueBasis)} · {plan.report.startDate} – {plan.report.endDate} · {plan.report.timeZone} · {plan.id.slice(-8)}</option>)}
      </select>
      <button type="button" disabled={locked} onClick={()=>setAttempt(value=>value+1)}>Reload reporting plans</button>
      {listLoading?<p role="status" className="ab-tests-status">Reloading reporting plans…</p>:null}
      {!listing.plans.length?<p>No reporting plans saved yet. Define the report context below.</p>:null}
      <details className="ab-measurement-new" open={listing.plans.length===0}>
        <summary>New reporting plan</summary>
        <p>A plan fixes the inventory, complete period and financial context for this experiment. These fields do not edit a selected saved plan. Use another plan when the context changes.</p>
        {listing.sourceError?<p role="alert" className="runtime-error">New plans are unavailable: {listing.sourceError} Existing plans can still be read.</p>:null}
        <form onSubmit={event=>{event.preventDefault();if(canCreate)void run('plan',create);}}>
          <div className="ab-measurement-fields">
            <div><label htmlFor={field('network')}>GAM network code</label><input id={field('network')} required value={report.networkCode} disabled={locked||Boolean(listing.sourceError)} onChange={event=>edit('networkCode',event.target.value)} autoComplete="off"/></div>
            <div><label htmlFor={field('inventory')}>Inventory path</label><input id={field('inventory')} required value={report.inventoryPath} disabled={locked||Boolean(listing.sourceError)} onChange={event=>edit('inventoryPath',event.target.value)} autoComplete="off"/></div>
            <div><label htmlFor={field('start')}>Report start date</label><input id={field('start')} type="date" required value={report.startDate} disabled={locked} onChange={event=>edit('startDate',event.target.value)}/></div>
            <div><label htmlFor={field('end')}>Report end date</label><input id={field('end')} type="date" required value={report.endDate} disabled={locked} onChange={event=>edit('endDate',event.target.value)}/></div>
            <div><label htmlFor={field('currency')}>Report currency</label><input id={field('currency')} required maxLength={3} pattern="[A-Z]{3}" placeholder="For example: EUR" value={report.currency} disabled={locked} onChange={event=>edit('currency',event.target.value.toUpperCase())} autoComplete="off"/></div>
            <div><label htmlFor={field('timezone')}>GAM report time zone</label><input id={field('timezone')} required value={report.timeZone} disabled={locked} onChange={event=>edit('timeZone',event.target.value)} placeholder="For example: Europe/Belgrade" autoComplete="off"/></div>
            <div><label htmlFor={field('basis')}>Revenue basis</label><select id={field('basis')} value={report.revenueBasis} disabled={locked} onChange={event=>edit('revenueBasis',event.target.value as MeasurementReport['revenueBasis'])}><option value="unknown">Unknown</option><option value="gross">Gross</option><option value="net">Net</option></select></div>
            <div><label htmlFor={field('metric')}>Revenue metric</label><select id={field('metric')} value={report.revenueMetric} disabled={locked} onChange={event=>edit('revenueMetric',event.target.value as MeasurementReport['revenueMetric'])}><option value="total">Total revenue</option><option value="cpm-cpc">Total CPM and CPC revenue</option></select></div>
          </div>
          <p className="ab-tests-help">Network and inventory must match both verified saved scripts. Use the GAM report's currency, IANA time zone and gross/net basis; only complete days in that time zone belong in the report.</p>
          <button type="submit" disabled={locked||!canCreate}>Save reporting plan</button>
        </form>
      </details>
      {selected&&!detail&&!detailError?<p role="status" className="ab-tests-status">Reading selected reporting plan…</p>:null}
      {detailError?<p role="alert" className="runtime-error">{detailError} <button type="button" disabled={locked} onClick={()=>setDetailAttempt(value=>value+1)}>Retry reporting plan</button></p>:null}
      {detail&&context?<>
        <h5>Selected report context</h5>
        <dl className="ab-measurement-context">
          <div><dt>Version ID</dt><dd><code>{testId}</code> · {detail.plan.id.slice(-8)}</dd></div>
          <div><dt>Network / inventory</dt><dd>{context.networkCode} · <code>{context.inventoryPath}</code></dd></div>
          <div><dt>Period</dt><dd>{context.startDate} – {context.endDate} · {context.timeZone}</dd></div>
          <div><dt>Revenue</dt><dd>{context.currency} · {basis(context.revenueBasis)} · {metric(context.revenueMetric)}</dd></div>
        </dl>
        <details><summary>GAM export guidance</summary><ol>
          <li>Use the selected network, inventory and complete date range. Filter the package's GAM key <code>{identityKey??'TestId'}={testId}</code> and include both <code>Variant=A</code> and <code>Variant=B</code>. The daily-summary CSV keeps its normalized <code>TestId</code> column for compatibility; enter this same Version ID there.</li>
          <li>Use the selected currency, time zone, revenue metric and gross/net basis. Verify those settings against the original GAM report; the CSV alone does not prove the source.</li>
          <li>Break down TestId and Variant together in each daily row. Never sum separate or overlapping Key-values rows. Export one daily row per variant; remove totals and extra dimensions, and do not combine overlapping inventory or multiple reports.</li>
          <li>Use the exact template columns. Impressions and revenue are required in every row. Counts use whole numbers without separators; revenue uses a decimal point and up to six decimal places. For unavailable ad request/response or measurable/viewable counts, leave both cells in that pair blank. Missing rows are unknown, not zero.</li>
        </ol><p className="ab-tests-help"><code>{AB_GAM_COLUMNS.join(',')}</code></p></details>
        <button type="button" disabled={locked} onClick={()=>void run('template',template)}>Download GAM CSV template</button>
        <h5>Review GAM CSV</h5>
        <p>The CSV is processed for this preview and is not stored. Download the review if you need to keep it. Financial results stay separate from script delivery.</p>
        <label htmlFor={field('file')}>Upload GAM CSV</label>
        <input ref={fileInput} id={field('file')} type="file" accept=".csv,text/csv" disabled={locked} aria-invalid={Boolean(inputError)} aria-describedby={inputError?field('action-notice'):undefined} onChange={event=>{
          const file=event.target.files?.[0];if(file)void run('upload',async()=>{try{return await upload(file);}catch(error){setInputError(error instanceof Error?error.message:'Could not read this file.');throw error;}});
        }}/>
        {fileName?<p className="ab-tests-help">Loaded file: {fileName}</p>:null}
        <label htmlFor={field('csv')}>GAM CSV</label>
        <textarea id={field('csv')} rows={8} value={csv} disabled={locked} spellCheck={false} placeholder={AB_GAM_COLUMNS.join(',')} onChange={event=>{clearReview();setCsv(event.target.value);setFileName('');setInputError('');setNotice(null);}}/>
        <p className="ab-tests-help">UTF-8 CSV, at most 128 KB. Ad requests and impressions are never used as assigned page views.</p>
        <div className="runtime-actions"><button type="button" disabled={locked||!csv.trim()} onClick={()=>void run('preview',review)}>Review GAM CSV</button><button type="button" disabled={locked||(!csv&&!preview&&!inputError&&!previewError)} onClick={()=>{clearInput();setNotice({text:'Report input and review cleared.',error:false});}}>Clear report input</button></div>
        {previewError?<p ref={previewErrorRef} tabIndex={-1} role="alert" className="runtime-error">{previewError}</p>:null}
      </>:null}
      {progress?<p role="status" className="ab-tests-status">{progress}</p>:null}
      {notice?<p id={field('action-notice')} ref={noticeRef} tabIndex={-1} role={notice.error?'alert':'status'} className={notice.error?'runtime-error':'ab-tests-status'}>{notice.text}</p>:null}
      {preview?<section ref={reviewRef} tabIndex={-1} className="ab-measurement-review" aria-label="GAM CSV review">
        <h5>Provided GAM totals</h5>
        <p>{preview.providedRows} daily rows · {preview.period.startDate} – {preview.period.endDate} · {preview.period.timeZone}. Totals describe imported rows only.</p>
        <p className="ab-tests-note"><strong>Revenue comparison unavailable.</strong> Assignment coverage is unknown. Page RPM, uplift and a winner cannot be calculated from GAM impressions or ad requests.</p>
        <div className="ab-tests-diff"><table><caption>Imported GAM counts and rates by GAM Variant</caption><thead><tr><th scope="col">Metric</th><th scope="col">A</th><th scope="col">B</th></tr></thead><tbody>
          {rows.map(([name,a,b])=><tr key={name}><th scope="row">{name}</th><td data-label="A">{a}</td><td data-label="B">{b}</td></tr>)}
        </tbody></table></div>
        <p className="ab-tests-help">Response rate = summed responses served / summed ad requests. Viewability = summed viewable / summed measurable impressions. These rates do not measure page views or all-network fill.</p>
        <h5>Data quality and missing measurements</h5>
        {preview.missingRows.length?<><p>{preview.missingRows.length} missing daily A/B rows. These values are unknown, not zero.</p><ul>{preview.missingRows.slice(0,20).map(row=><li key={row.date+row.variant}>{row.date} · Variant {row.variant}</li>)}</ul>{preview.missingRows.length>20?<p>Download the review for all missing rows.</p>:null}</>:<p>No missing daily A/B rows in the imported period.</p>}
        {preview.blockers.length?<ul>{preview.blockers.map(message=><li key={message}>{message}</li>)}</ul>:null}
        <p>Speed, auction errors and cache diagnostics are not part of this GAM CSV. No values have been inferred.</p>
        <details><summary>Review identity and notes</summary><dl className="ab-measurement-context"><div><dt>Plan ID</dt><dd><code>{preview.planId}</code></dd></div><div><dt>CSV SHA-256</dt><dd><code>{preview.source.csvSha256}</code></dd></div></dl><ul>{preview.notes.map(message=><li key={message}>{message}</li>)}</ul></details>
        <button type="button" disabled={locked} onClick={()=>{download(JSON.stringify(preview,null,2)+'\n','application/json',`gam-review-${testId}-${preview.planId.slice(-8)}.json`);setNotice({text:'GAM review JSON downloaded. The CSV was not stored.',error:false});}}>Download review JSON</button>
      </section>:null}
    </>}
  </section>;
}
