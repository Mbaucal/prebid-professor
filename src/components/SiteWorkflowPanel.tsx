import { useEffect, useState } from 'react';
import '../site-workspace/runtime.css';

export type WorkflowDestination = 'settings' | 'versions' | 'prebid' | 'packages';
type Props = { publisherId: string; runtimeEndpoint?: string; packagesEndpoint?: string; onNavigate: (destination: WorkflowDestination) => void };

export default function SiteWorkflowPanel({ publisherId, runtimeEndpoint, packagesEndpoint, onNavigate }: Props) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setData(null); setError('');
    const read = async (url: string) => {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) throw Error('Cannot load this site’s saved workflow. Try reloading.');
      return response.json();
    };
    Promise.all([
      read(runtimeEndpoint ?? `/api/publishers/${encodeURIComponent(publisherId)}/builtin-site-settings`),
      read(packagesEndpoint ?? `/api/publishers/${encodeURIComponent(publisherId)}/builtin-releases`),
    ]).then(([runtime, packages]) => {
      if (runtime.revision !== packages.revision) throw Error('Saved settings changed while loading. Reload the workflow.');
      if (active) setData({ runtime, packages });
    })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [publisherId, runtimeEndpoint, packagesEndpoint, refresh]);

  return <section className="site-runtime-panel" aria-label="Build workflow">
    <h2>Build workflow</h2>
    <p>One site, its saved settings, and the packages generated from them. Opening a step does not save or publish anything.</p>
    {error ? <p role="alert" className="runtime-error">{error}</p> : !data ? <p role="status">Loading saved workflow…</p> : <>
      <h3>{data.runtime.site.name} · {data.runtime.site.domain}</h3>
      <article className="runtime-release"><h3>1. Site settings</h3>
        <p>{data.runtime.positions.length} banner positions. Manage ad units, size maps, bidders, display and loading rules in their editors.</p>
        <button onClick={() => onNavigate('settings')}>Open site settings</button>
      </article>
      <article className="runtime-release"><h3>2. Script and Prebid</h3>
        <p>Saved ads.js version: <strong>{data.runtime.selected?.runtimeVersion ?? 'Not selected'}</strong></p>
        <p>Prebid: {data.runtime.enablePrebid ? 'enabled — use the saved bidder settings and uploaded build' : 'off — GAM / AdX only'}.</p>
        <div className="runtime-actions"><button onClick={() => onNavigate('versions')}>Choose script version</button><button onClick={() => onNavigate('prebid')}>Open Prebid build</button></div>
      </article>
      <article className="runtime-release"><h3>3. Generate a package</h3>
        <p role="status" className={data.packages.ready ? 'runtime-message' : 'runtime-error'}>{data.packages.ready ? 'Saved settings are ready for generation.' : data.packages.error || 'Complete the saved settings before generating.'}</p>
        <p>Generate creates a new saved package with a release note. It does not replace live files.</p>
        <button onClick={() => onNavigate('packages')}>Open generator</button>
      </article>
      <article className="runtime-release"><h3>4. Saved packages and delivery</h3>
        <p>{data.packages.releases.length} recent built-in packages. Review dates and notes, download original files, then choose delivery separately.</p>
        {data.packages.testOnly ? <p>TEST only. Production publishing is disabled. Preview delivery remains in TEST deployments.</p> : <p>Stage the chosen package before publishing. Cloudflare delivery is a separate explicit action; existing site URLs stay unchanged.</p>}
        <button onClick={() => onNavigate('packages')}>Open saved packages</button>
      </article>
    </>}
    <button onClick={() => setRefresh(value => value + 1)}>Reload workflow</button>
  </section>;
}
