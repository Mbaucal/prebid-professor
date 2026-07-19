import { useCallback, useEffect, useMemo, useState } from 'react';
import { zipSync } from 'fflate';
import { api } from '../api';
import type { AdUnit, Site } from '../shared/types';

type Props = {
  publisherId: string;
  site: Site;
};

type ReleaseStatus = 'draft' | 'staging' | 'production' | 'archived' | 'failed';

type ReleaseUrls = {
  adsJs: string;
  adsMinJs: string;
  prebidJs: string;
  config: string;
  manifest: string;
  css: string;
  stickyCss: string;
  divCsv: string;
  implementation: string;
};

type Release = {
  id: string;
  publisherId: string;
  version: string;
  status: ReleaseStatus;
  notes: string | null;
  createdAt: string;
  publishedAt: string | null;
  urls: ReleaseUrls;
};

type ReleasesPayload = {
  ok: true;
  releases: Release[];
  channels: {
    current: Record<string, string>;
    staging: Record<string, string>;
  };
};

type DemandModePayload = {
  ok: true;
  prebidMode: {
    enabled: boolean;
    mode: 'gam-prebid' | 'gam-adx-only';
  };
  savedState: {
    currentPrebidBuild: {
      id: string;
      version: string;
      uploadedAt: string;
    } | null;
  };
};

type StoredBuild = {
  id: string;
  version: string;
  modules: string[];
  status: 'current' | 'archived' | 'invalid';
};

type BuildsPayload = {
  ok: true;
  builds: StoredBuild[];
};

type ExportSource = 'current' | 'staging' | 'release';

type ApiFailure = {
  error?: string;
  details?: unknown;
};

const ARTIFACT_ORDER = [
  'ads.js',
  'ads.min.js',
  'prebid.js',
  'config.json',
  'manifest.json',
  'min-height.css',
  'sticky.css',
  'div-export.csv',
  'implementation.html',
] as const;

type ArtifactName = (typeof ARTIFACT_ORDER)[number];

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & ApiFailure) | null = null;
  try {
    payload = text ? (JSON.parse(text) as T & ApiFailure) : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }
  if (!response.ok) {
    const details = payload?.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
}

function releaseArtifacts(release: Release): Record<ArtifactName, string> {
  return {
    'ads.js': release.urls.adsJs,
    'ads.min.js': release.urls.adsMinJs,
    'prebid.js': release.urls.prebidJs,
    'config.json': release.urls.config,
    'manifest.json': release.urls.manifest,
    'min-height.css': release.urls.css,
    'sticky.css': release.urls.stickyCss,
    'div-export.csv': release.urls.divCsv,
    'implementation.html': release.urls.implementation,
  };
}

function channelArtifacts(channel: Record<string, string>): Record<ArtifactName, string> {
  return Object.fromEntries(
    ARTIFACT_ORDER.map((name) => [name, channel[name] ?? '']),
  ) as Record<ArtifactName, string>;
}

function classForUnit(unit: AdUnit): string {
  return unit.type === 'BTF' ? 'wrapperAd lazyAd' : 'wrapperAd';
}

