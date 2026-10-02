import {createRoot} from 'react-dom/client';
import {useEffect,useState} from 'react';
import ScriptLibraryPanel from '../components/ScriptLibraryPanel';
import PrebidModePanel from '../components/PrebidModePanel';
import PositionBidCachePanel,{fetchBidCacheSettings,type BidCachePayload} from '../components/PositionBidCachePanel';
import {CACHE_POSITIONS} from '../../worker/experiments/position-cache-settings.mjs';
import '../styles.css';
import './runtime.css';
import './named-script-test.css';
import '../prebid-mode.css';
import '../ad-units.css';
const site='test-named-script';
type View='prebid'|'positions'|'scripts';
type Status={ready:boolean;error?:string};
function currentView():View{return ['prebid','positions'].includes(location.hash.slice(1))?location.hash.slice(1) as View:'scripts';}
function Positions(){
  const [data,setData]=useState<BidCachePayload|null>(null),[error,setError]=useState(''),[code,setCode]=useState<string|null>(null),[attempt,setAttempt]=useState(0);
  useEffect(()=>{let active=true;setError('');fetchBidCacheSettings(site).then(next=>{if(active)setData(next);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[attempt]);
  return <section className="site-runtime-panel"><h2>Ad positions</h2><p>The named generator keeps these 19 reviewed positions. Choose bid caching for the next saved TEST version.</p>
    {error?<p role="alert">{error} <button className="button secondary" onClick={()=>setAttempt(v=>v+1)}>Reload positions</button></p>:!data?<p>Loading position settings…</p>:<div className="named-test-actions">{CACHE_POSITIONS.map(position=>{
      const enabled=data.prebidMode.bidCache.positionOverrides?.[position]??data.prebidMode.bidCache.enabled;
      return <button key={position} className="button secondary" onClick={()=>setCode(position)}>{position} · Bid cache: {!data.prebidMode.enabled?'Inactive':enabled?'On':'Off'}</button>;
    })}</div>}
    {code?<PositionBidCachePanel testOnly publisherId={site} code={code} onClose={()=>setCode(null)} onSaved={setData}/>:null}
  </section>;
}
function App(){
  const [view,setView]=useState<View>(currentView),[status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function load(prepare=false){setBusy(true);setError('');try{
    const response=await fetch('/test-api/named-scripts/'+(prepare?'prepare':'status'),{method:prepare?'POST':'GET',cache:'no-store',...(prepare?{headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'prepare-named-script-test-copy'})}:{})});
    const next=await response.json() as Status;if(!response.ok)throw Error(next.error||'Could not load the TEST copy.');setStatus(next);
  }catch(e){setError(e instanceof Error?e.message:'Could not load the TEST copy.');}finally{setBusy(false);}}
  useEffect(()=>{void load();const change=()=>setView(currentView());window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  const open=(next:View)=>{location.hash=next;setView(next);};
  return <main style={{maxWidth:1100,margin:'24px auto',padding:16}}><h1>Tessera · TEST named scripts</h1>
    <p>A separate Tanjug test copy for named scripts and bid-cache settings. Your existing TEST site stays unchanged. No ads run here.</p>
    <p>This generator uses its reviewed inventory, bidders and consent setup. It does not use the runtime selected in Script setup. Saved ZIPs are test packages, not live deployments.</p>
    <p><a href="/">Back to TEST workspace</a></p>
    {error?<p role="alert" className="runtime-error">{error}</p>:null}
    {!status?<p role="status">{busy?'Checking TEST copy…':'The TEST copy could not be loaded.'}</p>:!status.ready?<section className="site-runtime-panel"><h2>Prepare named-script TEST copy</h2><p>Create separate test settings for the reviewed Tanjug identity. Existing drafts and saved packages are preserved. If that identity is already in use, preparation stops without overwriting it.</p><button className="button primary" disabled={busy} onClick={()=>void load(true)}>{busy?'Preparing…':'Prepare test copy'}</button></section>:<>
      <nav className="named-test-actions" aria-label="Named script test"><button className={view==='prebid'?'button primary':'button secondary'} aria-current={view==='prebid'?'page':undefined} onClick={()=>open('prebid')}>Prebid settings</button><button className={view==='positions'?'button primary':'button secondary'} aria-current={view==='positions'?'page':undefined} onClick={()=>open('positions')}>Ad positions</button><button className={view==='scripts'?'button primary':'button secondary'} aria-current={view==='scripts'?'page':undefined} onClick={()=>open('scripts')}>Scripts and A/B tests</button></nav>
      {view==='prebid'?<PrebidModePanel testOnly publisherId={site}/>:view==='positions'?<Positions/>:<ScriptLibraryPanel publisherId={site} testOnly onOpenDemand={()=>open('prebid')}/>}
    </>}
    {error?<button className="button secondary" disabled={busy} onClick={()=>void load()}>Reload TEST copy</button>:null}
  </main>;
}
createRoot(document.getElementById('root')!).render(<App/>);
