import { useEffect, useMemo, useRef, useState } from 'react';

type CatalogKey = {key:string;type:string;reportableType:string;values:string[];openDomain:boolean};
type Catalog = {schemaVersion:number;profile:string;keys:CatalogKey[]};
type Pick = {enabled:boolean;values:string[];extra:string};
type Outcome = 'created'|'existing'|'updated'|'new'|'update'|'unverified'|'blocked'|'conflict'|'pending';
type ValueResult = {name:string;id?:string;state:string;outcome:Outcome;message?:string;reconciled?:boolean};
type KeyResult = {key:string;id?:string;state:string;outcome:Outcome;message?:string;reconciled?:boolean;reportableType?:string;values:ValueResult[]};
type Counts = {total:number;done?:number;created:number;existing:number;new:number;update?:number;conflict:number;unverified?:number;blocked?:number};
type OutcomeCounts = Record<Outcome,number>&{total:number};
type Job = {
  id:string;mode:string;status:string;cursor:number;network:{networkCode:string;name:string};phase:string;
  updatedAt:string;offset:number;phaseTotal:number;counts:Record<string,Counts>;error:string;awaitingCheck:boolean;retryAfter:number;canStart?:boolean;resumed?:boolean;
  conflictCount:number;verificationCount?:number;unverifiedCount?:number;blockedCount?:number;
  canClosePreview?:boolean;
  executionAllowed?:boolean;readOnlyReason?:string;
  conflicts:{ref:string;message:string}[];verificationIssues?:{ref:string;message:string}[];
  reporting?:{writePolicy?:string;keyCount:number;valueCount:number;needsUpdate:number;keys:{key:string;valueCount:number;openDomain:boolean;type:string}[];
    results?:KeyResult[];outcomes?:{keys:OutcomeCounts;values:OutcomeCounts};reviewProgress?:{processed:number;total:number}};
};
type History = {id:string;mode:string;name:string;status:string;createdAt:string;updatedAt?:string};
type ActiveJob = {id:string;mode:string;status:string;phase:string;network:{networkCode:string;name:string};counts:Record<string,Counts>;awaitingCheck:boolean;canClosePreview?:boolean;cursor?:number};
const descriptions:Record<string,string> = {
  aq_bid_origin:'Poreklo glavnog bida poslatog GAM-u: svež, keširan ili bez bida.',
  aq_first_request:'Vreme od otvaranja stranice do prvog GAM zahteva.',
  aq_consent_wait:'Vreme čekanja na CMP odluku; timeout označava prekoračen podešeni rok.',
  aq_timed_out:'Da li je aukcija dostigla svoj rok čekanja.',
  aq_bid_count:'Broj raspoloživih bidova u aukciji.',
  aq_bidder_count:'Broj biddera sa raspoloživim bidom.',
  refresh_count:'Redni broj osvežavanja oglasa.',
  refresh_bucket:'Prvo prikazivanje i grupe osvežavanja.',
  refresh_interval:'Interval osvežavanja u sekundama.',
  refresh_policy:'Putanja zahteva: početni, nova aukcija ili fallback.',
  geo_country:'Oznaka države, na primer RS. Izaberi samo potrebne države.',
  Variant:'A ili B krak eksperimenta.',
};
const outcomeNames:Record<Outcome,string> = {
  created:'Kreirano',existing:'Već postoji',updated:'Reporting dopunjen',new:'Nedostaje',update:'Reporting za dopunu',
  unverified:'Nije potvrđeno',blocked:'Čeka prethodni korak',conflict:'Konflikt',pending:'Čeka proveru',
};
const statusNames:Record<string,string> = {reviewing:'Provera je u toku',ready:'Provera je završena — spremno za potvrdu',creating:'Priprema je u toku',completed:'Priprema je završena',cancelled:'Posao je zaustavljen'};
const newLabels = new Set(['aq_bid_origin','aq_first_request','aq_consent_wait']);
const issues = (j:Job) => Boolean(j.conflictCount||j.verificationCount||j.unverifiedCount||j.blockedCount);
const completed = (j:Job) => j.status==='completed'&&!j.awaitingCheck&&!j.error&&!issues(j);
const addOnly = (j:Job) => j.mode==='reporting'&&j.reporting?.writePolicy==='add_only'&&j.executionAllowed===true;
const closable = (j:ActiveJob) => j.canClosePreview===true&&!j.awaitingCheck&&['reviewing','ready'].includes(j.status)&&Object.values(j.counts).every(count=>count.created===0);
const freshPicks = (catalog:Catalog, enabled:(key:string)=>boolean=()=>true):Record<string,Pick> =>
  Object.fromEntries(catalog.keys.map(key=>[key.key,{enabled:enabled(key.key),values:[...key.values],extra:''}]));

