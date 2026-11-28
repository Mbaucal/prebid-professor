import AbTestsPanel from './AbTestsPanel';
import HistoricalAbTestsPanel from './HistoricalAbTestsPanel';
import GamCsvImportPanel from './GamCsvImportPanel';
import './site-measurement.css';

type Props={publisherId:string;siteName?:string;siteDomain?:string;gamPath?:string;preferredExperimentId?:string};

/** One site workspace for previous experiments, new source snapshots, A/B bundles and report review. */
export default function SiteMeasurementPanel({publisherId,siteName,siteDomain,gamPath,preferredExperimentId}:Props){
  const endpoint=`/api/publishers/${encodeURIComponent(publisherId)}/ab-tests`;
  return <section className="site-runtime-panel site-measurement-panel" aria-labelledby="site-measurement-title">
    <h2 id="site-measurement-title">Measurement</h2>
    <p>Find previous tests, save script versions, prepare a new A/B ZIP and review its GAM report here. Saving a version or test does not deploy it.</p>
    <GamCsvImportPanel key={publisherId} siteId={publisherId} siteName={siteName || siteDomain} siteDomain={siteDomain} gamPath={gamPath}/>
    <AbTestsPanel key={publisherId} publisherId={publisherId} siteName={siteName} endpoint={endpoint} workspace
      preferredExperimentId={preferredExperimentId} history={<HistoricalAbTestsPanel key={publisherId} endpoint={endpoint}/>}/>
  </section>;
}
