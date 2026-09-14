import { useCallback, useEffect, useRef, useState } from 'react';
import '../builtin-runtime-preview.css';
import runtimeReleases from '../../worker/runtime/runtime-releases.json';
type Runtime = { id: string; version: string; codeSha256: string; channel: string };
type TakeOver = { enabled: boolean; adUnitCode: string; desktopMinWidth: number; desktopSize: number[]; mobileSize: number[]; autoCloseDesktopSec: number; autoCloseMobileSec: number; codelessAdUnitPath: string };
type Settings = { site: { id: string; name: string; domain: string }; runtime: Runtime; reviewHash: string; summary: { units: number; bidders: number }; validationIssue: string | null; takeOver: TakeOver; notice: string };
type Result = { siteId: string; fileName: string; content: string; checksum: string; byteSize: number; completeRelease: false; warnings: string[] };
async function jsonRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init });
  let payload;
  try { payload = await response.json(); } catch { throw new Error('The server did not return JSON. Sign in again, then reload this panel.'); }
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
  return payload as T;
}
export default function BuiltinRuntimePreviewPanel({ publisherId }: { publisherId: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [takeOver, setTakeOver] = useState<TakeOver | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const mounted = useRef(true);
  const requestId = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const url = `/api/publishers/${encodeURIComponent(publisherId)}/builtin-runtime-preview`;
  const load = useCallback(async () => {
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const id = ++requestId.current;
    setLoading(true); setBusy(false); setResult(null); setSettings(null);
    setApproved(false); setPreviewOpen(false); setError(''); setMessage('');
    try {
      const value = await jsonRequest<Settings>(url, { signal: controller.signal });
      if (!mounted.current || requestId.current !== id) return;
      if (value.site.id !== publisherId) throw new Error('Site mismatch. Reload the page.');
      setSettings(value); setTakeOver(value.takeOver);
    } catch (failure) {
      if (mounted.current && requestId.current === id && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Settings could not be loaded.');
    } finally {
      if (mounted.current && requestId.current === id) setLoading(false);
    }
  }, [publisherId, url]);
  useEffect(() => {
    mounted.current = true; void load();
    return () => { mounted.current = false; requestId.current++; pending.current?.abort(); };
  }, [load]);
  function change<K extends keyof TakeOver>(key: K, value: TakeOver[K]) {
    setTakeOver((current) => current ? { ...current, [key]: value } : current);
    setResult(null); setMessage(''); setPreviewOpen(false);
  }
  async function generate() {
    if (!settings || !takeOver || !approved || busy || loading || settings.validationIssue) return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const id = ++requestId.current;
    setBusy(true); setError(''); setMessage(''); setResult(null); setPreviewOpen(false);
    try {
      const value = await jsonRequest<Result>(url, { method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewHash: settings.reviewHash,
          runtimeVersion: settings.runtime.version, runtimeSha256: settings.runtime.codeSha256,
          allowPreview: approved, takeOver }) });
      if (!mounted.current || id !== requestId.current) return;
      if (value.siteId !== publisherId) throw new Error('Site mismatch. No preview was accepted.');
      setResult(value); setMessage('Source preview generated. No site settings or published files were changed.');
    } catch (failure) {
      if (mounted.current && id === requestId.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Generation failed.');
    } finally { if (mounted.current && id === requestId.current) setBusy(false); }
  }
  async function downloadCandidate() {
    if (!settings || !takeOver || !approved || busy || loading || settings.validationIssue) return;
    pending.current?.abort();
    const controller = new AbortController(); pending.current = controller;
    const id = ++requestId.current;
    setBusy(true); setError(''); setMessage(''); setResult(null); setPreviewOpen(false);
    try {
      const response = await fetch(`/api/publishers/${encodeURIComponent(publisherId)}/builtin-runtime-bundle`, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { 'content-type': 'application/json', accept: 'application/zip' },
        body: JSON.stringify({ reviewHash: settings.reviewHash, runtimeVersion: settings.runtime.version,
          runtimeSha256: settings.runtime.codeSha256, allowPreview: approved, takeOver }),
      });
      if (!response.ok) {
        const problem = await response.json() as { error?: string };
        throw new Error(problem.error || 'The candidate bundle could not be generated.');
      }
      if (!response.headers.get('content-type')?.includes('application/zip') ||
          response.headers.get('x-tessera-site-id') !== publisherId ||
          response.headers.get('x-tessera-runtime-sha256') !== settings.runtime.codeSha256) {
        throw new Error('The candidate identity could not be verified. No file was downloaded.');
      }
      const blob = await response.blob();
      if (!mounted.current || id !== requestId.current || controller.signal.aborted) return;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = objectUrl;
      anchor.download = `${publisherId}-tessera-candidate.zip`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setMessage('Candidate ZIP downloaded: JS, CSS, configuration and checksums. Nothing was saved or published. Review only — not a production release.');
    } catch (failure) {
      if (mounted.current && id === requestId.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Candidate download failed.');
    } finally { if (mounted.current && id === requestId.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    const id = requestId.current;
    try {
      await navigator.clipboard.writeText(result.content);
      if (mounted.current && id === requestId.current) setMessage('Preview source copied. This is not a production release.');
    } catch { if (mounted.current && id === requestId.current) setError('Clipboard access was blocked. Use Download preview instead.'); }
  }
  function download() {
    if (!result) return;
    const objectUrl = URL.createObjectURL(new Blob([result.content], { type: 'text/javascript;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = result.fileName;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
  const currentRelease = settings && runtimeReleases.find((release) =>
    release.id === settings.runtime.id && release.version === settings.runtime.version && release.codeSha256 === settings.runtime.codeSha256);
  const lazyScope = settings?.validationIssue?.match(/^Per-slot lazy settings in (.+) require the release overlay;/)?.[1];
  return <article className="builtin-runtime-card">
    <header><div><span className="panel-kicker">Built into Tessera</span><h2>ads.js versions</h2>
      <p>Review changes to the generator and prepare a test file for this site.</p></div>
      <span className="builtin-preview-badge">TEST PREVIEW</span></header>
    {loading ? <p>Loading site settings…</p> : null}
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    {message ? <div className="builtin-runtime-success" role="status">{message}</div> : null}
    {settings && takeOver ? <>
      <div className="builtin-runtime-site"><strong>{settings.site.name}</strong><span>{settings.site.domain} · {settings.summary.units} enabled units · {settings.summary.bidders} saved enabled bidders</span></div>
      <section className="builtin-version-summary" aria-label="Available generator">
        <span className="panel-kicker">Available for this preview</span>
        <h3>{currentRelease?.title ?? 'Built-in ads.js generator'}</h3>
        <p>{currentRelease?.date ?? ''} · Test version</p>
        {currentRelease ? <ul>{currentRelease.changes.map((change) => <li key={change}>{change}</li>)}</ul> : null}
        <p>This preview does not select a version for the site. Only one generator is currently available here.</p>
      </section>
      <details className="builtin-version-history"><summary>Version history and earlier files</summary>
        <p>Earlier generator versions are listed for reference; they cannot be selected for generation yet. Previously saved site packages are in the Releases tab. A new draft has no earlier package to restore.</p>
        {runtimeReleases.map((release) => <section key={release.codeSha256}>
          <h4>{release.date} — {release.title}</h4>
          <p>{release.codeSha256 === currentRelease?.codeSha256 ? 'Available for preview' : 'History only · unavailable for generation'}</p>
          <ul>{release.changes.map((change) => <li key={change}>{change}</li>)}</ul>
        </section>)}
      </details>
      {settings.validationIssue ? <div className="form-error" role="alert">
        {lazyScope ? <><strong>Preview is not available for these lazy-load rules.</strong><p>The {lazyScope === '__ATF__' ? 'ATF' : lazyScope === '__BTF__' ? 'BTF' : lazyScope} settings are saved, but this generator cannot apply them yet. Keep your settings; support is needed before generating this preview.</p></> : settings.validationIssue}
      </div> : null}
      <details className="builtin-version-history"><summary>Technical details</summary>
        <p>Generator: {settings.runtime.version}</p><p>Source ID: <code>{settings.runtime.codeSha256}</code></p>
        <p>The version identifies the shared ads.js generator, not the Prebid.js version or a published site package.</p>
        {lazyScope ? <p>{settings.validationIssue}</p> : null}
      </details>
      <fieldset disabled={busy} className="builtin-takeover"><legend>TakeOver (optional)</legend>
        <label className="builtin-checkbox"><input type="checkbox" checked={takeOver.enabled} onChange={(event) => change('enabled', event.target.checked)} />Enable TakeOver in generated preview</label>
        <p>These values are temporary and do not change the saved site. Delivery remains controlled by GAM targeting.</p>
        {takeOver.enabled ? <div className="builtin-takeover-grid">
          <label>GAM child ad unit code<input value={takeOver.adUnitCode} onChange={(event) => change('adUnitCode', event.target.value)} /></label>
          <label>Desktop starts at (px)<input type="number" min="320" max="5000" value={takeOver.desktopMinWidth} onChange={(event) => change('desktopMinWidth', Number(event.target.value))} /></label>
          {(['desktopSize', 'mobileSize'] as const).map((key) => <label key={key}>{key === 'desktopSize' ? 'Desktop size (width × height)' : 'Mobile / tablet size (width × height)'}
            <span className="builtin-size-pair">{[0, 1].map((index) => <input key={index} aria-label={`${key} ${index === 0 ? 'width' : 'height'}`} type="number" min="1" max="10000" value={takeOver[key][index]} onChange={(event) => { const pair = [...takeOver[key]]; pair[index] = Number(event.target.value); change(key, pair); }} />)}</span></label>)}
          <label>Desktop auto-close (seconds)<input type="number" min="0" max="300" value={takeOver.autoCloseDesktopSec} onChange={(event) => change('autoCloseDesktopSec', Number(event.target.value))} /><small>0 disables automatic closing.</small></label>
          <label>Mobile auto-close (seconds)<input type="number" min="0" max="300" value={takeOver.autoCloseMobileSec} onChange={(event) => change('autoCloseMobileSec', Number(event.target.value))} /></label>
          <label className="builtin-wide">Interstitial fallback GAM path<input value={takeOver.codelessAdUnitPath} onChange={(event) => change('codelessAdUnitPath', event.target.value)} /><small>Confirm the exact existing path before using this configuration.</small></label>
        </div> : null}
      </fieldset>
      <p>A test file does not save settings or publish the site. A test ZIP also needs a verified Prebid file when header bidding is enabled.</p>
      <label className="builtin-checkbox"><input type="checkbox" checked={approved} disabled={busy} onChange={(event) => setApproved(event.target.checked)} />Prepare a test preview only.</label>
      <div className="builtin-runtime-actions"><button type="button" className="button secondary" onClick={() => void load()} disabled={busy || loading}>Refresh settings</button>
        <button type="button" className="button primary" onClick={() => void generate()} disabled={busy || loading || !approved || Boolean(settings.validationIssue)}>{busy ? 'Working…' : 'Preview ads.js'}</button>
        <button type="button" className="button secondary" onClick={() => void downloadCandidate()} disabled={busy || loading || !approved || Boolean(settings.validationIssue)}>Download test ZIP</button></div>
    </> : !loading ? <button className="button secondary" type="button" onClick={() => void load()}>Retry</button> : null}
    {result ? <section className="builtin-runtime-result"><strong>{(result.byteSize / 1024).toFixed(1)} KB · SHA-256 {result.checksum.slice(0, 16)}</strong>
      {result.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
      <div className="builtin-runtime-actions"><button type="button" className="button secondary" onClick={() => void copy()}>Copy preview</button><button type="button" className="button secondary" onClick={download}>Download preview</button></div>
      <button className="builtin-runtime-toggle" type="button" aria-expanded={previewOpen} onClick={() => setPreviewOpen((open) => !open)}>{previewOpen ? 'Hide source' : 'Show generated source'}</button>
      {previewOpen ? <pre>{result.content}</pre> : null}
    </section> : null}
  </article>;
}
