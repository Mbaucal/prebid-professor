import { useEffect, useRef, useState, type ReactNode } from 'react';
import './ab-tests.css';
import AbMeasurementPanel from './AbMeasurementPanel';
import AbSourceVersionsPanel from './AbSourceVersionsPanel';
import {runtimeNotice, runtimeNoticeSuffix} from '../site-workspace/runtime-notices';
import {runtimeLabel} from '../site-workspace/runtime-labels';

/* A/B tests of one site (MBA-416): compare two saved versions, save an immutable test, download its ZIP and record,
 * mark it live or stopped, and move it to and from the trash. Shared by both lines: the caller passes the API endpoint
 * (MAIN: /api/publishers/<site>/ab-tests, TEST: /test-api/ab-tests). React only, so no server code reaches the browser bundle.
 * Notices use their own .ab-tests-status class: other verifiers look for .runtime-message and .runtime-error with
 * role=status in the same view, so this panel never puts role=status on those classes, and errors are role=alert. */
type Version = {id:string;name:string;createdAt:string|null;runtimeVersion:string|null;runtimeSha256?:string|null;prebidVersion:string|null;state?:'stored'|'unavailable';unavailableReason?:string|null;sourceKind?:'original-script';sourceUrl?:string};
type Arm = {release:string;runtimeVersion:string;name:string};
type Summary = {id:string;name:string;testId:string;trafficBPercent:number;createdAt:string;createdBy:string;zipSha256:string;
  prebidVersion:string|null;fileCount:number;arms:{A:Arm;B:Arm};deletedAt:string|null};
type Listing = {supported:boolean;site:string;testOnly:boolean;defaults:{trafficBPercent:number};proposedTestId:string|null;current:string|null;
  versions:Version[];tests:Summary[];deleted:Summary[];limits:{tests:number;name:number}};
type DiffRow = {field:string;a:unknown;b:unknown};
type CheckResult = {compatible:boolean;refusal:{code:string;check:string|null;message:string}|null;warnings:Array<{code:string;message:string}>;
  configDiff:DiffRow[]|null};
type AbEvent = {seq:number;type:'marked-live'|'marked-stopped';at:string;by:string};
type Detail = {record:{name:string;testId:string;loader?:{version:string};arms:{A:Arm;B:Arm};bundle:{files:Array<{path:string;bytes:number;sha256:string}>;zipSha256:string}};
  recordSha256:string;deletedAt:string|null;events:AbEvent[]};
type Props = {publisherId:string;endpoint:string;testOnly?:boolean;refreshKey?:number;onOpenMeasurement?:(id?:string)=>void;workspace?:boolean;siteName?:string;history?:ReactNode;preferredExperimentId?:string};

const TEST_ID = /^[a-z0-9_]{1,24}$/;
const STOP_TEST = "To stop a test, restore version A's exact saved package at the same script URL, or roll back the Pages deployment to the approved control version. When using A's saved ZIP, serve ads.min.js as ads.js and keep its other delivery files unchanged. Then use Mark stopped.";
const FIELD_LABELS: Record<string,string> = {
  runtimeVersion:'Script version',capabilities:'Script capabilities','bidCache.enabled':'Bid caching','bidCache.maxAgeSeconds':'Maximum bid age (seconds)',
  'bidCache.positions':'Bid cache positions','refresh.default':'Refresh','refresh.rules':'Refresh by position','refresh.stickySeconds':'Sticky refresh (seconds)',
  floors:'Floors',bidders:'Bidders',bidderParams:'Bidder settings',timeouts:'Timeouts','timeouts.rules':'Timeouts by position',otherSettings:'Other settings',
  sourceBuild:'Original build',sourceUrl:'Original source',
};
// List fields hold only what one side has and the other lacks (ab-bundle.mjs configDiff), so an empty side is not "None".
const LIST_FIELDS = new Set(['capabilities','bidCache.positions','bidders']);
const when = (iso:string|null) => iso?new Date(iso).toLocaleString():'Unavailable';
const short = (id:string) => id.slice(-8);
const shown = (value:unknown) => value===null||value===undefined?'Not set':Array.isArray(value)&&!value.length?'None':typeof value==='boolean'?(value?'On':'Off')
  :typeof value==='string'||typeof value==='number'?String(value):JSON.stringify(value,null,2);
