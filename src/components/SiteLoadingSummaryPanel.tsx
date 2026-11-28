import { useEffect, useState } from 'react';
import '../site-workspace/runtime.css';
import { runtimeLabel } from '../site-workspace/runtime-labels';

type Settings = {
  site: { name: string; domain: string };
  positions: Array<{ code: string; type: string }>;
  loadingSummary?: {
    runtimeVersion: string | null;
    issue: string | null;
    units: Array<{ code: string; label: string; source: string; detail: string }>;
  };
};

/** Read-only access to the same compiler summary used by the main Unit rules table. */
export default function SiteLoadingSummaryPanel({ endpoint }: { endpoint: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setSettings(null);
    setError('');
    async function load() {
      try {
        const response = await fetch(endpoint, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw Error('Loading settings are unavailable. Please retry.');
        const data: Settings = await response.json();
        if (!data.loadingSummary) throw Error('Loading summary is unavailable. Please retry.');
        if (!controller.signal.aborted) setSettings(data);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load settings.');
      } finally {
        if (!controller.signal.aborted) setBusy(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [endpoint, reload]);

  return <section className="site-runtime-panel" aria-label="Loading rules">
    <h2>Effective behavior by ad unit</h2>
    <p>Loading follows the selected script’s ATF/BTF defaults, group rules and Display &amp; loading overrides. These are saved settings for the next generated package.</p>
    {settings ? <p>{settings.site.name} · {settings.site.domain}{settings.loadingSummary?.runtimeVersion ? ` · Script ${runtimeLabel(settings.loadingSummary.runtimeVersion)}` : ''}</p> : null}
    {busy ? <p role="status">Loading saved settings…</p> : null}
    {error ? <p role="alert" className="runtime-error">{error}</p> : null}
    {settings?.loadingSummary?.issue ? <p role="status" className="runtime-error">{settings.loadingSummary.issue}</p> : null}
    {settings ? <div className="runtime-loading-table-wrap">
      <table className="runtime-loading-table">
        <thead><tr><th>Ad unit</th><th>Type</th><th>Loading</th></tr></thead>
        <tbody>{settings.positions.map(position => {
          const summary = settings.loadingSummary?.units.find(unit => unit.code === position.code);
          return <tr key={position.code}>
            <td><strong>{position.code}</strong></td><td>{position.type}</td>
            <td>{summary ? <><strong>{summary.label}</strong><small>{summary.source}</small><small>{summary.detail}</small></> : 'Loading behavior unavailable'}</td>
          </tr>;
        })}</tbody>
      </table>
      {!settings.positions.length ? <p>No ad units in this TEST copy. Add them under Units and size maps.</p> : null}
    </div> : null}
    <div className="runtime-actions"><button disabled={busy} onClick={() => setReload(value => value + 1)}>Reload loading rules</button></div>
  </section>;
}
