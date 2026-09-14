import { useEffect, useRef, useState } from 'react';

type Report = {
  siteId: string; status: 'blocked' | 'checked' | 'not_required'; required: boolean;
  requiredModules: string[]; declaredModules: string[]; missingModules: string[];
  build: { id: string; version: string; sha256: string | null; byteSize: number | null } | null;
  issues: { code: string; message: string }[]; notice: string;
  reviewHash: string; runtimeSha256: string; checkedAt: string; completeRelease: false;
};

/** A manual read-only check; mounting this panel never reads R2 or starts an auction. */
export default function BuiltinPrebidCheckPanel({ publisherId }: { publisherId: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const pending = useRef<AbortController | null>(null);
  const current = useRef(publisherId);
  const identity = publisherId;
  current.current = identity;
  useEffect(() => {
    generation.current++;
    pending.current?.abort();
    setBusy(false); setReport(null); setError('');
    return () => { generation.current++; pending.current?.abort(); };
  }, [identity]);

  async function check() {
    if (busy) return;
    const requestIdentity = identity;
    const id = ++generation.current;
    const controller = new AbortController();
    pending.current?.abort(); pending.current = controller;
    setBusy(true); setReport(null); setError('');
    try {
      const base = `/api/publishers/${encodeURIComponent(publisherId)}`;
      const settingsResponse = await fetch(`${base}/builtin-runtime-preview`, {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      const settings = await settingsResponse.json() as {
        error?: string; site?: { id: string }; reviewHash?: string;
        runtime?: { codeSha256: string }; validationIssue?: string | null;
      };
      if (generation.current !== id || current.current !== requestIdentity || controller.signal.aborted) return;
      if (!settingsResponse.ok) throw new Error(settings.error || 'Sign in again, then check the current settings.');
      if (settings.site?.id !== publisherId || !settings.reviewHash || !settings.runtime?.codeSha256) throw new Error('The current site settings could not be verified.');
      if (settings.validationIssue) throw new Error(settings.validationIssue);
      const reviewHash = settings.reviewHash;
      const runtimeSha256 = settings.runtime.codeSha256;
      const params = new URLSearchParams({ reviewHash, runtimeSha256 });
      const response = await fetch(`/api/publishers/${encodeURIComponent(publisherId)}/builtin-runtime-prebid-check?${params}`, {
        cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      const payload = await response.json() as { error?: string; report?: Report };
      if (generation.current !== id || current.current !== requestIdentity || controller.signal.aborted) return;
      if (!response.ok || !payload.report) throw new Error(payload.error || 'Prebid check could not be completed.');
      if (payload.report.siteId !== publisherId || payload.report.reviewHash !== reviewHash || payload.report.runtimeSha256 !== runtimeSha256) throw new Error('The selected site or reviewed settings changed. Refresh settings and check again.');
      setReport(payload.report);
    } catch (failure) {
      if (generation.current === id && current.current === requestIdentity && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Prebid check failed.');
    } finally {
      if (generation.current === id && current.current === requestIdentity) setBusy(false);
    }
  }

  const visible = report?.siteId === publisherId ? report : null;
  return <section className="builtin-runtime-card" aria-label="Prebid file check">
    <strong>Prebid.js file check</strong>
    <p>Check the current saved build against this site's current saved bidders and User IDs. This reads the saved file only; it does not run ads, change settings or publish.</p>
    <button className="button secondary" type="button" disabled={busy} onClick={() => void check()}>{busy ? 'Checking saved file…' : 'Check Prebid file'}</button>
    {error ? <div className="form-error" role="alert">{error}</div> : null}
    {visible ? <div role="status">
      <p><strong>{visible.status === 'checked' ? 'Stored file and module declarations checked' : visible.status === 'not_required' ? 'GPT-only: no Prebid file required' : 'Action needed before release'}</strong></p>
      {visible.build ? <p>Prebid {visible.build.version} · {visible.build.byteSize === null ? 'File not verified' : `${(visible.build.byteSize / 1024).toFixed(1)} KB`}{visible.build.sha256 ? ` · SHA-256 ${visible.build.sha256.slice(0, 16)}` : ''}</p> : null}
      {visible.issues.map((issue, index) => <p className="form-error" key={`${issue.code}-${index}`}>{issue.message}</p>)}
      {visible.required ? <details><summary>{visible.requiredModules.length} required modules · {visible.declaredModules.length} declared in build</summary><p>{visible.requiredModules.join(', ')}</p></details> : null}
      <small>{visible.notice}</small>
    </div> : null}
  </section>;
}
