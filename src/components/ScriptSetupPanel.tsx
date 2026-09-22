import { useEffect, useState } from 'react';
import { runtimeLabel } from '../site-workspace/runtime-labels';
import '../site-workspace/runtime.css';

type Pin = { runtimeSha256: string; runtimeVersion: string };
type State = {
  revision: string; selected: Pin | null; enablePrebid: boolean; validationIssue: string | null;
  prebid: { status: string; message: string };
  runtimes: Array<{ version: string; pin: Pin }>;
  history: Array<{ version: string; title: string; date: string; codeSha256: string; changes: string[] }>;
};
type Props = {
  publisherId: string; endpoint?: string; onChanged?: () => void | Promise<void>;
  onOpenPrebid?: () => void; onContinue?: () => void;
};

export default function ScriptSetupPanel(props: Props) {
  return <SetupEditor key={`${props.publisherId}:${props.endpoint ?? 'site'}`} {...props} />;
}

function SetupEditor({ publisherId, endpoint, onChanged, onOpenPrebid, onContinue }: Props) {
  const url = endpoint ?? `/api/publishers/${encodeURIComponent(publisherId)}/builtin-site-settings`;
  const [state, setState] = useState<State | null>(null);
  const [prebid, setPrebid] = useState(false);
  const [version, setVersion] = useState('');
  const [showVersions, setShowVersions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function request(body?: unknown): Promise<State> {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Script setup could not be loaded.');
    return data;
  }
  function accept(next: State) {
    setState(next); setPrebid(next.enablePrebid);
    setVersion(next.selected?.runtimeSha256 ?? next.runtimes[0]?.pin.runtimeSha256 ?? '');
    setStale(false);
  }
  useEffect(() => {
    let active = true;
    request().then(next => { if (active) accept(next); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [url]);
  const selected = state?.runtimes.find(item => item.pin.runtimeSha256 === version);
  const blockedBuild = prebid && (state?.prebid.status === 'missing' || state?.prebid.status === 'ambiguous');
  const dirty = state && (prebid !== state.enablePrebid || version !== state.selected?.runtimeSha256);
  async function save() {
    if (!state || !selected || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await request({ action: 'setup', revision: state.revision, runtime: selected.pin, allowPreview: true, enablePrebid: prebid });
      accept(await request());
      setMessage('Script setup saved. You can now generate your script.');
      await onChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save script setup.'); setStale(true); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError(''); setMessage('');
    try { accept(await request()); } catch (e) { setError(e instanceof Error ? e.message : 'Could not reload.'); }
    finally { setBusy(false); }
  }
  return <section className="site-runtime-panel script-setup" aria-label="Script setup">
    <span className="script-setup-kicker">1. Choose your script</span>
    <h2>Script setup</h2>
    <p>Choose how ads are requested. Tessera uses your saved ad units and size maps.</p>
    {error ? <p role="alert" className="runtime-error">{error}</p> : null}
    {message ? <p role="status" className="runtime-message">{message}</p> : null}
    {!state && !error ? <p>Loading script setup…</p> : null}
    {state ? <>
      <div className="script-mode-options" role="radiogroup" aria-label="Script mode">
        <label className={!prebid ? 'selected' : ''}>
          <input type="radio" name={`script-mode-${publisherId}`} checked={!prebid} disabled={busy} onChange={() => setPrebid(false)} />
          <span><strong>GAM / AdX only</strong><span>Google ads, responsive sizes, lazy loading and refresh. No Prebid file needed.</span></span>
        </label>
        <label className={prebid ? 'selected' : ''}>
          <input type="radio" name={`script-mode-${publisherId}`} checked={prebid} disabled={busy} onChange={() => setPrebid(true)} />
          <span><strong>GAM + Prebid</strong><span>Google ads plus your configured bidders. Requires a Prebid.js build.</span></span>
        </label>
      </div>
      <div className="script-version-summary">
        <span>Script version <strong>{runtimeLabel(selected?.version ?? state.selected?.runtimeVersion ?? '')}</strong>{!state.selected ? ' · Default for new scripts' : ''}</span>
        <button type="button" disabled={busy} aria-expanded={showVersions} onClick={() => setShowVersions(!showVersions)}>{showVersions ? 'Hide versions' : 'Change version'}</button>
      </div>
      {showVersions ? <label>Script version<select aria-label="Script version" value={version} disabled={busy} onChange={e => setVersion(e.target.value)}>
        {!selected ? <option value={version}>Choose an available version</option> : null}
        {state.runtimes.map(item => <option key={item.pin.runtimeSha256} value={item.pin.runtimeSha256}>{runtimeLabel(item.version)}</option>)}
      </select></label> : null}
      {prebid ? <div className={blockedBuild ? 'runtime-error' : 'script-prebid-note'}>
        <p>{state.prebid.status === 'off' ? 'Select a current Prebid.js build before enabling bidders.' : state.prebid.message}</p>
        {onOpenPrebid ? <button type="button" onClick={onOpenPrebid}>Open Prebid.js</button> : null}
      </div> : null}
      {state.validationIssue && !dirty ? <p className="runtime-error">{state.validationIssue}</p> : null}
      <div className="runtime-actions">
        <button type="button" disabled={busy || stale || !selected || blockedBuild || (!dirty && !state.validationIssue)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save script setup'}</button>
        {onContinue && state.selected && !dirty && !state.validationIssue ? <button type="button" disabled={busy} onClick={onContinue}>Continue to Generate</button> : null}
        {stale || error ? <button type="button" disabled={busy} onClick={() => void reload()}>Reload script setup</button> : null}
      </div>
      <p className="script-setup-footnote">Applies to your next generated script. Existing settings and published versions are kept.</p>
      <details className="script-history"><summary>Version history</summary>
        {state.history.map(item => <article className="runtime-release" key={item.codeSha256}><strong>{runtimeLabel(item.version)} · {item.date}</strong><p>{item.title}</p><ul>{item.changes.map(change => <li key={change}>{change}</li>)}</ul></article>)}
      </details>
    </> : error ? <button disabled={busy} onClick={() => void reload()}>Reload script setup</button> : null}
  </section>;
}
