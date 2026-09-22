import {useState} from 'react';
export type SiteSync={state:string;siteId:string;siteName?:string;error?:string;addedUnits?:number;addedMaps?:number;warnings?:string[]};
export type SiteSyncReview={id:string;siteId:string;siteName:string;addedUnits:number;existingUnits:number;addedMaps:string[];warnings:string[];rows:{code:string;mapKey:string;state:string}[]};
type Props={onSaved?:(siteId:string)=>void|Promise<void>;onOpenSite?:(siteId:string)=>void;result:{id:string;siteId?:string;siteSync?:SiteSync};sites:{id:string;name:string}[];call:<T>(path:string,body?:unknown)=>Promise<T>};
export default function SiteSyncCard({result,sites,call,onSaved,onOpenSite}:Props){
 const [site,setSite]=useState(result.siteId||''),[saved,setSaved]=useState(result.siteSync?.state==='saved'?result.siteSync:null);
 const [review,setReview]=useState<SiteSyncReview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function run(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);setReview(null);}finally{setBusy(false);}}
 return <div className="gam-site-sync">
  {saved?<><strong>✓ Upisano u sajt: {saved.siteName||saved.siteId}</strong><p>{saved.addedUnits} novih ad unita · {saved.addedMaps} novih mapa. GAM ID-jevi i putanje su sačuvani. Postojeća podešavanja su zadržana.</p><small>Generate / Publish primenjuje novi inventar na sajtu.</small>{onOpenSite&&<button type="button" onClick={()=>onOpenSite(saved.siteId)}>Otvori ad unite sajta →</button>}</>:<>
   <strong>{result.siteId?'GAM je sačuvan; upis u sajt čeka potvrdu.':'Povežite potvrđene GAM ad unite sa sajtom'}</strong>
   {result.siteSync?.error&&<p>{result.siteSync.error}</p>}
   <label>Sajt za upis<select disabled={busy} value={site} onChange={e=>{setSite(e.target.value);setReview(null);setError('');}}><option value="">Izaberite sajt</option>{sites.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
   <button type="button" disabled={!site||busy} onClick={()=>void run(async()=>{const r=await call<SiteSyncReview&{saved?:SiteSync}>('/site-sync/preview',{id:result.id,siteId:site});if(r.saved)setSaved(r.saved);else setReview(r);})}>{busy?'Provera…':'Proveri upis u sajt'}</button>
   <small>Proverava postojeće GAM pozicije. Ne kreira nove u GAM-u.</small>
   {review&&<div className="gam-review-summary"><strong>{review.siteName}</strong><span>{review.addedUnits} novih ad unita · {review.existingUnits} postojećih · {review.addedMaps.length} novih mapa</span>{review.warnings.map((w,i)=><small key={i}>{w}</small>)}<div className="gam-table-wrap"><table><thead><tr><th>Ad unit</th><th>Size mapa</th><th>Sajt</th></tr></thead><tbody>{review.rows.map(r=><tr key={r.code}><td>{r.code}</td><td>{r.mapKey}</td><td>{r.state==='new'?'Dodaje se':'Zadržava se'}</td></tr>)}</tbody></table></div><button className="gam-primary" type="button" disabled={busy} onClick={()=>void run(async()=>{const r=await call<SiteSync>('/site-sync/apply',{id:review.id,confirmSite:review.siteId});setSaved(r);void onSaved?.(r.siteId);setReview(null);})}>Potvrdi upis u sajt</button></div>}
  </>}
  {error&&<p className="gam-message error" role="alert">{error}</p>}
 </div>;
}