const cell = (field:string,value:unknown) => LIST_FIELDS.has(field)&&Array.isArray(value)&&!value.length?'Nothing extra':shown(value);
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

export default function AbTestsPanel(props:Props){
  // A different site or endpoint gets a fresh form and request history. Late responses from the old view cannot
  // populate another site's versions, checks or live/stopped marks.
  return <SiteAbTestsPanel key={`${props.publisherId}:${props.endpoint}`} {...props}/>;
}

function SiteAbTestsPanel({publisherId,endpoint,testOnly=false,refreshKey=0,onOpenMeasurement,workspace=false,siteName,history,preferredExperimentId}:Props){
  const [data,setData]=useState<Listing|null>(null),[loadError,setLoadError]=useState(''),[attempt,setAttempt]=useState(0);
  const [details,setDetails]=useState<Record<string,Detail|{error:string}>>({});
  const [name,setName]=useState(''),[testId,setTestId]=useState(''),[testIdEdited,setTestIdEdited]=useState(false);
  const [a,setA]=useState(''),[b,setB]=useState(''),[traffic,setTraffic]=useState('');
  const [result,setResult]=useState<{pair:string;check:CheckResult}|null>(null);
  const [measurement,setMeasurement]=useState(preferredExperimentId??'');
  // A notice shows where its action was taken: 'form', 'list' or a test id.
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState<{at:string;text:string;error:boolean}|null>(null);
  const [pending,setPending]=useState<{at:string;text:string}|null>(null);
  const lock=useRef(false),loads=useRef(0),section=useRef<HTMLElement>(null),scrolled=useRef(false),stopFollow=useRef<()=>void>(()=>{});
  const active=useRef(true),detailLoads=useRef<Record<string,number>>({});
  const focusAt=useRef<string|null>(null);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);

  async function request(path:string,init?:{method:string;body?:unknown}){
    if(!active.current)throw Error('This site view was closed.');
    return fetch(endpoint+path,{method:init?.method??'GET',credentials:'same-origin',cache:'no-store',
      headers:init?.body===undefined?{}:{'content-type':'application/json'},body:init?.body===undefined?undefined:JSON.stringify(init.body)});
  }
  /** The record and the events of one test. A failure is shown in that test only. */
  async function loadDetail(id:string){
    const ticket=(detailLoads.current[id]??0)+1;detailLoads.current[id]=ticket;
    let value:Detail|{error:string};
    try{
      const response=await request('/'+id);
      value=response.ok?await response.json() as Detail:{error:(await failure(response,'Could not read this A/B test.')).message};
    }catch{value={error:'Could not read this A/B test. Retry.'};}
    if(active.current&&detailLoads.current[id]===ticket)setDetails(old=>({...old,[id]:value}));
  }
  async function load(){
    const ticket=++loads.current;
    try{
      const response=await request('');
      if(!response.ok)throw await failure(response,'Could not load A/B tests.');
      const next=await response.json() as Listing;
      // A slower earlier load never replaces a newer one, including a late error after a successful reload.
      if(!active.current||ticket!==loads.current)return;
      setData(next);setLoadError('');
      setTraffic(old=>old===''?String(next.defaults.trafficBPercent):old);
      if(next.current&&next.versions.some(version=>version.id===next.current&&version.state!=='unavailable'))setA(old=>old||next.current!);
      setMeasurement(current=>next.tests.some(test=>test.id===current)?current:'');
      for(const test of next.tests)void loadDetail(test.id);
    }catch(error){
      if(active.current&&ticket===loads.current)throw error;
    }
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
  async function run(at:string,fn:()=>Promise<string|{at:string;text:string}|void>,working:string){
    if(lock.current)return;lock.current=true;setBusy(true);setNotice(null);setPending({at,text:working});
    try{const done=await fn();if(done)setNotice(typeof done==='string'?{at,text:done,error:false}:{...done,error:false});}
    catch(e){setNotice({at,text:e instanceof Error?e.message:'The A/B test action failed. Retry.',error:true});}
    finally{lock.current=false;focusAt.current=at;setBusy(false);setPending(null);}
  }
  // A busy action disables the button that started it, so the browser drops focus to <body>. When it has, move focus to
  // the outcome where the action was taken: its notice, or the check result.
  useEffect(()=>{
    const at=focusAt.current;
    if(busy||at===null)return;
    focusAt.current=null;
    if(document.activeElement&&document.activeElement!==document.body)return;
    section.current?.querySelector<HTMLElement>(`[data-focus-at="${CSS.escape(at)}"]`)?.focus();
  },[busy]);
  const noticeAt=(at:string)=>pending?.at===at?<p className="ab-tests-status" role="status">{pending.text}</p>:notice?.at!==at?null:notice.error?<p role="alert" className="runtime-error" tabIndex={-1} data-focus-at={at}>{notice.text}</p>
    :<p className="ab-tests-status" role="status" tabIndex={-1} data-focus-at={at}>{notice.text}</p>;
  const pair=`${a}|${b}`,trafficValue=/^\d{1,3}$/.test(traffic)&&Number(traffic)<=100?Number(traffic):null;
  const checked=result?.pair===pair?result.check:null;
  const available=(id:string)=>Boolean(data?.versions.some(version=>version.id===id&&version.state!=='unavailable'));
  const canSave=Boolean(checked?.compatible&&available(a)&&available(b)&&name.trim()&&TEST_ID.test(testId)&&trafficValue!==null);
  async function check(){
    const response=await request('/check',{method:'POST',body:{a,b,...(!testOnly?{reportingKey:'VersionId'}:{})}});
    if(!response.ok)throw await failure(response,'Could not check these versions.');
    setResult({pair,check:await response.json() as CheckResult});
  }
  async function create(){
    // An uncertain response may follow a committed save. Keep this exact TestId for an idempotent retry.
    setTestIdEdited(true);
    const response=await request('',{method:'POST',body:{name:name.trim(),testId,a,b,trafficBPercent:trafficValue,...(!testOnly?{reportingKey:'VersionId'}:{})}});
    // Reload saved state after a refusal while preserving every submitted value.
    if(!response.ok){const problem=await failure(response,'Could not save the A/B test.');await load().catch(()=>{});throw problem;}
    const saved=await response.json() as {created:boolean;deletedAt?:string|null;record:{name:string;id?:string}};
    // A new test starts from an empty name, the next proposed TestId and a new check.
    if(saved.created){setName('');setTestIdEdited(false);setResult(null);}
    await load();
    if(workspace&&saved.record.id)setMeasurement(saved.record.id);
    return saved.created?`A/B test "${saved.record.name}" saved. ${workspace?'Download its ZIP in Saved A/B tests.':'Download its ZIP below.'}`
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
      ?`Mark "${test.name}" live? This records that the test started on your site now. It does not publish or change any file. Finish the GAM setup checklist first.`
      :`Mark "${test.name}" stopped? This records that the test stopped on your site now. It does not change any file. ${STOP_TEST}`;
    if(!window.confirm(question))return;
    const response=await request(`/${test.id}/events`,{method:'POST',body:{type}});
    if(!response.ok){const problem=await failure(response,'Could not record this change.');await load();throw problem;}
    await loadDetail(test.id);
    return `${test.name}: marked ${type==='marked-live'?'live':'stopped'}.`;
  }
  async function trash(test:Summary,remove:boolean){
    // Delete only hides the test here; a test marked live keeps running on the site until it is stopped there.
    const detail=details[test.id],live=detail&&'events' in detail&&detail.events.at(-1)?.type==='marked-live';
    if(remove&&!window.confirm(`Delete A/B test "${test.name}"? It moves to Deleted A/B tests. Its files and Version ID ${test.testId} are kept, so you can restore it.`
      +(live?' This test is marked live. Deleting it does not stop it on your site.':'')))return;
    const response=await request('/'+test.id,{method:remove?'DELETE':'PUT',body:{confirmId:test.id,sha256:test.zipSha256}});
    if(!response.ok)throw await failure(response,remove?'Could not delete the A/B test.':'Could not restore the A/B test.');
    await load();
    return remove?{at:'list',text:`${test.name}: moved to Deleted A/B tests.`}:{at:test.id,text:`${test.name}: restored.`};
  }

  const versions=data?.versions??[],known=new Set(versions.map(v=>v.id)),availableVersions=versions.filter(version=>version.state!=='unavailable');
  async function sourceSaved(id:string){await load();if(!active.current)return;setA(current=>current||id);if(a)setB(current=>current||id);}
  async function originalsSaved(aId:string,bId:string){await load();if(!active.current)return;setA(aId);setB(bId);setResult(null);}
  function sourceDescription(id:string){const version=versions.find(value=>value.id===id);if(!version)return null;
    if(version.sourceKind==='original-script')return <p className="ab-tests-selected-source"><strong>{version.name}</strong> · Original saved file · Uses the existing page’s Prebid and GPT setup{version.state==='unavailable'?<span className="runtime-error"> · {version.unavailableReason}</span>:null}</p>;
    const notice=runtimeNotice(version);return <p className="ab-tests-selected-source"><strong>{version.name}</strong> · script {version.runtimeVersion?runtimeLabel(version.runtimeVersion):'Unavailable'}{runtimeNoticeSuffix(version)}{version.prebidVersion?` · Prebid ${version.prebidVersion}`:' · GAM only'}{version.state==='unavailable'?<span className="runtime-error"> · {version.unavailableReason||'This source is unavailable.'}</span>:notice?<span> · {notice.warning}</span>:null}</p>;}
  const options=(selected:string)=><>
    <option value="">Choose a saved version</option>
    {selected&&!known.has(selected)?<option value={selected}>{short(selected)} · no longer in Saved versions</option>:null}
    {versions.map(v=><option key={v.id} value={v.id} disabled={v.state==='unavailable'}>{`${v.name} · ${v.sourceKind==='original-script'?'Original file':`${v.runtimeVersion?runtimeLabel(v.runtimeVersion):'Unavailable'}${runtimeNoticeSuffix(v)}`} · ${when(v.createdAt)} · ${short(v.id)}${v.state==='unavailable'?' · unavailable':''}`}</option>)}
  </>;
  const armLine=(side:'A'|'B',arm:Arm)=><div key={side}><dt>Version {side}</dt><dd>
    <span className="ab-tests-name">{arm.name}</span> · {arm.runtimeVersion} · {short(arm.release)}
    {versions.find(version=>version.id===arm.release)?.state==='unavailable'?<span className="ab-tests-tag"> (source unavailable; this test keeps its own copy)</span>:known.has(arm.release)?null:<span className="ab-tests-tag"> (no longer in Saved versions; this test keeps its own copy)</span>}</dd></div>;


  const createForm=data?<>
    <form className="ab-tests-form" aria-labelledby="ab-tests-new" onSubmit={e=>{e.preventDefault();if(canSave)void run('form',create,'Saving A/B test…');}}>
      <h3 id="ab-tests-new">New A/B test</h3>
      {data.current?null:<p className="ab-tests-note">{testOnly?'This site has no production version on TEST. Choose A yourself: use the version your test page runs now.':'No saved built-in production version is available for this site. Choose A yourself and confirm that it matches the version currently running on your site.'}</p>}
      {!availableVersions.length?<p>{workspace?'Save a script version above to enable these A/B choices.':'Generate and save a version first. An A/B test compares two saved versions.'}</p>:null}
      <div className="ab-tests-fields">
        <div className="ab-tests-field"><label htmlFor="ab-test-name">Test name</label>
          <input id="ab-test-name" required maxLength={data.limits.name} value={name} disabled={busy} onChange={e=>setName(e.target.value)} placeholder="For example: Bid cache on"/></div>
        <div className="ab-tests-field"><label htmlFor="ab-test-id">Version ID</label>
          <input id="ab-test-id" required maxLength={24} pattern="[a-z0-9_]{1,24}" value={testId} disabled={busy} aria-describedby="ab-test-id-help"
            onChange={e=>{setTestId(e.target.value);setTestIdEdited(true);}}/>
          <p id="ab-test-id-help" className="ab-tests-help">Tessera suggests this package ID automatically. It identifies the package alongside Variant A or B and stays reserved on this site. {testOnly?'Packages in this TEST workspace use the GAM key TestId.':'New packages use the GAM key VersionId; earlier packages keep TestId.'} Use lowercase letters, digits and _.</p></div>
        <div className="ab-tests-field"><label htmlFor="ab-version-a">Version A</label>
          <select id="ab-version-a" value={a} disabled={busy||!availableVersions.length} aria-describedby={data.current&&a===data.current?'ab-version-a-current':undefined} onChange={e=>setA(e.target.value)}>{options(a)}</select>
          {data.current&&a===data.current?<p id="ab-version-a-current" className="ab-tests-help">Current Tessera production version</p>:null}{workspace?sourceDescription(a):null}</div>
        <div className="ab-tests-field"><label htmlFor="ab-version-b">Version B</label>
          <select id="ab-version-b" value={b} disabled={busy||!availableVersions.length} onChange={e=>setB(e.target.value)}>{options(b)}</select>{workspace?sourceDescription(b):null}</div>
        <div className="ab-tests-field"><label htmlFor="ab-traffic">Traffic to B (%)</label>
          <input id="ab-traffic" type="number" required min={0} max={100} step={1} inputMode="numeric" value={traffic} disabled={busy} aria-describedby="ab-traffic-split"
            onChange={e=>setTraffic(e.target.value)}/>
          <p id="ab-traffic-split" className="ab-tests-help">{trafficValue===null?'Use a whole number from 0 to 100.':`A: ${100-trafficValue}% · B: ${trafficValue}%`}</p></div>
      </div>
      {a&&a===b?<p className="ab-tests-note">A/A check: both groups get the same version.</p>:null}
      <p className="ab-tests-help">The test name, the Version ID and both script version names are published inside /ads.js. Do not use private notes.</p>
      <div className="runtime-actions">
        <button type="button" disabled={busy||!available(a)||!available(b)} onClick={()=>void run('form',check,'Checking compatibility…')}>Check compatibility</button>
        <button type="submit" disabled={busy||!canSave}>Save A/B test</button>
      </div>
      {noticeAt('form')}
      {checked?<div className="ab-tests-result">
        <p className={checked.compatible?'ab-tests-status':'ab-tests-status ab-tests-refused'} role="status" tabIndex={-1} data-focus-at="form">
          {checked.compatible?'Compatible. These versions can be compared.':`Not compatible: ${checked.refusal?.message??'These versions cannot be compared.'}`}</p>
        {checked.compatible&&!canSave?<p className="ab-tests-help">{!name.trim()?'Enter a test name to save.'
          :!TEST_ID.test(testId)?'Use 1 to 24 lowercase letters, digits or _ in the Version ID to save.':'Use a whole number from 0 to 100 for traffic to save.'}</p>:null}
        {checked.warnings.length?<ul className="ab-tests-warnings">{checked.warnings.map(w=><li key={w.code}>{w.message}</li>)}</ul>:null}
        {checked.configDiff?<><h4>Summary of differences</h4>{checked.configDiff.length?<>
          <div className="ab-tests-diff"><table><thead><tr><th scope="col">Setting</th><th scope="col">A</th><th scope="col">B</th></tr></thead>
            <tbody>{checked.configDiff.map(row=><tr key={row.field}><th scope="row">{FIELD_LABELS[row.field]??row.field}<code>{row.field}</code></th>
              <td data-label="A"><code>{cell(row.field,row.a)}</code></td><td data-label="B"><code>{cell(row.field,row.b)}</code></td></tr>)}</tbody></table></div>
          {checked.configDiff.some(row=>LIST_FIELDS.has(row.field))?<p className="ab-tests-help">For lists, each side shows only what it has and the other version does not.</p>:null}
        </>:<p>No differences in the compared settings.</p>}</>:null}
      </div>:null}
    </form>
  </>:null;
  const savedTests=data?<>
    <h3>Saved A/B tests</h3>
    {workspace?<details className="ab-tests-installation"><summary>Deploy and stop an A/B test</summary>
    <p className="ab-tests-help">Tessera includes the loader in the ZIP as /ads.js. It selects A or B using the saved traffic split and loads that test's script. There is no separate loader to configure.</p>
    <p className="ab-tests-help">Download the A/B ZIP and upload all of its files, unchanged, as one Pages deployment at your existing script URL. Saving or downloading a test does not publish it.</p>
    <p className="ab-tests-help">Follow the saved package's installation instructions and keep the approved CMP and GPT setup. For Prebid-enabled versions, load the bundle's verified shared prebid.js before /ads.js; GAM-only bundles do not need Prebid. An older pilot may have loaded Prebid itself, so check the page setup before replacing it.</p>
    <p className="ab-tests-help">Mark live and Mark stopped only record what you have done on your site; they do not publish or stop delivery.</p>
    <p className="ab-tests-help">{STOP_TEST}</p>
    </details>:<>
    <p className="ab-tests-help">Tessera includes the loader in the ZIP as /ads.js. It selects A or B using the saved traffic split and loads that test's script. There is no separate loader to configure.</p>
    <p className="ab-tests-help">Download the A/B ZIP and upload all of its files, unchanged, as one Pages deployment at your existing script URL. Saving or downloading a test does not publish it.</p>
    <p className="ab-tests-help">Follow the saved package's installation instructions and keep the approved CMP and GPT setup. For Prebid-enabled versions, load the bundle's verified shared prebid.js before /ads.js; GAM-only bundles do not need Prebid. An older pilot may have loaded Prebid itself, so check the page setup before replacing it.</p>
    <p className="ab-tests-help">Mark live and Mark stopped only record what you have done on your site; they do not publish or stop delivery.</p>
    <p className="ab-tests-help">{STOP_TEST}</p>
    </>}
    {noticeAt('list')}
    {!data.tests.length?<p>{workspace?'No A/B packages saved yet. Earlier packages are listed below.':'No A/B tests saved yet.'}</p>:data.tests.map(test=>{
      const detail=details[test.id],loaded=detail&&'record' in detail?detail:null,last=loaded?.events.at(-1);
      const identityKey=loaded?(['1.2.0','1.3.0'].includes(loaded.record.loader?.version??'')?'VersionId':'TestId'):undefined;
      return <article key={test.id} className="ab-tests-item" aria-label={`A/B test: ${test.name}`}>
        <h4 className="ab-tests-name">{test.name}</h4>
        <p>Version ID <code>{test.testId}</code> · B {test.trafficBPercent}% · saved {when(test.createdAt)} by <span className="ab-tests-name">{test.createdBy}</span>{identityKey?<> · GAM key <code>{identityKey}</code></>:null}</p>
        <dl className="ab-tests-arms">{armLine('A',test.arms.A)}{armLine('B',test.arms.B)}</dl>
        {workspace&&loaded?.record.loader?<p>Saved loader <strong>{loaded.record.loader.version}</strong></p>:null}
        {detail&&'error' in detail?<p role="alert" className="runtime-error">{detail.error} <button disabled={busy} onClick={()=>void loadDetail(test.id)}>Retry</button></p>:null}
        {detail&&'error' in detail?null:<p>{!loaded?'Reading live and stopped marks…':!last?'Not marked live yet.':last.type==='marked-live'?`Marked live ${when(last.at)}.`:`Marked stopped ${when(last.at)}.`}</p>}
        <div className="runtime-actions">
          <button disabled={busy} onClick={()=>void run(test.id,()=>download(test),'Downloading and checking A/B ZIP…')}>Download A/B ZIP</button>
          <button disabled={busy} onClick={()=>void run(test.id,()=>downloadRecord(test),'Downloading and checking test record…')}>Download test record</button>
          <button disabled={busy||!loaded||last?.type==='marked-live'} onClick={()=>void run(test.id,()=>mark(test,'marked-live'),'Recording live mark…')}>Mark live</button>
          <button disabled={busy||!loaded||last?.type!=='marked-live'} onClick={()=>void run(test.id,()=>mark(test,'marked-stopped'),'Recording stopped mark…')}>Mark stopped</button>
          <button disabled={busy} onClick={()=>void run(test.id,()=>trash(test,true),'Moving A/B test to Deleted A/B tests…')}>Delete test</button>
        </div>
        {noticeAt(test.id)}
        {loaded?.events.length?<ul className="ab-tests-events">{loaded.events.map(event=><li key={event.seq}>
          {event.type==='marked-live'?'Marked live':'Marked stopped'} {when(event.at)} by <span className="ab-tests-name">{event.by}</span></li>)}</ul>:null}
        <details><summary>GAM setup checklist</summary><ol>
          <li>Key <code>Variant</code> with the values <code>A</code> and <code>B</code>.</li>
          <li>{identityKey?<>Key <code>{identityKey}</code> with the Version ID value <code>{test.testId}</code>.</>:'Reading the saved package’s GAM identity key…'}</li>
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
        {workspace?<><button type="button" disabled={busy||!loaded} onClick={()=>setMeasurement(current=>current===test.id?'':test.id)}>{measurement===test.id?'Close GAM report':'Review GAM report'}</button>{measurement===test.id&&identityKey?<AbMeasurementPanel key={test.id} endpoint={`${endpoint}/${test.id}/measurement/plans`} experimentId={test.id} testId={test.testId} identityKey={identityKey} disabled={busy} expanded/>:null}</>:onOpenMeasurement?<button type="button" disabled={busy} onClick={()=>onOpenMeasurement(test.id)}>Open measurement</button>
          :identityKey?<AbMeasurementPanel endpoint={`${endpoint}/${test.id}/measurement/plans`} experimentId={test.id} testId={test.testId} identityKey={identityKey} disabled={busy}/>:null}
      </article>;
    })}
  </>:null;
  return <section id="ab-tests" ref={section} className="site-runtime-panel ab-tests-panel" aria-labelledby="ab-tests-title" data-ab-busy={busy?true:undefined}>
    {workspace?<header className="ab-tests-heading">
      <h2 id="ab-tests-title">A/B tests</h2>
      <a className="button secondary ab-tests-create" href={availableVersions.length<2?'#ab-source-versions':'#ab-tests-new'}>Create A/B test</a>
    </header>:<h2 id="ab-tests-title">A/B tests</h2>}
    <p>Compare two saved versions on your site. Each page view gets version A or version B. A saved test never changes.</p>
    {workspace?<>{savedTests}{history}<AbSourceVersionsPanel publisherId={publisherId} siteName={siteName??publisherId} availableVersions={data?availableVersions.length:null} disabled={busy} onSaved={sourceSaved} onOriginalsSaved={originalsSaved} onReload={load}/></>:null}
    {loadError?<p role="alert" className="runtime-error">{loadError} <button onClick={()=>setAttempt(n=>n+1)}>Reload A/B tests</button></p>
    :!data?<p className="ab-tests-status" role="status">Loading A/B tests…</p>:<>
    {!workspace&&onOpenMeasurement?<div className="ab-tests-note"><p>Create and measure A/B tests in the site's Measurement workspace.</p><button type="button" onClick={()=>onOpenMeasurement()}>Create A/B test in Measurement</button></div>:createForm}

    {!workspace?savedTests:null}

    {data.deleted.length?<details className="ab-tests-deleted"><summary>Deleted A/B tests</summary>
      <p className="ab-tests-help">Deleted tests keep their files and their Version ID. Restore a test to download or mark it again.</p>
      {data.deleted.map(test=><article key={test.id} className="ab-tests-item" aria-label={`Deleted A/B test: ${test.name}`}>
        <h4 className="ab-tests-name">{test.name}</h4>
        <p>Version ID <code>{test.testId}</code> · deleted {test.deletedAt?when(test.deletedAt):''}</p>
        <div className="runtime-actions"><button disabled={busy} onClick={()=>void run(test.id,()=>trash(test,false),'Restoring A/B test…')}>Restore</button></div>{noticeAt(test.id)}
      </article>)}
    </details>:null}
    </>}
  </section>;
}
