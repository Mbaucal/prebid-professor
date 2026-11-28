import AbTestsPanel from './AbTestsPanel';
import HistoricalAbTestsPanel from './HistoricalAbTestsPanel';
import PolitikaGamImportPanel from './PolitikaGamImportPanel';
import './site-measurement.css';

type Props={publisherId:string;siteName?:string;siteDomain?:string;preferredExperimentId?:string};

/** One site workspace for previous experiments, new source snapshots, A/B bundles and report review. */
export default function SiteMeasurementPanel({publisherId,siteName,siteDomain,preferredExperimentId}:Props){
  const endpoint=`/api/publishers/${encodeURIComponent(publisherId)}/ab-tests`;
  return <section className="site-runtime-panel site-measurement-panel" aria-labelledby="site-measurement-title">
    <h2 id="site-measurement-title">Measurement</h2>
    <p>Find previous tests, save script versions, prepare a new A/B ZIP and review its GAM report here. Saving a version or test does not deploy it.</p>
    {['politika.rs','www.politika.rs'].includes((siteDomain??'').trim().toLowerCase())?<PolitikaGamImportPanel key={publisherId}/>:null}
    <AbTestsPanel key={publisherId} publisherId={publisherId} siteName={siteName} endpoint={endpoint} workspace
      preferredExperimentId={preferredExperimentId} history={<HistoricalAbTestsPanel key={publisherId} endpoint={endpoint}/>}/>
  </section>;
}
