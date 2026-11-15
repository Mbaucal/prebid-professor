import { useEffect, useRef, useState } from 'react';

/* A/B tests of one site (MBA-416): compare two saved versions, save an immutable test, download its ZIP and record,
 * mark it live or stopped, and move it to and from the trash. Shared by both lines: the caller passes the API endpoint
 * (TEST: /test-api/ab-tests). React only, so no server code reaches the browser bundle.
 * Notices use their own .ab-tests-status class: other verifiers look for .runtime-message and .runtime-error with
 * role=status in the same view, so this panel never puts role=status on those classes, and errors are role=alert. */
type Version = {id:string;name:string;createdAt:string;runtimeVersion:string;prebidVersion:string|null};
type Arm = {release:string;runtimeVersion:string;name:string};
type Summary = {id:string;name:string;testId:string;trafficBPercent:number;createdAt:string;createdBy:string;zipSha256:string;
  prebidVersion:string|null;fileCount:number;arms:{A:Arm;B:Arm};deletedAt:string|null};
type Listing = {supported:boolean;site:string;testOnly:boolean;defaults:{trafficBPercent:number};proposedTestId:string|null;current:string|null;
  versions:Version[];tests:Summary[];deleted:Summary[];limits:{tests:number;name:number}};
type DiffRow = {field:string;a:unknown;b:unknown};
type CheckResult = {compatible:boolean;refusal:{code:string;check:string|null;message:string}|null;warnings:Array<{code:string;message:string}>;
  configDiff:DiffRow[]|null};
type AbEvent = {seq:number;type:'marked-live'|'marked-stopped';at:string;by:string};
type Detail = {record:{name:string;testId:string;arms:{A:Arm;B:Arm};bundle:{files:Array<{path:string;bytes:number;sha256:string}>;zipSha256:string}};
  recordSha256:string;deletedAt:string|null;events:AbEvent[]};
// publisherId names the site for the MAIN port (P4a); the endpoint already carries it.
type Props = {publisherId:string;endpoint:string;testOnly?:boolean;refreshKey?:number};

const TEST_ID = /^[a-z0-9_]{1,24}$/;
const FIELD_LABELS: Record<string,string> = {
  runtimeVersion:'Script version',capabilities:'Script capabilities','bidCache.enabled':'Bid caching','bidCache.maxAgeSeconds':'Maximum bid age (seconds)',
  'bidCache.positions':'Bid cache positions','refresh.default':'Refresh','refresh.rules':'Refresh by position','refresh.stickySeconds':'Sticky refresh (seconds)',
  floors:'Floors',bidders:'Bidders',bidderParams:'Bidder settings',timeouts:'Timeouts','timeouts.rules':'Timeouts by position',otherSettings:'Other settings',
};
const LIST_FIELDS = new Set(['capabilities','bidCache.positions','bidders']);
const when = (iso:string) => new Date(iso).toLocaleString();
const short = (id:string) => id.slice(-8);
const shown = (value:unknown) => value===null||value===undefined?'Not set':Array.isArray(value)&&!value.length?'None':typeof value==='boolean'?(value?'On':'Off')
  :typeof value==='string'||typeof value==='number'?String(value):JSON.stringify(value,null,2);