function divMarkup(units: AdUnit[]): string {
  return units
    .map((unit) => {
      const className = classForUnit(unit);
      return `<!-- ${unit.code} -->\n<div id="${unit.code}" class="${className}"></div>`;
    })
    .join('\n\n');
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function divCsv(units: AdUnit[]): string {
  const rows = [['Ad unit name', 'Div', 'class']];
  for (const unit of units) {
    const className = classForUnit(unit);
    rows.push([unit.code, `<div id="${unit.code}" class="${className}"></div>`, className]);
  }
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

function safeFileName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'site';
}

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function downloadText(value: string, fileName: string, contentType: string): void {
  downloadBlob(new Blob([value], { type: contentType }), fileName);
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('en', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

export default function ExportPanel({ publisherId, site }: Props) {
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [releases, setReleases] = useState<Release[]>([]);
  const [channels, setChannels] = useState<ReleasesPayload['channels'] | null>(null);
  const [prebidEnabled, setPrebidEnabled] = useState(true);
  const [currentBuild, setCurrentBuild] = useState<StoredBuild | null>(null);
  const [source, setSource] = useState<ExportSource>('current');
  const [selectedReleaseId, setSelectedReleaseId] = useState('');
  const [cssText, setCssText] = useState('');
  const [stickyCssText, setStickyCssText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingCss, setLoadingCss] = useState(false);
  const [loadingStickyCss, setLoadingStickyCss] = useState(false);
  const [buildingZip, setBuildingZip] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [unitItems, releasePayload, modePayload, buildPayload] = await Promise.all([
        api.listAdUnits(publisherId),
        requestJson<ReleasesPayload>(`/api/publishers/${encodeURIComponent(publisherId)}/releases`),
        requestJson<DemandModePayload>(`/api/publishers/${encodeURIComponent(publisherId)}/prebid-mode`),
        requestJson<BuildsPayload>(`/api/publishers/${encodeURIComponent(publisherId)}/prebid-builds`),
      ]);

      const orderedReleases = [...releasePayload.releases].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const production = orderedReleases.find((release) => release.status === 'production');
      const staging = orderedReleases.find((release) => release.status === 'staging');
      const preferred = production ?? staging ?? orderedReleases[0] ?? null;

      setAdUnits(unitItems);
      setReleases(orderedReleases);
      setChannels(releasePayload.channels);
      setPrebidEnabled(modePayload.prebidMode.enabled);
      setCurrentBuild(buildPayload.builds.find((build) => build.status === 'current') ?? null);
      setSelectedReleaseId((current) => {
        if (current && orderedReleases.some((release) => release.id === current)) return current;
        return preferred?.id ?? '';
      });
      setSource(production ? 'current' : staging ? 'staging' : 'release');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Export workspace could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeUnits = useMemo(
    () => adUnits
      .filter((unit) => unit.enabled && unit.type !== 'DRAFT')
      .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code)),
    [adUnits],
  );

  const selectedRelease = useMemo(
    () => releases.find((release) => release.id === selectedReleaseId) ?? releases[0] ?? null,
    [releases, selectedReleaseId],
  );

  const productionRelease = useMemo(
    () => releases.find((release) => release.status === 'production') ?? null,
    [releases],
  );

  const stagingRelease = useMemo(
    () => releases.find((release) => release.status === 'staging') ?? null,
    [releases],
  );

  const artifacts = useMemo<Record<ArtifactName, string>>(() => {
    if (source === 'current') return channelArtifacts(channels?.current ?? {});
    if (source === 'staging') return channelArtifacts(channels?.staging ?? {});
    return selectedRelease ? releaseArtifacts(selectedRelease) : channelArtifacts({});
  }, [channels, selectedRelease, source]);

  const sourceVersion = source === 'current'
    ? productionRelease?.version ?? site.currentVersion
    : source === 'staging'
      ? stagingRelease?.version ?? 'staging'
      : selectedRelease?.version ?? 'draft';

  const divs = useMemo(() => divMarkup(activeUnits), [activeUnits]);
  const csv = useMemo(() => divCsv(activeUnits), [activeUnits]);

  const scriptTags = useMemo(() => {
    const lines: string[] = [];
    if (artifacts['min-height.css']) {
      lines.push(`<link rel="stylesheet" href="${artifacts['min-height.css']}">`);
    }
    if (artifacts['sticky.css']) {
      lines.push('<!-- ads.min.js injects sticky base styles. sticky.css is available as an optional handoff and override artifact. -->');
    }
    if (prebidEnabled && artifacts['prebid.js']) {
      lines.push(`<script src="${artifacts['prebid.js']}"></script>`);
    }
    if (artifacts['ads.min.js']) {
      lines.push(`<script src="${artifacts['ads.min.js']}"></script>`);
    }
    return lines.join('\n');
  }, [artifacts, prebidEnabled]);

  const implementation = useMemo(
    () => `${scriptTags}${scriptTags && divs ? '\n\n' : ''}${divs}\n`,
    [divs, scriptTags],
  );

  const prebidConfig = useMemo(
    () => prebidEnabled && currentBuild
      ? `${JSON.stringify({ version: currentBuild.version, modules: currentBuild.modules }, null, 2)}\n`
      : '',
    [currentBuild, prebidEnabled],
  );

  useEffect(() => {
    const url = artifacts['min-height.css'];
    if (!url) {
      setCssText('');
      return;
    }
    let cancelled = false;
    setLoadingCss(true);
    fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`CSS artifact returned ${response.status}.`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setCssText(text);
      })
      .catch(() => {
        if (!cancelled) setCssText('');
      })
      .finally(() => {
        if (!cancelled) setLoadingCss(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

  useEffect(() => {
    const url = artifacts['sticky.css'];
    if (!url) {
      setStickyCssText('');
      setLoadingStickyCss(false);
      return;
    }
    let cancelled = false;
    setLoadingStickyCss(true);
    fetch(url, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Sticky CSS artifact returned ${response.status}.`);
        return response.text();
      })
      .then((text) => {
        if (!cancelled) setStickyCssText(text);
      })
      .catch(() => {
        if (!cancelled) setStickyCssText('');
      })
      .finally(() => {
        if (!cancelled) setLoadingStickyCss(false);
      });
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

  async function copyText(value: string, label: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError('Clipboard access was blocked by the browser.');
    }
  }

  async function downloadPackage(): Promise<void> {
    if (!Object.values(artifacts).some(Boolean)) {
      setError('Generate a release before downloading an implementation package.');
      return;
    }

    setBuildingZip(true);
    setError(null);
    try {
      const files: Record<string, Uint8Array> = {};
      for (const name of ARTIFACT_ORDER) {
        const url = artifacts[name];
        if (!url) continue;
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
          if (name === 'ads.js' || name === 'ads.min.js') {
            throw new Error(`${name} returned ${response.status}.`);
          }
          continue;
        }
        files[name] = new Uint8Array(await response.arrayBuffer());
      }

      const readme = [
        'Prebid Professor implementation package',
        `Site: ${site.name}`,
        `Domain: ${site.domain}`,
        `Site ID: ${site.id}`,
        `GAM path: ${site.gamPath}`,
        `Demand mode: ${prebidEnabled ? 'GAM + Prebid' : 'GAM / AdX only'}`,
        'Sticky styling: ads.js injects base styles automatically; sticky.css is included for review and optional external integration.',
        `Source: ${source}`,
        `Version: ${sourceVersion}`,
        `Generated package: ${new Date().toISOString()}`,
        '',
        prebidEnabled
          ? 'Load prebid.js before ads.min.js, as shown in implementation.html.'
          : 'Prebid is disabled. Do not add a prebid.js script tag.',
        '',
      ].join('\n');
      files['README.txt'] = new TextEncoder().encode(readme);

      const zipped = zipSync(files, { level: 6 });
      downloadBlob(
        new Blob([zipped], { type: 'application/zip' }),
        `${safeFileName(site.domain)}-${safeFileName(sourceVersion)}-${source}.zip`,
      );
    } catch (packageError) {
      setError(packageError instanceof Error ? packageError.message : 'Implementation package could not be created.');
    } finally {
      setBuildingZip(false);
    }
  }

  if (loading) {
    return <div className="config-loading">Loading export workspace from D1 and R2…</div>;
  }

  return (
    <section className="export-page">
      <div className="export-toolbar">
        <div>
          <span className="panel-kicker">Implementation and handoff</span>
          <h2>Export</h2>
          <p>Copy publisher tags, download release artifacts and create one complete ZIP package for the selected source.</p>
        </div>
        <div className="export-toolbar-actions">
          <button className="button secondary" onClick={() => void load()} type="button">Refresh</button>
          <button className="button primary" disabled={buildingZip || !Object.values(artifacts).some(Boolean)} onClick={() => void downloadPackage()} type="button">
            {buildingZip ? 'Building ZIP…' : 'Download full ZIP'}
          </button>
        </div>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}

      <div className="export-source-panel">
        <div>
          <span className="panel-kicker">Artifact source</span>
          <h3>{sourceVersion}</h3>
          <p>{prebidEnabled ? 'GAM + Prebid' : 'GAM / AdX only'} · {activeUnits.length} active ad unit(s)</p>
        </div>
        <div className="export-source-options" role="radiogroup" aria-label="Export source">
          <label className={source === 'current' ? 'selected' : ''}>
            <input checked={source === 'current'} disabled={!productionRelease} name="export-source" onChange={() => setSource('current')} type="radio" />
            <span>Production current</span>
            <small>{productionRelease?.version ?? 'Not published'}</small>
          </label>
          <label className={source === 'staging' ? 'selected' : ''}>
            <input checked={source === 'staging'} disabled={!stagingRelease} name="export-source" onChange={() => setSource('staging')} type="radio" />
            <span>Staging</span>
            <small>{stagingRelease?.version ?? 'Not published'}</small>
          </label>
          <label className={source === 'release' ? 'selected' : ''}>
            <input checked={source === 'release'} disabled={!releases.length} name="export-source" onChange={() => setSource('release')} type="radio" />
            <span>Immutable release</span>
            <select
              disabled={!releases.length}
              onChange={(event) => {
                setSelectedReleaseId(event.target.value);
                setSource('release');
              }}
              value={selectedReleaseId}
            >
              {releases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.version} · {release.status}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {!releases.length ? (
        <div className="export-empty">
          <h3>No generated release yet</h3>
          <p>Open Releases, validate the site and generate the first draft. The Export tab will then expose all implementation files.</p>
        </div>
      ) : null}

      <div className="export-grid">
        <article className="export-card export-card-wide">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Publisher implementation</span><h3>Full HTML handoff</h3></div>
            <div className="export-card-actions">
              <button onClick={() => void copyText(implementation, 'implementation')} type="button">{copied === 'implementation' ? '✓ Copied' : 'Copy'}</button>
              <button onClick={() => downloadText(implementation, `implementation-${safeFileName(site.id)}.html`, 'text/html')} type="button">Download</button>
            </div>
          </div>
          <pre className="export-code">{implementation || 'Generate a release to create implementation tags.'}</pre>
        </article>

        <article className="export-card">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Containers</span><h3>Ad unit divs</h3></div>
            <div className="export-card-actions">
              <button onClick={() => void copyText(divs, 'divs')} type="button">{copied === 'divs' ? '✓ Copied' : 'Copy'}</button>
              <button onClick={() => downloadText(csv, `div-export-${safeFileName(site.id)}.csv`, 'text/csv;charset=utf-8')} type="button">CSV</button>
            </div>
          </div>
          <pre className="export-code compact">{divs || 'No active ad units.'}</pre>
        </article>

        <article className="export-card">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Layout stability</span><h3>Minimum-height CSS</h3></div>
            <div className="export-card-actions">
              <button disabled={!cssText} onClick={() => void copyText(cssText, 'css')} type="button">{copied === 'css' ? '✓ Copied' : 'Copy'}</button>
              <button disabled={!cssText} onClick={() => downloadText(cssText, `min-height-${safeFileName(site.id)}.css`, 'text/css')} type="button">Download</button>
            </div>
          </div>
          <pre className="export-code compact">{loadingCss ? 'Loading CSS artifact…' : cssText || 'CSS artifact is not available for this source.'}</pre>
        </article>

        <article className="export-card">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Sticky handoff</span><h3>Sticky CSS</h3></div>
            <div className="export-card-actions">
              <button disabled={!stickyCssText} onClick={() => void copyText(stickyCssText, 'sticky-css')} type="button">{copied === 'sticky-css' ? '✓ Copied' : 'Copy'}</button>
              <button disabled={!stickyCssText} onClick={() => downloadText(stickyCssText, `sticky-${safeFileName(site.id)}.css`, 'text/css')} type="button">Download</button>
            </div>
          </div>
          <p className="export-card-note">ads.js already injects the base sticky styles. Export this file only for implementation handoff or controlled overrides.</p>
          <pre className="export-code compact">{loadingStickyCss ? 'Loading sticky CSS artifact…' : stickyCssText || 'Sticky CSS is not available for this source.'}</pre>
        </article>

        <article className="export-card">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Prebid.org</span><h3>Build configuration</h3></div>
            <div className="export-card-actions">
              <button disabled={!prebidConfig} onClick={() => void copyText(prebidConfig, 'prebid-config')} type="button">{copied === 'prebid-config' ? '✓ Copied' : 'Copy'}</button>
              <button disabled={!prebidConfig} onClick={() => downloadText(prebidConfig, `prebid-config-${safeFileName(site.id)}.json`, 'application/json')} type="button">Download</button>
            </div>
          </div>
          <pre className="export-code compact">
            {prebidEnabled
              ? prebidConfig || 'No current Prebid build is available.'
              : 'Prebid is disabled for this site. No Prebid build config is required.'}
          </pre>
        </article>

        <article className="export-card">
          <div className="export-card-heading">
            <div><span className="panel-kicker">Site summary</span><h3>Handoff facts</h3></div>
          </div>
          <dl className="export-facts">
            <div><dt>Site</dt><dd>{site.name}</dd></div>
            <div><dt>Domain</dt><dd>{site.domain}</dd></div>
            <div><dt>GAM path</dt><dd><code>{site.gamPath}</code></dd></div>
            <div><dt>Demand</dt><dd>{prebidEnabled ? 'GAM + Prebid' : 'GAM / AdX only'}</dd></div>
            <div><dt>Version</dt><dd><code>{sourceVersion}</code></dd></div>
            <div><dt>Published</dt><dd>{formatTime(source === 'current' ? productionRelease?.publishedAt ?? null : source === 'staging' ? stagingRelease?.publishedAt ?? null : selectedRelease?.publishedAt ?? null)}</dd></div>
          </dl>
        </article>

        <article className="export-card export-card-wide">
          <div className="export-card-heading">
            <div><span className="panel-kicker">R2 / CDN</span><h3>Release artifacts</h3></div>
          </div>
          <div className="export-artifact-list">
            {ARTIFACT_ORDER.map((name) => {
              const url = artifacts[name];
              const hiddenForAdx = name === 'prebid.js' && !prebidEnabled;
              return (
                <div className={hiddenForAdx ? 'inactive' : ''} key={name}>
                  <code>{name}</code>
                  <span>{hiddenForAdx ? 'Not loaded in AdX-only implementation' : url || 'Not available'}</span>
                  <button disabled={!url} onClick={() => url && void copyText(url, `artifact-${name}`)} type="button">
                    {copied === `artifact-${name}` ? '✓' : 'Copy URL'}
                  </button>
                  <a aria-disabled={!url} href={url || undefined} rel="noreferrer" target="_blank">Open</a>
                </div>
              );
            })}
          </div>
        </article>
      </div>
    </section>
  );
}
