import { useEffect, useState } from 'react';
import '../site-workspace/runtime.css';

type Release = { id:string; notes?:string; status:string; createdAt:string };
type Props = { publisherId:string; endpoint?:string; testOnly?:boolean };
export function testPageUrl(siteId:string, releaseId:string, testOnly=false) {
  return testOnly
    ? `/test-api/site-test-page/${encodeURIComponent(releaseId)}`
    : `/api/publishers/${encodeURIComponent(siteId)}/builtin-releases/${encodeURIComponent(releaseId)}/test-page`;
}
export default function SiteTestPagePanel({ publisherId, endpoint, testOnly=false }:Props) {
  const [releases,setReleases] = useState<Release[]>([]), [selected,setSelected] = useState('');
  const [loading,setLoading] = useState(true), [error,setError] = useState(''), [reload,setReload] = useState(0);
  const url = endpoint ?? `/api/publishers/${encodeURIComponent(publisherId)}/builtin-releases`;
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(''); setReleases([]);
    fetch(url,{credentials:'same-origin',cache:'no-store',signal:abort.signal}).then(async response => {
      const data = await response.json(); if(!response.ok) throw Error(data.error || 'Could not load saved packages.');
      if(abort.signal.aborted) return;
      const expected = testOnly ? /^builtin-draft-[a-f0-9]{64}$/ : /^builtin-release-[a-f0-9]{64}$/;
      const items = (data.releases || []).filter((item:Release) => expected.test(item.id));
      setReleases(items); setSelected(current => items.some((item:Release) => item.id === current) ? current : items[0]?.id || '');
    }).catch(e => { if(!abort.signal.aborted) setError(e.message); }).finally(() => { if(!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  },[url,publisherId,testOnly,reload]);
  const chosen = releases.find(release => release.id === selected);
  return <section className="site-runtime-panel" aria-label="Test page">
    <h2>Test page</h2><p>Check the ad positions in a saved package, then inspect actual requests with Google Publisher Console. An empty ad is OK for this test.</p>
    {error ? <p role="alert" className="runtime-error">{error}</p> : null}
    {loading ? <p>Loading saved packages…</p> : releases.length ? <>
      <label>Saved package<select aria-label="Saved package" value={selected} onChange={event => setSelected(event.target.value)}>{releases.map(release => <option key={release.id} value={release.id}>{release.notes || 'Generated package'} · {new Date(release.createdAt).toLocaleString()} · {release.status} · {release.id.slice(-8)}</option>)}</select></label>
      {chosen ? <><p className="runtime-muted">The test uses this package's positions, size maps and original scripts. Unsaved editor changes are not included.</p><div className="runtime-actions"><a className="runtime-test-link runtime-test-link-primary" href={testPageUrl(publisherId,chosen.id,testOnly)} target="_blank" rel="noopener noreferrer">Open test page</a></div><details><summary>Selected package ID</summary><code style={{overflowWrap:'anywhere'}}>{chosen.id}</code></details></> : null}
    </> : !error ? <p>No saved built-in packages yet. Open Generate and releases, save a package, then return here.</p> : null}
    <div className="runtime-actions"><button disabled={loading} onClick={() => setReload(value => value + 1)}>Reload packages</button></div>
    <h3>What you can check</h3><ul><li>DIVs, GPT registration, responsive sizes and actual ad requests.</li><li>Lazy positions while scrolling and separate runtime-created slots.</li><li>Google Publisher Console and a report you can copy.</li></ul>
    <p>The test opens in a separate HTTPS page. Click Start test there to load GPT and the saved scripts. It can send real ad requests; it does not publish a release or change your settings.</p>
    <p className="runtime-muted">The page is isolated from your Tessera login. Publisher CMP, storage, demand and the real website layout need verification on the publisher site.</p>
  </section>;
}