async function sha256(bytes:ArrayBuffer){
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
}
function save(bytes:ArrayBuffer,type:string,name:string){
  const url=URL.createObjectURL(new Blob([bytes],{type})),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function failure(response:Response,fallback:string){
  try{return Error(((await response.json()) as {error?:string}).error||fallback);}catch{return Error(fallback);}
}

export default function AbTestsPanel({endpoint,testOnly=false,refreshKey=0}:Props){
  const [data,setData]=useState<Listing|null>(null),[loadError,setLoadError]=useState(''),[attempt,setAttempt]=useState(0);
  const [details,setDetails]=useState<Record<string,Detail|{error:string}>>({});
  const [name,setName]=useState(''),[testId,setTestId]=useState(''),[testIdEdited,setTestIdEdited]=useState(false);
  const [a,setA]=useState(''),[b,setB]=useState(''),[traffic,setTraffic]=useState('');
  const [result,setResult]=useState<{pair:string;check:CheckResult}|null>(null);
  // A notice shows where its action was taken: 'form', 'list' or a test id.
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState<{at:string;text:string;error:boolean}|null>(null);
  const lock=useRef(false),loads=useRef(0),section=useRef<HTMLElement>(null),scrolled=useRef(false),stopFollow=useRef<()=>void>(()=>{});

  async function request(path:string,init?:{method:string;body?:unknown}){
    return fetch(endpoint+path,{method:init?.method??'GET',credentials:'same-origin',cache:'no-store',
      headers:init?.body===undefined?{}:{'content-type':'application/json'},body:init?.body===undefined?undefined:JSON.stringify(init.body)});
  }
  /** The record and the events of one test. A failure is shown in that test only. */
  async function loadDetail(id:string){
    let value:Detail|{error:string};
    try{
      const response=await request('/'+id);
      value=response.ok?await response.json() as Detail:{error:(await failure(response,'Could not read this A/B test.')).message};
    }catch{value={error:'Could not read this A/B test. Reload A/B tests.'};}
    setDetails(old=>({...old,[id]:value}));
  }
  async function load(){
    const ticket=++loads.current,response=await request('');
    if(!response.ok)throw await failure(response,'Could not load A/B tests.');
    const next=await response.json() as Listing;
    // A slower earlier load never replaces a newer one.
    if(ticket!==loads.current)return;
    setData(next);setLoadError('');
    setTraffic(old=>old===''?String(next.defaults.trafficBPercent):old);
    if(next.current)setA(old=>old||next.current!);
    for(const test of next.tests)void loadDetail(test.id);
  }
  // The first load, a retry, and a reload after Saved versions changed. Entered values are kept.
  useEffect(()=>{load().catch(e=>setLoadError(e instanceof Error?e.message:'Could not load A/B tests.'));},[endpoint,attempt,refreshKey]);
  // The TestId follows the proposal until the operator edits it.
  useEffect(()=>{if(data&&!testIdEdited)setTestId(data.proposedTestId??'');},[data,testIdEdited]);
  // /site-workspace#ab-tests: bring the panel into view once it has loaded, and keep it there while the panels above
  // finish loading, until the operator scrolls or 3 seconds pass.
  useEffect(()=>{
    if(!data||scrolled.current||window.location.hash!=='#ab-tests'||!section.current)return;
    scrolled.current=true;
    const node=section.current,follow=()=>node.scrollIntoView({block:'start'}),events=['wheel','touchstart','keydown','mousedown'];
    const observer=new ResizeObserver(follow);
    const stop=()=>{observer.disconnect();clearTimeout(timer);for(const name of events)window.removeEventListener(name,stop);};
    const timer=setTimeout(stop,3000);
    for(const name of events)window.addEventListener(name,stop,{passive:true});
    observer.observe(document.body);follow();stopFollow.current=stop;
  },[data]);
  useEffect(()=>{
    const change=()=>{if(window.location.hash==='#ab-tests')section.current?.scrollIntoView({block:'start'});};
    window.addEventListener('hashchange',change);
    return()=>{window.removeEventListener('hashchange',change);stopFollow.current();};
  },[]);

  /** One action at a time. fn returns its notice, or where to show it when that is not where it was taken. */
  async function run(at:string,fn:()=>Promise<string|{at:string;text:string}|void>){
    if(lock.current)return;lock.current=true;setBusy(true);setNotice(null);
    try{const done=await fn();if(done)setNotice(typeof done==='string'?{at,text:done,error:false}:{...done,error:false});}
    catch(e){setNotice({at,text:e instanceof Error?e.message:'The A/B test action failed. Retry.',error:true});}
    finally{lock.current=false;setBusy(false);}
  }
  const noticeAt=(at:string)=>notice?.at!==at?null:notice.error?<p role="alert" className="runtime-error">{notice.text}</p>
    :<p className="ab-tests-status" role="status">{notice.text}</p>;
  const pair=`${a}|${b}`,trafficValue=/^\d{1,3}$/.test(traffic)&&Number(traffic)<=100?Number(traffic):null;
  const checked=result?.pair===pair?result.check:null;
  const canSave=Boolean(checked?.compatible&&name.trim()&&TEST_ID.test(testId)&&trafficValue!==null);
  async function check(){
    const response=await request('/check',{method:'POST',body:{a,b}});
    if(!response.ok)throw await failure(response,'Could not check these versions.');
    setResult({pair,check:await response.json() as CheckResult});
  }
  async function create(){
    const response=await request('',{method:'POST',body:{name:name.trim(),testId,a,b,trafficBPercent:trafficValue}});
    if(!response.ok)throw await failure(response,'Could not save the A/B test.');
    const saved=await response.json() as {created:boolean;deletedAt?:string|null;record:{name:string}};
    // A new test starts from an empty name, the next proposed TestId and a new check.
    if(saved.created){setName('');setTestIdEdited(false);setResult(null);}
    await load();
    return saved.created?`A/B test "${saved.record.name}" saved. Download its ZIP below.`
      :saved.deletedAt?'This A/B test is already saved and is in Deleted A/B tests. Restore it there. Nothing new was stored.'
      :'This A/B test is already saved. Nothing new was stored.';
  }
  async function download(test:Summary){
    const response=await request(`/${test.id}/download`);
    if(!response.ok)throw await failure(response,'Could not download the A/B ZIP.');
    const bytes=await response.arrayBuffer();
    if(await sha256(bytes)!==test.zipSha256||response.headers.get('x-package-sha256')!==test.zipSha256)
      throw Error('The downloaded ZIP differs from the saved A/B test. Nothing was saved to your computer. Retry.');
    save(bytes,'application/zip',`ab-${test.testId}-${short(test.id)}.zip`);
    return `${test.name}: A/B ZIP downloaded and checked.`;
  }
  async function downloadRecord(test:Summary){
    const response=await request(`/${test.id}/record`);
    if(!response.ok)throw await failure(response,'Could not download the test record.');
    const bytes=await response.arrayBuffer(),expected=response.headers.get('x-record-sha256'),detail=details[test.id];
    if(!expected||await sha256(bytes)!==expected||(detail&&'recordSha256' in detail&&detail.recordSha256!==expected))
      throw Error('The downloaded test record differs from the saved A/B test. Nothing was saved to your computer. Retry.');
    save(bytes,'application/json',`ab-${test.testId}-${short(test.id)}.json`);
    return `${test.name}: test record downloaded and checked.`;
  }
  async function mark(test:Summary,type:AbEvent['type']){
    const question=type==='marked-live'
      ?`Mark "${test.name}" live? This records that the test started on your site now. It does not publish or change any file.`
      :`Mark "${test.name}" stopped? This records that the test stopped on your site now. It does not change any file.`;
    if(!window.confirm(question))return;
    const response=await request(`/${test.id}/events`,{method:'POST',body:{type}});
    if(!response.ok){const problem=await failure(response,'Could not record this change.');await load();throw problem;}
    await loadDetail(test.id);
    return `${test.name}: marked ${type==='marked-live'?'live':'stopped'}.`;
  }
  async function trash(test:Summary,remove:boolean){
    if(remove&&!window.confirm(`Delete A/B test "${test.name}"? It moves to Deleted A/B tests. Its files and TestId ${test.testId} are kept, so you can restore it.`))return;
    const response=await request('/'+test.id,{method:remove?'DELETE':'PUT',body:{confirmId:test.id,sha256:test.zipSha256}});
    if(!response.ok)throw await failure(response,remove?'Could not delete the A/B test.':'Could not restore the A/B test.');
    await load();
    return remove?{at:'list',text:`${test.name}: moved to Deleted A/B tests.`}:{at:test.id,text:`${test.name}: restored.`};
  }

  const versions=data?.versions??[],known=new Set(versions.map(v=>v.id));
  const options=(selected:string)=><>
    <option value="">Choose a saved version</option>
    {selected&&!known.has(selected)?<option value={selected}>{short(selected)} · no longer in Saved versions</option>:null}
    {versions.map(v=><option key={v.id} value={v.id}>{`${v.name} · ${when(v.createdAt)} · ${v.runtimeVersion} · ${short(v.id)}`}</option>)}
  </>;
  const armLine=(side:'A'|'B',arm:Arm)=><div key={side}><dt>Version {side}</dt><dd>
    <span className="ab-tests-name">{arm.name}</span> · {arm.runtimeVersion} · {short(arm.release)}
    {known.has(arm.release)?null:<span className="ab-tests-tag"> (no longer in Saved versions; this test keeps its own copy)</span>}</dd></div>;

  return <section id="ab-tests" ref={section} className="site-runtime-panel ab-tests-panel" aria-labelledby="ab-tests-title" data-ab-busy={busy?true:undefined}>
    <h2 id="ab-tests-title">A/B tests</h2>
    <p>Compare two saved versions on your site. Each visitor gets version A or version B. A saved test never changes.</p>
    {loadError?<p role="alert" className="runtime-error">{loadError} <button onClick={()=>setAttempt(n=>n+1)}>Reload A/B tests</button></p>
    :!data?<p className="ab-tests-status" role="status">Loading A/B tests…</p>:<>
    <form className="ab-tests-form" aria-labelledby="ab-tests-new" onSubmit={e=>{e.preventDefault();if(canSave)void run('form',create);}}>
      <h3 id="ab-tests-new">New A/B test</h3>
      {data.current?null:<p className="ab-tests-note">This site has no production version on TEST. Choose A yourself: use the version your test page runs now.</p>}
      {!versions.length?<p>Generate and save a version first. An A/B test compares two saved versions.</p>:null}
      <div className="ab-tests-fields">
        <div className="ab-tests-field"><label htmlFor="ab-test-name">Test name</label>
          <input id="ab-test-name" required maxLength={data.limits.name} value={name} disabled={busy} onChange={e=>setName(e.target.value)} placeholder="For example: Bid cache on"/></div>
        <div className="ab-tests-field"><label htmlFor="ab-test-id">TestId</label>
          <input id="ab-test-id" required maxLength={24} pattern="[a-z0-9_]{1,24}" value={testId} disabled={busy} aria-describedby="ab-test-id-help"
            onChange={e=>{setTestId(e.target.value);setTestIdEdited(true);}}/>
          <p id="ab-test-id-help" className="ab-tests-help">Lowercase letters, digits and _. Each TestId is used once on this site and stays reserved.</p></div>
        <div className="ab-tests-field"><label htmlFor="ab-version-a">Version A</label>
          <select id="ab-version-a" value={a} disabled={busy} aria-describedby={data.current&&a===data.current?'ab-version-a-current':undefined} onChange={e=>setA(e.target.value)}>{options(a)}</select>
          {data.current&&a===data.current?<p id="ab-version-a-current" className="ab-tests-help">Current production version</p>:null}</div>
        <div className="ab-tests-field"><label htmlFor="ab-version-b">Version B</label>
          <select id="ab-version-b" value={b} disabled={busy} onChange={e=>setB(e.target.value)}>{options(b)}</select></div>
        <div className="ab-tests-field"><label htmlFor="ab-traffic">Traffic to B (%)</label>
          <input id="ab-traffic" type="number" required min={0} max={100} step={1} inputMode="numeric" value={traffic} disabled={busy} aria-describedby="ab-traffic-split"
            onChange={e=>setTraffic(e.target.value)}/>
          <p id="ab-traffic-split" className="ab-tests-help">{trafficValue===null?'Use a whole number from 0 to 100.':`A: ${100-trafficValue}% · B: ${trafficValue}%`}</p></div>
      </div>
      {a&&a===b?<p className="ab-tests-note">A/A check: both groups get the same version.</p>:null}
      <p className="ab-tests-help">The test name, the TestId and both version names are published inside /ads.js. Do not use private notes.</p>
      <div className="runtime-actions">
        <button type="button" disabled={busy||!a||!b} onClick={()=>void run('form',check)}>Check compatibility</button>
        <button type="submit" disabled={busy||!canSave}>Save A/B test</button>
      </div>
      {noticeAt('form')}
      {checked?<div className="ab-tests-result">
        <p className={checked.compatible?'ab-tests-status':'ab-tests-status ab-tests-refused'} role="status">
          {checked.compatible?'Compatible. You can save this A/B test.':`Not compatible: ${checked.refusal?.message??'These versions cannot be compared.'}`}</p>
        {checked.warnings.length?<ul className="ab-tests-warnings">{checked.warnings.map(w=><li key={w.code}>{w.message}</li>)}</ul>:null}
        {checked.configDiff?<><h4>Summary of differences</h4>{checked.configDiff.length?<>
          <div className="ab-tests-diff"><table><thead><tr><th scope="col">Setting</th><th scope="col">A</th><th scope="col">B</th></tr></thead>
            <tbody>{checked.configDiff.map(row=><tr key={row.field}><th scope="row">{FIELD_LABELS[row.field]??row.field}<code>{row.field}</code></th>
              <td data-label="A"><code>{shown(row.a)}</code></td><td data-label="B"><code>{shown(row.b)}</code></td></tr>)}</tbody></table></div>
          {checked.configDiff.some(row=>LIST_FIELDS.has(row.field))?<p className="ab-tests-help">For lists, each side shows only what the other version lacks.</p>:null}
        </>:<p>No differences in the compared settings.</p>}</>:null}
      </div>:null}
    </form>

    <h3>Saved A/B tests</h3>
    {testOnly?<p className="ab-tests-help">Download the ZIP and upload all of its files, unchanged, as one Pages deployment.</p>:null}
    {noticeAt('list')}
    {!data.tests.length?<p>No A/B tests saved yet.</p>:data.tests.map(test=>{
      const detail=details[test.id],loaded=detail&&'record' in detail?detail:null,last=loaded?.events.at(-1);
      return <article key={test.id} className="ab-tests-item" aria-label={`A/B test: ${test.name}`}>
        <h4 className="ab-tests-name">{test.name}</h4>
        <p>TestId <code>{test.testId}</code> · B {test.trafficBPercent}% · saved {when(test.createdAt)} by <span className="ab-tests-name">{test.createdBy}</span></p>
        <dl className="ab-tests-arms">{armLine('A',test.arms.A)}{armLine('B',test.arms.B)}</dl>
        {detail&&'error' in detail?<p role="alert" className="runtime-error">{detail.error}</p>:null}
        <p>{!loaded?'Reading live and stopped marks…':!last?'Not marked live yet.':last.type==='marked-live'?`Marked live ${when(last.at)}.`:`Marked stopped ${when(last.at)}.`}</p>
        <div className="runtime-actions">
          <button disabled={busy} onClick={()=>void run(test.id,()=>download(test))}>Download A/B ZIP</button>
          <button disabled={busy} onClick={()=>void run(test.id,()=>downloadRecord(test))}>Download test record</button>
          <button disabled={busy||!loaded||last?.type==='marked-live'} onClick={()=>void run(test.id,()=>mark(test,'marked-live'))}>Mark live</button>
          <button disabled={busy||!loaded||last?.type!=='marked-live'} onClick={()=>void run(test.id,()=>mark(test,'marked-stopped'))}>Mark stopped</button>
          <button disabled={busy} onClick={()=>void run(test.id,()=>trash(test,true))}>Delete test</button>
        </div>
        {noticeAt(test.id)}
        {loaded?.events.length?<ul className="ab-tests-events">{loaded.events.map(event=><li key={event.seq}>
          {event.type==='marked-live'?'Marked live':'Marked stopped'} {when(event.at)} by <span className="ab-tests-name">{event.by}</span></li>)}</ul>:null}
        <details><summary>GAM setup checklist</summary><ol>
          <li>Key <code>Variant</code> with the values <code>A</code> and <code>B</code>.</li>
          <li>Key <code>TestId</code> with the value <code>{test.testId}</code>.</li>
          <li>Turn on reporting for both keys.</li>
          <li>GAM does not report traffic from before this setup.</li>
        </ol></details>
        <details><summary>Test details</summary>{loaded?<dl className="ab-tests-details">
          <div><dt>A/B test ID</dt><dd><code>{test.id}</code></dd></div>
          <div><dt>ZIP SHA-256</dt><dd><code>{loaded.record.bundle.zipSha256}</code></dd></div>
          <div><dt>Version A</dt><dd className="ab-tests-name">{loaded.record.arms.A.name}</dd></div>
          <div><dt>Version B</dt><dd className="ab-tests-name">{loaded.record.arms.B.name}</dd></div>
          <div><dt>Files</dt><dd><ul>{loaded.record.bundle.files.map(file=><li key={file.path}><code>{file.path}</code> · {file.bytes} bytes</li>)}</ul></dd></div>
        </dl>:<p>Reading test details…</p>}</details>
      </article>;
    })}
    {data.deleted.length?<details className="ab-tests-deleted"><summary>Deleted A/B tests</summary>
      <p className="ab-tests-help">Deleted tests keep their files and their TestId. Restore a test to download or mark it again.</p>
      {data.deleted.map(test=><article key={test.id} className="ab-tests-item" aria-label={`Deleted A/B test: ${test.name}`}>
        <h4 className="ab-tests-name">{test.name}</h4>
        <p>TestId <code>{test.testId}</code> · deleted {test.deletedAt?when(test.deletedAt):''}</p>
        <div className="runtime-actions"><button disabled={busy} onClick={()=>void run(test.id,()=>trash(test,false))}>Restore</button></div>{noticeAt(test.id)}
      </article>)}
    </details>:null}
    </>}
  </section>;
}