function valuesFor(key:CatalogKey,pick:Pick):string[] {
  const extra=pick.extra.trim()?pick.extra.trim().split(/[\s,;]+/).filter(Boolean):[];
  if(extra.length&&!key.openDomain)throw Error(`Dodatne vrednosti nisu podržane za ${key.key}.`);
  const values=[...pick.values,...extra].map(value=>{
    if(!key.openDomain)return value;
    if(key.key==='refresh_interval'&&['initial','unscheduled'].includes(value.toLowerCase()))return value.toLowerCase();
    const number=Number(value);
    if(!/^(0|[1-9]\d{0,15})(?:\.\d{1,6})?$/.test(value)||!Number.isFinite(number)||number>Number.MAX_SAFE_INTEGER||
      (key.key==='refresh_interval'?number<=0:!Number.isSafeInteger(number)))
      throw Error(`${key.key}: unesite ${key.key==='refresh_interval'?'pozitivne sekunde':'nenegativne cele brojeve'}, odvojene zarezom ili novim redom.`);
    return String(number);
  });
  const unique=[...new Set(values)];
  if(unique.length>1000)throw Error(`${key.key}: najviše 1.000 izabranih vrednosti.`);
  return unique;
}

export default function GamKeyValuesPanel({endpoint,connections,network,onNetworkChange,onRunning}:{
  endpoint:string;connections:{networkCode:string;name:string}[];network:string;onNetworkChange:(s:string)=>void;
  onRunning:(b:boolean)=>void;
}) {
  const [catalog,setCatalog]=useState<Catalog|null>(null),[picks,setPicks]=useState<Record<string,Pick>|null>(null);
  const [catalogLoading,setCatalogLoading]=useState(true),[catalogError,setCatalogError]=useState('');
  const [job,setJob]=useState<Job|null>(null),[history,setHistory]=useState<History[]>([]),[historyError,setHistoryError]=useState('');
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[confirmed,setConfirmed]=useState(false),[activeJobId,setActiveJobId]=useState('');
  const [activeJob,setActiveJob]=useState<ActiveJob|null>(null),[closeConfirmed,setCloseConfirmed]=useState(false),[notice,setNotice]=useState('');
  const [queries,setQueries]=useState<Record<string,string>>({});
  const alive=useRef(true),working=useRef(false),stop=useRef(false),generation=useRef(0),statusRef=useRef<HTMLElement|null>(null);
  const active=connections.find(connection=>connection.networkCode===network);
  const creating=job?.status==='creating',locked=Boolean(busy)||creating;

  async function api<T>(path:string,body?:unknown):Promise<T> {
    const response=await fetch(endpoint+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json() as T&{error?:string;activeJobId?:string;activeJob?:ActiveJob};
    if(!response.ok){
      if(value.activeJobId&&alive.current)setActiveJobId(value.activeJobId);
      if(value.activeJob&&alive.current){setActiveJob(value.activeJob);setCloseConfirmed(false);}
      throw Error(value.error||'Zahtev nije uspeo. Proverite sačuvano stanje posla.');
    }
    return value;
  }
  async function loadCatalog() {
    setCatalogLoading(true);setCatalogError('');
    try {
      const next=await api<Catalog>('/key-values/catalog');
      if(alive.current){setCatalog(next);setPicks(current=>current??freshPicks(next));}
    } catch(e){if(alive.current)setCatalogError((e as Error).message);}
    finally {if(alive.current)setCatalogLoading(false);}
  }
  async function loadHistory() {
    if(!network)return;
    const current=generation.current;
    const response=await api<{jobs:History[]}>('/line-items/jobs?network='+encodeURIComponent(network));
    if(alive.current&&generation.current===current){setHistory(response.jobs.filter(item=>item.mode==='reporting'));setHistoryError('');}
  }
  useEffect(()=>{alive.current=true;void loadCatalog();return()=>{alive.current=false;stop.current=true;};},[endpoint]);
  useEffect(()=>{
    generation.current++;stop.current=true;setJob(null);setConfirmed(false);setError('');setActiveJobId('');setActiveJob(null);setCloseConfirmed(false);setNotice('');setHistory([]);setHistoryError('');
    if(network)void loadHistory().catch(e=>{if(alive.current)setHistoryError((e as Error).message);});
  },[network,endpoint]);
  useEffect(()=>{
    if(!catalog||job?.mode!=='reporting'||!job.reporting?.results)return;
    setPicks(Object.fromEntries(catalog.keys.map(key=>{
      const result=job.reporting?.results?.find(item=>item.key===key.key);
      const values=result?.values.map(value=>value.name)??[];
      return [key.key,{enabled:Boolean(result),values:values.filter(value=>key.values.includes(value)),extra:values.filter(value=>!key.values.includes(value)).join(', ')}];
    })));
  },[catalog,job?.id]);

  const selection=useMemo(()=>{
    try {
      const rows=(catalog?.keys??[]).filter(key=>picks?.[key.key]?.enabled).map(key=>({key:key.key,values:valuesFor(key,picks![key.key])}));
      const valueCount=rows.reduce((sum,key)=>sum+key.values.length,0);
      if(valueCount>4000)throw Error('Najviše 4.000 izabranih vrednosti u jednom poslu.');
      return {rows,valueCount,error:''};
    }catch(e){return {rows:[],valueCount:0,error:(e as Error).message};}
  },[catalog,picks]);
  function change(key:string,patch:Partial<Pick>) {
    setPicks(current=>current?{...current,[key]:{...current[key],...patch}}:current);
    setJob(null);setConfirmed(false);setError('');setActiveJobId('');setCloseConfirmed(false);setNotice('');
  }
  function selectPreset(kind:'all'|'none'|'new') {
    if(!catalog)return;
    setPicks(kind==='none'?Object.fromEntries(Object.entries(picks??freshPicks(catalog)).map(([key,pick])=>[key,{...pick,enabled:false}])):
      freshPicks(catalog,kind==='new'?key=>newLabels.has(key):()=>true));
    setJob(null);setConfirmed(false);setError('');setActiveJobId('');setCloseConfirmed(false);setNotice('');
  }
  async function run(label:string,action:()=>Promise<void>) {
    if(working.current)return;
    working.current=true;stop.current=false;setBusy(label);onRunning(true);setError('');setNotice('');
    statusRef.current?.focus({preventScroll:true});
    statusRef.current?.scrollIntoView({behavior:'instant',block:'start'});
    try{await action();}
    catch(e){if(alive.current)setError((e as Error).message);}
    finally{
      working.current=false;
      if(alive.current){setBusy('');onRunning(false);void loadHistory().catch(e=>{if(alive.current)setHistoryError((e as Error).message);});}
    }
  }
  async function walk(initial:Job) {
    let next=initial;
    if(next.mode!=='reporting'){if(alive.current){setActiveJob(next);setActiveJobId(next.id);setJob(null);}return next;}
    if(alive.current)setJob(next);
    if(!addOnly(next))return next;
    while(alive.current&&!stop.current&&['reviewing','creating'].includes(next.status)&&!next.awaitingCheck&&!issues(next)&&!next.error){
      next=await api<Job>(`/line-items/jobs/${next.id}/${next.status==='reviewing'?'review':'step'}`,{cursor:next.cursor});
      if(next.mode!=='reporting'){if(alive.current){setActiveJob(next);setActiveJobId(next.id);setJob(null);}return next;}
      if(alive.current)setJob(next);
      if(!addOnly(next))return next;
    }
    return next;
  }
  async function preview() {
    await run('Proveravam izabrane ključeve i vrednosti u GAM-u',async()=>{
      setJob(null);setConfirmed(false);
      setActiveJob(null);setActiveJobId('');setCloseConfirmed(false);
      const next=await api<Job>('/line-items/preview',{mode:'reporting',networkCode:network,reportingSelection:selection.rows,reportingWritePolicy:'add_only'});
      if(next.mode!=='reporting'){if(alive.current){setActiveJob(next);setActiveJobId(next.id);}return;}
      if(alive.current){setJob(next);statusRef.current?.scrollIntoView({behavior:'instant',block:'start'});}
      if(!next.resumed)await walk(next);
    });
  }
  async function open(id:string) {
    await run('Učitavam sačuvani posao',async()=>{
      setJob(null);setConfirmed(false);
      const next=await api<Job>('/line-items/jobs/'+id);
      if(next.mode!=='reporting'){if(alive.current){setActiveJob(next);setActiveJobId(next.id);setCloseConfirmed(false);}return;}
      if(alive.current){setJob(next);setConfirmed(false);setActiveJob(null);setActiveJobId('');setCloseConfirmed(false);}
    });
  }
  async function inspectActive(id:string) {
    await run('Učitavam aktivni posao bez izmene',async()=>{
      const current=await api<Job>('/line-items/jobs/'+id);
      if(alive.current){setActiveJob(current);setActiveJobId(current.id);setCloseConfirmed(false);}
    });
  }
  async function recheck() {
    if(!job||!addOnly(job))return;
    await run('Ponavljam proveru bez upisa u GAM',async()=>{setConfirmed(false);await walk(await api<Job>(`/line-items/jobs/${job.id}/review`,{cursor:job.cursor,retry:true}));});
  }
  async function start() {
    if(!job||!addOnly(job)||!confirmed||!job.canStart)return;
    await run('Pripremam potvrđene ključeve i vrednosti',async()=>{await walk(await api<Job>(`/line-items/jobs/${job.id}/start`,{confirm:true,confirmNetwork:job.network.networkCode}));});
  }
  async function check() {
    if(!job||job.mode!=='reporting')return;
    await run('Proveravam ishod prethodnog upisa u GAM-u',async()=>{
      const next=await api<Job>(`/line-items/jobs/${job.id}/check`,{cursor:job.cursor});if(alive.current){if(next.mode==='reporting')setJob(next);else{setActiveJob(next);setJob(null);}}
    });
  }
  async function resume() {
    if(!job||!addOnly(job))return;
    await run('Nastavljam sačuvani posao',async()=>{
      const next=await api<Job>('/line-items/jobs/'+job.id);
      if(next.mode!=='reporting'){if(alive.current){setActiveJob(next);setActiveJobId(next.id);setJob(null);}return;}
      if(alive.current)setJob(next);
      if(addOnly(next)&&!next.awaitingCheck)await walk(next);
    });
  }
  async function closePreview(target:ActiveJob) {
    if(!closeConfirmed||!closable(target))return;
    await run('Zatvaram nepočeti Tessera pregled',async()=>{
      const current=await api<Job>('/line-items/jobs/'+target.id);
      if(current.id!==target.id||current.network.networkCode!==target.network.networkCode||!Number.isSafeInteger(current.cursor)||!closable(current)){
        if(alive.current){setActiveJob(current);setActiveJobId(current.id);setJob(null);setConfirmed(false);setCloseConfirmed(false);}
        throw Error('Ovaj pregled više nije moguće bezbedno zatvoriti. GAM stanje nije menjano.');
      }
      await api<Job>(`/line-items/jobs/${current.id}/close-preview`,{confirm:true,confirmNetwork:current.network.networkCode,cursor:current.cursor});
      if(alive.current){setJob(null);setActiveJob(null);setActiveJobId('');setConfirmed(false);setCloseConfirmed(false);setNotice('Nepočeti pregled je zatvoren. GAM ostaje bez izmene. Tvoj izbor je sačuvan; pokreni novu proveru pre dodavanja.');}
    });
  }
  const jobKeys=job?.counts.key,jobValues=job?.counts.value;
  const total=job?.reporting?(job.reporting.keyCount+job.reporting.valueCount):0;
  const done=(jobKeys?.done??((jobKeys?.created??0)+(jobKeys?.existing??0)))+(jobValues?.done??((jobValues?.created??0)+(jobValues?.existing??0)));
  const percent=total?Math.min(100,Math.round(done/total*100)):0;
  const processed=job?.reporting?.reviewProgress?.processed??0;
  const results=job?.reporting?.results??[];
  const keyOutcomes=job?.reporting?.outcomes?.keys,valueOutcomes=job?.reporting?.outcomes?.values;
  const closeTarget=activeJob??(job?.canClosePreview?job:null);
  const legacy=Boolean(job&&!addOnly(job));
  const noNewWrites=Boolean(job&&addOnly(job)&&completed(job)&&keyOutcomes?.created===0&&valueOutcomes?.created===0&&!results.some(key=>key.reconciled||key.values.some(value=>value.reconciled)));
  const displayStatus=catalogLoading?'Učitavam pripremljene ključeve':busy?busy:activeJob?'Ova nova priprema nije pokrenuta':error||job?.error||job&&issues(job)?'Potrebna je provera — posao nije potvrđen':job?.awaitingCheck?'Čeka se potvrda ishoda u GAM-u':legacy&&job&&!['completed','cancelled'].includes(job.status)?'Sačuvani plan je samo za čitanje':job?.status==='completed'&&!completed(job)?'Posao još nije potvrđen':job?statusNames[job.status]||job.status:'Izaberite ključeve za pripremu';

  return <div className="gam-kv" aria-label="Key-values priprema">
    <article className="gam-card gam-kv-intro">
      <span className="gam-step">KEY-VALUES</span><h3>Pripremi ključeve za GAM izveštaje</h3>
      <p>Izaberi pripremljene ključeve i vrednosti koje želiš u ovoj mreži. Pregled proverava postojeće stanje; upis počinje posle tvoje potvrde.</p>
      <p className="gam-message info gam-kv-add-only"><strong>Dodaju se samo nedostajući ključevi i vrednosti; postojeća podešavanja ostaju bez izmene.</strong></p>
      <label>GAM mreža za key-values<select aria-label="GAM mreža za key-values" disabled={locked} value={network} onChange={event=>onNetworkChange(event.target.value)}>
        <option value="">Izaberite mrežu</option>{connections.map(connection=><option key={connection.networkCode} value={connection.networkCode}>{connection.name} · {connection.networkCode}</option>)}
      </select></label>
      {!active&&<p className="gam-message info">Poveži mrežu u kartici GAM povezivanje da proveriš i pripremiš izabrane ključeve.</p>}
    </article>

    <section ref={statusRef} tabIndex={-1} className={'gam-card gam-kv-status '+(!busy&&!error&&job&&completed(job)?'success':error||job?.error||job?.awaitingCheck||job&&issues(job)?'attention':'')} aria-label="Status key-values posla" aria-busy={Boolean(busy)||catalogLoading}>
      <div className="gam-kv-status-heading"><span className={'gam-kv-dot '+(busy||catalogLoading?'working':'')} aria-hidden="true"/><h3 aria-live="polite">{displayStatus}</h3></div>
      {busy&&<p role="status">{busy}… {job?.phase&&<strong>{job.phase}</strong>} Sačekaj završetak ovog koraka.</p>}
      {job&&<>
        <p><strong>{job.network.name} · {job.network.networkCode}</strong><br/><small>Posao: <code>{job.id}</code> · Poslednja potvrda: {new Date(job.updatedAt).toLocaleString('sr-Latn')}</small></p>
        {job.phase&&<p>Trenutna faza: <strong>{job.phase}</strong></p>}
        {job.status==='creating'||completed(job)?<><progress aria-label="Potvrđeni key-values napredak" max={total||1} value={completed(job)?total:done}/><p>{done} od {total} stavki potvrđeno · {completed(job)?100:percent}%</p></>:
          job.status==='reviewing'?<><progress aria-label="Napredak provere key-values" max={total||1} value={Math.min(processed,total)}/><p>Obrađeno u pregledu: {Math.min(processed,total)} od {total} stavki. Ovo je provera postojećeg stanja, pre upisa.</p></>:
          <p>{job.reporting?.keyCount??jobKeys?.total??0} ključeva · {job.reporting?.valueCount??jobValues?.total??0} vrednosti u sačuvanom izboru.</p>}
      </>}
      {(error||job?.error)&&<p className="gam-message error" role="alert">{error||job?.error}</p>}
      {notice&&<p className="gam-message success" role="status">{notice}</p>}
      {activeJobId&&!activeJob&&<button type="button" disabled={Boolean(busy)} onClick={()=>void inspectActive(activeJobId)}>Prikaži aktivni posao bez izmene</button>}
      {activeJob&&<article className="gam-kv-blocker" aria-label="Aktivni posao — samo čitanje">
        <h4>Ova nova priprema nije pokrenuta</h4>
        <p>U ovoj mreži postoji drugi sačuvani posao. Njegovo stanje je prikazano samo za čitanje.</p>
        <dl><div><dt>Mreža</dt><dd>{activeJob.network.name} · {activeJob.network.networkCode}</dd></div><div><dt>Posao</dt><dd><code>{activeJob.id}</code></dd></div><div><dt>Vrsta</dt><dd>{activeJob.mode==='reporting'?'Key-values':activeJob.mode==='prebid'?'Prebid postavka':'Line item'}</dd></div><div><dt>Status</dt><dd>{statusNames[activeJob.status]||activeJob.status}</dd></div>{activeJob.phase&&<div><dt>Faza</dt><dd>{activeJob.phase}</dd></div>}</dl>
        <div className="gam-table-wrap"><table><thead><tr><th scope="col">Stavke</th><th scope="col">Potvrđeno</th><th scope="col">Preostalo</th></tr></thead><tbody>{Object.entries(activeJob.counts).filter(([,count])=>count.total>0).map(([kind,count])=>{
          const verified=count.done??count.existing+count.created;
          return <tr key={kind}><td>{{advertiser:'Advertiser',order:'Orderi',key:'Ključevi',value:'Vrednosti',creative:'Kreativi',lineItem:'Line itemi',association:'Veze sa kreativima'}[kind]||kind}</td><td>{verified} / {count.total}</td><td>{Math.max(0,count.total-verified)}</td></tr>;
        })}</tbody></table></div>
        {activeJob.awaitingCheck&&<p className="gam-message info">Ishod ranijeg upisa još nije potvrđen. Ovaj posao se ovde ne nastavlja niti zatvara.</p>}
        {!activeJob.canClosePreview&&!activeJob.awaitingCheck&&<p>Posao se iz ovog prikaza ne nastavlja i ne menja. Zatvaranje je dostupno samo za pregled koji nikada nije pokrenut.</p>}
        <button type="button" disabled={Boolean(busy)} onClick={()=>void inspectActive(activeJob.id)}>Osveži aktivni posao bez izmene</button>
      </article>}
      {job?.awaitingCheck&&<p>Odgovor na prethodni upis nije potvrđen. Prvo proveri ishod; upis se ne ponavlja automatski.</p>}
      {legacy&&<p className="gam-message info">{job?.readOnlyReason||'Ovaj ranije sačuvani plan može menjati postojeća podešavanja i prikazuje se samo za čitanje. Za dodavanje napravi novi pregled sa pravilom „samo dodavanje“.'}</p>}
      {job?.resumed&&<p>Otvoren je ranije sačuvani posao. Prikazani rezultat i potvrda odnose se na njegov sačuvani izbor.</p>}
      {job&&issues(job)&&<div className="gam-kv-issues"><p>Provera nije potpuna: {job.conflictCount} konflikata · {job.verificationCount??0} stavki čeka proveru.</p><ul>{[...job.conflicts,...(job.verificationIssues??[])].slice(0,12).map((issue,index)=><li key={issue.ref+index}><code>{issue.ref}</code>: {issue.message}</li>)}</ul></div>}
      <div className="gam-li-actions">
        {job&&addOnly(job)&&['reviewing','ready'].includes(job.status)&&<button type="button" disabled={Boolean(busy)} onClick={()=>void recheck()}>Ponovi proveru istog posla</button>}
        {job?.status==='creating'&&<><button type="button" disabled={Boolean(busy)} onClick={()=>void open(job.id)}>Osveži stanje posla</button>{job.awaitingCheck||!addOnly(job)?<button type="button" disabled={Boolean(busy)} onClick={()=>void check()}>Proveri ishod u GAM-u</button>:<button type="button" disabled={Boolean(busy)} onClick={()=>void resume()}>Nastavi posao</button>}</>}
        {legacy&&<button type="button" disabled={Boolean(busy)} onClick={()=>{setJob(null);setConfirmed(false);setError('');setNotice('Izbor je sačuvan. Pokreni novi pregled za dodavanje bez izmene postojećih podešavanja.');}}>Pripremi novi pregled samo za dodavanje</button>}
      </div>
      {job?.status==='ready'&&addOnly(job)&&<div className="gam-kv-confirm">
        <p>Pregled je završen. Dodaće se {jobKeys?.new??0} novih ključeva i {jobValues?.new??0} novih vrednosti. Postojeće stavke ostaju bez izmene.</p>
        <label className="gam-confirm"><input type="checkbox" disabled={Boolean(busy)||!job.canStart} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>Potvrđujem dodavanje nedostajućih stavki iz izbora {job.reporting?.keyCount??0} ključeva i {job.reporting?.valueCount??0} vrednosti u GAM mreži {job.network.networkCode}. Postojeća podešavanja ostaju bez izmene.</label>
        <button type="button" className="gam-primary" disabled={Boolean(busy)||!confirmed||!job.canStart} onClick={()=>void start()}>Pokreni pripremu key-values</button>
      </div>}
      {closeTarget&&closable(closeTarget)&&<div className="gam-kv-close-preview"><h4>Zatvori nepočeti pregled</h4><p>Zatvara se samo sačuvani Tessera pregled koji nikada nije pokrenut. U GAM-u se ništa ne kreira, menja ili briše.</p><label className="gam-confirm"><input type="checkbox" disabled={Boolean(busy)} checked={closeConfirmed} onChange={event=>setCloseConfirmed(event.target.checked)}/>Potvrđujem zatvaranje nepočetog pregleda {closeTarget.id} za mrežu {closeTarget.network.networkCode}. GAM ostaje bez izmene.</label><button type="button" disabled={Boolean(busy)||!closeConfirmed} onClick={()=>void closePreview(closeTarget)}>Zatvori nepočeti pregled</button></div>}
    </section>

    {job&&results.length>0&&<article className="gam-card gam-kv-results" aria-label="Rezultat key-values posla">
      <span className="gam-step">{completed(job)?'ZAVRŠENO / REZULTAT':'PREGLED / TRENUTNO STANJE'}</span><h3>{completed(job)?'Šta je urađeno u GAM-u':'Stanje izabranih ključeva'}</h3>
      {keyOutcomes&&valueOutcomes&&<div className="gam-kv-totals"><p><strong>Ključevi:</strong> {keyOutcomes.created} kreirano · {keyOutcomes.existing} već postoji — bez izmene{keyOutcomes.updated>0&&<> · {keyOutcomes.updated} ranije dopunjen reporting</>}</p><p><strong>Vrednosti:</strong> {valueOutcomes.created} kreirano · {valueOutcomes.existing} već postoji — bez izmene</p></div>}
      {noNewWrites&&<p className="gam-message success">Sve izabrano već postoji. Nije bilo novih upisa u GAM.</p>}
      {addOnly(job)&&results.filter(key=>key.reportableType==='OFF').map(key=><p className="gam-message info" key={key.key}><code>{key.key}</code>: reporting je OFF i ostaje OFF. Dodaju se samo nedostajuće izabrane vrednosti.</p>)}
      {completed(job)&&<p><a href={`https://admanager.google.com/${encodeURIComponent(job.network.networkCode)}#inventory/custom_targeting/list`} target="_blank" rel="noopener noreferrer">Otvori key-values u GAM-u</a></p>}
      <div className="gam-kv-result-list">{results.map(key=><details key={key.key} className="gam-kv-result-key"><summary><code>{key.key}</code><span className={'gam-kv-outcome '+key.outcome}>{outcomeNames[key.outcome]}</span><small>{key.values.length} vrednosti{key.id?' · GAM ID '+key.id:''}</small></summary>
        {(key.message||key.reconciled)&&<p>{key.message||(['created','existing','updated'].includes(key.outcome)?'Ishod je naknadno potvrđen proverom u GAM-u.':'Raniji ishod je bio potvrđen; proveri trenutno stanje.')}</p>}
        {key.values.length?<div className="gam-table-wrap"><table><thead><tr><th scope="col">Vrednost</th><th scope="col">Ishod</th><th scope="col">GAM ID</th></tr></thead><tbody>{key.values.map(value=><tr key={value.name}><td><code>{value.name}</code></td><td>{outcomeNames[value.outcome]}{(value.message||value.reconciled)&&<small>{value.message||(['created','existing','updated'].includes(value.outcome)?'Ishod je naknadno potvrđen proverom u GAM-u.':'Raniji ishod je bio potvrđen; proveri trenutno stanje.')}</small>}</td><td><code>{value.id||'—'}</code></td></tr>)}</tbody></table></div>:<p>Izabrana je priprema samo ključa, bez vrednosti.</p>}
      </details>)}</div>
    </article>}

    <fieldset className="gam-fields" disabled={locked||catalogLoading}>
      <article className="gam-card gam-kv-selection"><div className="gam-card-heading"><div><span className="gam-step">01 / IZBOR</span><h3>Koji ključevi su ti potrebni?</h3></div><strong className="gam-kv-selected-count">{selection.rows.length} ključeva · {selection.valueCount} vrednosti</strong></div>
        {catalogLoading&&<p role="status">Učitavam pripremljene ključeve i vrednosti…</p>}
        {catalogError&&<div className="gam-message error" role="alert">{catalogError}<button type="button" disabled={false} onClick={()=>void loadCatalog()}>Ponovi učitavanje ključeva</button></div>}
        <div className="gam-li-actions gam-kv-presets"><button type="button" onClick={()=>selectPreset('all')}>Izaberi sve</button><button type="button" onClick={()=>selectPreset('none')}>Poništi izbor</button><button type="button" onClick={()=>selectPreset('new')}>Samo tri nove oznake</button></div>
        <p className="gam-help">Novi ključevi pripremaju se sa uključenim reportingom. Postojeći ključevi zadržavaju svoja podešavanja, uključujući isključen reporting. Vrednosti moraju biti definisane unapred da bi ulazile u GAM izveštaje; nema retroaktivne dopune podataka.</p>
        <div className="gam-kv-key-list">{catalog?.keys.map(key=>{
          const pick=picks?.[key.key];if(!pick)return null;
          const query=queries[key.key]??'',visible=key.values.filter(value=>value.toLowerCase().includes(query.toLowerCase()));
          let pickedCount:string;try{pickedCount=valuesFor(key,pick).length+' izabrano';}catch{pickedCount='Proveri unos';}
          return <div className={'gam-kv-key '+(pick.enabled?'selected':'')} key={key.key}>
            <label className="gam-kv-key-toggle"><input type="checkbox" aria-label={'Uključi ključ '+key.key} checked={pick.enabled} onChange={event=>change(key.key,{enabled:event.target.checked})}/><span><code>{key.key}</code><small>{descriptions[key.key]||'Reporting ključ za ads.js.'}</small></span><span className="gam-kv-key-count">{pickedCount}</span></label>
            <details><summary>Vrednosti za {key.key} · {key.openDomain?'numeričke vrednosti':'pripremljena lista'}</summary>
              <fieldset className="gam-fields" disabled={!pick.enabled}>
                {key.values.length>20&&<label>Pretraži vrednosti za {key.key}<input value={query} onChange={event=>setQueries(current=>({...current,[key.key]:event.target.value}))} placeholder="npr. RS"/></label>}
                <div className="gam-li-actions"><button type="button" onClick={()=>change(key.key,{values:[...key.values]})}>Sve vrednosti za {key.key}</button><button type="button" onClick={()=>change(key.key,{values:[]})}>Bez vrednosti za {key.key}</button></div>
                <div className="gam-kv-values">{visible.map(value=><label key={value}><input type="checkbox" aria-label={`${key.key}: ${value}`} checked={pick.values.includes(value)} onChange={event=>change(key.key,{values:event.target.checked?[...pick.values,value]:pick.values.filter(item=>item!==value)})}/><code>{value}</code></label>)}</div>
                {key.openDomain&&<label>Dodatne vrednosti za {key.key}<textarea aria-label={'Dodatne vrednosti za '+key.key} rows={2} value={pick.extra} onChange={event=>change(key.key,{extra:event.target.value})} placeholder={key.key==='refresh_interval'?'npr. 30, 60':'npr. 1, 2, 3'}/><small>{key.key==='refresh_interval'?'Pozitivne sekunde, do šest decimala.':'Nenegativni celi brojevi.'} Odvoji zarezom ili novim redom.</small></label>}
              </fieldset>
              {!pick.values.length&&!pick.extra.trim()&&<p className="gam-help">Priprema samo ključa. Za reporting je potrebno unapred definisati i vrednosti.</p>}
            </details>
          </div>;
        })}</div>
        {selection.error&&<p className="gam-message error" role="alert">{selection.error}</p>}
        {!catalogLoading&&catalog&&!selection.rows.length&&!selection.error&&<p className="gam-help">Izaberi bar jedan ključ da pokreneš proveru.</p>}
        <div className="gam-kv-preview"><p><strong>{selection.rows.length} ključeva · {selection.valueCount} vrednosti</strong>{active&&<> za mrežu {active.name} · {active.networkCode}</>}</p><button type="button" className="gam-primary" disabled={!active||!selection.rows.length||Boolean(selection.error)||!catalog} onClick={()=>void preview()}>Proveri izabrane key-values u GAM-u</button><small>Ovaj korak proverava postojeće stanje i čuva izbor. Ne šalje upis u GAM.</small></div>
      </article>
    </fieldset>

    <article className="gam-card"><div className="gam-card-heading"><div><span className="gam-step">SAČUVANI POSLOVI</span><h3>Istorija key-values pripreme</h3></div><button type="button" disabled={Boolean(busy)||!network} onClick={()=>void run('Učitavam istoriju',loadHistory)}>Osveži istoriju</button></div>
      {historyError&&<p className="gam-message error" role="alert">{historyError}</p>}
      {!history.length?<p>Sačuvani pregledi i rezultati za izabranu mrežu pojaviće se ovde. Otvaranje posla samo učitava stanje.</p>:history.map(item=><div className="gam-li-history" key={item.id}><span><strong>{statusNames[item.status]||item.status}</strong><small>{new Date(item.createdAt).toLocaleString('sr-Latn')} · <code>{item.id}</code></small></span><button type="button" disabled={Boolean(busy)} onClick={()=>void open(item.id)}>Otvori key-values posao</button></div>)}
    </article>
  </div>;
}
