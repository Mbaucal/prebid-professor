import { useEffect, useState } from 'react';
import { runtimeLabel } from '../site-workspace/runtime-labels';
import '../site-workspace/runtime.css';

type Pin = { runtimeSha256: string; runtimeVersion: string };
type Runtime = { version: string; pin: Pin };
type State = {
  revision: string; selected: Pin | null; enablePrebid: boolean; validationIssue: string | null;
  prebid: { status: string; message: string };
  currentRuntime?: Runtime | null;
  runtimes: Runtime[];
  history: Array<{ version: string; title: string; date: string; codeSha256: string; changes: string[] }>;
};

function samePin(left: Pin | null, right: Pin | null) {
  return left === right || Boolean(left && right && left.runtimeSha256 === right.runtimeSha256 && left.runtimeVersion === right.runtimeVersion);
}

function currentRuntime(state: State) {
  const current = state.currentRuntime;
  if (!current?.pin || !current.version || current.pin.runtimeVersion !== current.version) return undefined;
  return state.runtimes.find(item => item.version === current.version && samePin(item.pin, current.pin));
}
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
  const [selection, setSelection] = useState<Pin | null>(null);
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
    const data = await response.json() as State & { error?: string };
    if (!response.ok) throw new Error(data.error || 'Script setup could not be loaded.');
    return data;
  }
  function accept(next: State) {
    setState(next); setPrebid(next.enablePrebid);
    setSelection(next.selected ?? currentRuntime(next)?.pin ?? null);
    setStale(false);
  }
  useEffect(() => {
    let active = true;
    request().then(next => { if (active) accept(next); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [url]);
  const current = state ? currentRuntime(state) : undefined;
  const selected = state?.runtimes.find(item => samePin(item.pin, selection));
  const unavailable = Boolean(state && !current);
  const isCurrent = Boolean(current && samePin(selection, current.pin));
  const changedVersion = Boolean(state && !samePin(selection, state.selected));
  const blockedBuild = prebid && (state?.prebid.status === 'missing' || state?.prebid.status === 'ambiguous');
  const dirty = state && (prebid !== state.enablePrebid || changedVersion);
  async function save() {
    if (!state || !selected || unavailable || busy) return;
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
      {unavailable ? <p role="alert" className="runtime-error">The current script version is unavailable. Reload script setup before saving.</p> : null}
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
        <span>Script version <strong>{selection ? runtimeLabel(selected?.version ?? selection.runtimeVersion) : 'Unavailable'}</strong>{!selection ? '' : !state.selected ? ' · Current version for new scripts' : changedVersion ? ' · Unsaved version change' : isCurrent ? ' · Current version' : ' · Saved version'}</span>
        {current && !isCurrent ? <button type="button" disabled={busy || stale} onClick={() => { setSelection(current.pin); setMessage(''); }}>Use current version</button> : null}
      </div>
      {selected?.version.startsWith('3.14.0') ? <p className="script-prebid-note">
        Waits for your CMP decision before requesting ads. If Prebid fails to load, Google ads are requested only after consent is resolved.
      </p> : null}
      {selected?.version.startsWith('3.13.0') || selected?.version.startsWith('3.14.0') ? <p className="script-prebid-note">
        GAM reporting: refresh count, bucket, interval and policy. {prebid ? 'Also includes current-auction bid counts and timeout.' : 'No Prebid auction values are sent in GAM / AdX only mode.'} Key definitions are included in the downloaded package. Enable key-value reporting in GAM to use them in reports.
      </p> : null}
      {prebid ? <div className={blockedBuild ? 'runtime-error' : 'script-prebid-note'}>
        <p>{state.prebid.status === 'off' ? 'Select a current Prebid.js build before enabling bidders.' : state.prebid.message}</p>
        {onOpenPrebid ? <button type="button" onClick={onOpenPrebid}>Open Prebid.js</button> : null}
      </div> : null}
      {state.validationIssue && !dirty ? <p className="runtime-error">{state.validationIssue}</p> : null}
      <div className="runtime-actions">
        <button type="button" disabled={busy || stale || unavailable || !selected || blockedBuild || (!dirty && !state.validationIssue)} onClick={() => void save()}>{busy ? 'Saving…' : 'Save script setup'}</button>
        {onContinue && state.selected && !dirty && !state.validationIssue ? <button type="button" disabled={busy || unavailable} onClick={onContinue}>Continue to Generate</button> : null}
        {stale || error || unavailable ? <button type="button" disabled={busy} onClick={() => void reload()}>Reload script setup</button> : null}
      </div>
      <p className="script-setup-footnote">Applies to your next generated script. Existing settings and published versions are kept.</p>
      <details className="script-history"><summary>Version history</summary>
        {state.history.map(item => <article className="runtime-release" key={item.codeSha256}><strong>{runtimeLabel(item.version)} · {item.date}</strong><p>{item.title}</p><ul>{item.changes.map(change => <li key={change}>{change}</li>)}</ul></article>)}
      </details>
    </> : error ? <button disabled={busy} onClick={() => void reload()}>Reload script setup</button> : null}
  </section>;
}
