import {useEffect,useId,useRef,useState} from 'react';
import AbMeasurementPanel from './AbMeasurementPanel';
import './ab-tests.css';
import './site-measurement.css';
import '../site-workspace/runtime.css';

type Arm={release:string;runtimeVersion:string;name:string};
type SavedTest={id:string;name:string;testId:string;createdAt:string;trafficBPercent:number;arms:{A:Arm;B:Arm}};
type Listing={tests:SavedTest[];deleted:SavedTest[]};
type Props={publisherId:string;preferredExperimentId?:string;onOpenReleases?:()=>void};

/** Site-level entry point, independent of the release workflow. Existing saved tests own their report identity. */
export default function SiteMeasurementPanel(props:Props){
  return <SiteMeasurementContent key={props.publisherId} {...props}/>;
}

function SiteMeasurementContent({publisherId,preferredExperimentId,onOpenReleases}:Props){
  const selectId=useId(),requestTicket=useRef(0);
  const [listing,setListing]=useState<Listing|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  const [selected,setSelected]=useState(preferredExperimentId??'');
  const endpoint=`/api/publishers/${encodeURIComponent(publisherId)}/ab-tests`;
  useEffect(()=>{
    const ticket=++requestTicket.current,controller=new AbortController();
    setListing(null);setError('');
    void (async()=>{
      try{
        const response=await fetch(endpoint,{credentials:'same-origin',cache:'no-store',signal:controller.signal});
        if(!response.ok){
          let message='Could not load saved A/B tests. Retry.';
          try{message=((await response.json()) as {error?:string}).error||message;}catch{ /* Keep the readable fallback. */ }
          throw Error(message);
        }
        const next=await response.json() as Listing;
        if(controller.signal.aborted||requestTicket.current!==ticket)return;
        setListing(next);
        setSelected(current=>next.tests.some(test=>test.id===current)?current:'');
      }catch(problem){
        if(!controller.signal.aborted&&requestTicket.current===ticket)setError(problem instanceof Error?problem.message:'Could not load saved A/B tests. Retry.');
      }
    })();
    return()=>{controller.abort();requestTicket.current++;};
  },[endpoint,attempt]);
  const test=listing?.tests.find(item=>item.id===selected);
  return <section className="site-runtime-panel ab-tests-panel site-measurement-panel" aria-labelledby="site-measurement-title">
    <h2 id="site-measurement-title">Measurement</h2>
    <p>Review GAM results for a saved A/B test. Choose the test, prepare its reporting plan, then upload the matching GAM CSV.</p>
    {error?<p role="alert" className="runtime-error">{error} <button type="button" onClick={()=>setAttempt(value=>value+1)}>Reload A/B tests</button></p>
      :!listing?<p role="status" className="ab-tests-status">Loading saved A/B tests…</p>
      :!listing.tests.length?<div className="site-measurement-empty">
        <h3>No saved A/B tests to measure</h3>
        <p>This view uses A/B tests saved from two built-in packages. Earlier pilot A/B ZIPs are not included and are not converted automatically. Some earlier pilots send Variant only; this view cannot add TestId to an already deployed ZIP. Opening Measurement does not change a deployed test or site settings.</p>
        {listing.deleted.length?<p>This site has deleted A/B tests. Restore a test in Releases to review it here.</p>:null}
        {onOpenReleases?<button type="button" onClick={onOpenReleases}>Open Releases</button>:null}
      </div>:<>
        <label htmlFor={selectId}>Saved A/B test</label>
        <select id={selectId} value={selected} onChange={event=>setSelected(event.target.value)}>
          <option value="">Choose a saved A/B test</option>
          {listing.tests.map(item=><option key={item.id} value={item.id}>{item.name} · TestId {item.testId}</option>)}
        </select>
        {!test?<p className="ab-tests-help">Select the test whose results you want to review. This list does not confirm which ZIP is deployed on your site.</p>:<article className="site-measurement-test" aria-label={`Measurement for ${test.name}`}>
          <h3 className="ab-tests-name">{test.name}</h3>
          <dl className="ab-tests-details">
            <div><dt>TestId</dt><dd><code>{test.testId}</code></dd></div>
            <div><dt>Saved</dt><dd>{new Date(test.createdAt).toLocaleString()}</dd></div>
            <div><dt>Traffic split</dt><dd>A {100-test.trafficBPercent}% · B {test.trafficBPercent}%</dd></div>
            {(['A','B'] as const).map(arm=><div key={arm}><dt>Version {arm}</dt><dd className="ab-tests-name">{test.arms[arm].name} · script {test.arms[arm].runtimeVersion}</dd></div>)}
          </dl>
          <p className="ab-tests-help">TestId identifies this saved test in GAM; Variant identifies group A or B. Tessera suggests a TestId when creating a test and keeps it with the saved test. Prepare reporting for that exact value and both Variant values in GAM before collecting traffic. Import the report here to review its results.</p>
          <AbMeasurementPanel key={test.id} endpoint={`${endpoint}/${test.id}/measurement/plans`} experimentId={test.id} testId={test.testId} expanded/>
        </article>}
      </>}
  </section>;
}
