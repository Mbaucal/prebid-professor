import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { api } from '../api';
import type { Bidder } from '../shared/types';

type Props = {
  publisherId: string;
  siteName: string;
};

type ModuleGroup = {
  id: string;
  title: string;
  description: string;
  modules: string[];
};

type BuildAnalysis = {
  fileName: string;
  fileSize: number;
  version: string | null;
  modules: string[];
  missingAdapters: string[];
  missingSelectedModules: string[];
  extraModules: string[];
  usedFallbackDetection: boolean;
  error: string | null;
};

type StoredBuildStatus = 'current' | 'archived' | 'invalid';

type StoredBuild = {
  id: string;
  publisherId: string;
  version: string;
  fileKey: string;
  fileName: string;
  fileSize: number;
  modules: string[];
  status: StoredBuildStatus;
  uploadedBy: string | null;
  uploadedAt: string;
  missingAdapters: string[];
  valid: boolean;
  downloadUrl: string;
  contentHash: string | null;
};

type BuildsResponse = {
  ok: true;
  requiredAdapters: string[];
  builds: StoredBuild[];
};

type BuildResponse = {
  ok: true;
  build: StoredBuild | null;
  warnings?: string[];
};

const PREBID_DOWNLOAD_URL = 'https://docs.prebid.org/download.html';
const PREBID_VERSIONS_URL = 'https://js-download.prebid.org/versions';

const MODULE_GROUPS: ModuleGroup[] = [
  {
    id: 'privacy',
    title: 'Privacy & GAM recommended',
    description: 'Core consent, activity-control and GAM preparation modules.',
    modules: [
      'consentManagementGpp',
      'consentManagementTcf',
      'gppControl_usnat',
      'gppControl_usstates',
      'gptPreAuction',
      'storageControl',
      'tcfControl',
    ],
  },
  {
    id: 'auction',
    title: 'Auction controls',
    description: 'Modules used by the current wrapper for pricing, floors and supply-chain data.',
    modules: ['currency', 'priceFloors', 'schain'],
  },
  {
    id: 'identity',
    title: 'User ID',
    description: 'Identity modules used in the existing Prebid Professor setup.',
    modules: [
      'userId',
      'criteoIdSystem',
      'id5IdSystem',
      'lotamePanoramaIdSystem',
      'sharedIdSystem',
      'teadsIdSystem',
    ],
  },
  {
    id: 'analytics',
    title: 'Analytics',
    description: 'Optional analytics adapters included in the current production build.',
    modules: ['id5AnalyticsAdapter'],
  },
];

const DEFAULT_PLATFORM_MODULES = MODULE_GROUPS.flatMap((group) => group.modules);

const BIDDER_MODULE_ALIASES: Record<string, string> = {
  connectad: 'connectadBidAdapter',
  criteo: 'criteoBidAdapter',
  eskimi: 'eskimiBidAdapter',
  ix: 'ixBidAdapter',
  magnite: 'magniteBidAdapter',
  ogury: 'oguryBidAdapter',
  openx: 'openxBidAdapter',
  pubmatic: 'pubmaticBidAdapter',
  richaudience: 'richaudienceBidAdapter',
  rtbhouse: 'rtbhouseBidAdapter',
  teads: 'teadsBidAdapter',
};

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string; details?: unknown };
  if (!response.ok) {
    const details = payload.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload.error || `Request failed with ${response.status}.`}${details}`);
  }
  return payload;
}

function adapterModuleForBidder(bidder: string): string {
  const normalized = bidder.trim().toLowerCase();
  return BIDDER_MODULE_ALIASES[normalized] ?? `${normalized}BidAdapter`;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function parseExtraModules(value: string): string[] {
  return uniqueSorted(value.split(/[\n,;]+/));
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTimestamp(value: string): string {
  try {
    return new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function parsePrebidBuild(
  file: File,
  text: string,
  requiredAdapters: string[],
  selectedModules: string[],
): BuildAnalysis {
  const header = text.slice(0, 500_000);
  const versionMatch = header.match(
    /prebid\.js\s+v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9._-]+)?)/i,
  );
  const modulesMatch = header.match(/Modules:\s*([\s\S]*?)\s*\*\//i);

  let modules: string[] = [];
  let usedFallbackDetection = false;

  if (modulesMatch?.[1]) {
    modules = uniqueSorted(
      modulesMatch[1]
        .replace(/[\r\n]+/g, ' ')
        .split(',')
        .map((module) => module.trim()),
    );
  }

  if (!modules.length) {
    usedFallbackDetection = true;
    const candidates = uniqueSorted([...requiredAdapters, ...selectedModules]);
    modules = candidates.filter((module) => text.includes(module));
  }

  const moduleSet = new Set(modules);
  const missingAdapters = requiredAdapters.filter((module) => !moduleSet.has(module));
  const missingSelectedModules = selectedModules.filter((module) => !moduleSet.has(module));
  const requiredSet = new Set([...requiredAdapters, ...selectedModules]);
  const extraModules = modules.filter((module) => !requiredSet.has(module));

  let error: string | null = null;
  if (!versionMatch?.[1]) error = 'Prebid version could not be read from the file header.';
  else if (!modules.length) error = 'Installed modules could not be read from the file.';

  return {
    fileName: file.name,
    fileSize: file.size,
    version: versionMatch?.[1] ?? null,
    modules,
    missingAdapters,
    missingSelectedModules,
    extraModules,
    usedFallbackDetection,
    error,
  };
}

function triggerDownload(content: string, fileName: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function PrebidBuildsPanel({ publisherId, siteName }: Props) {
  const [bidders, setBidders] = useState<Bidder[]>([]);
  const [builds, setBuilds] = useState<StoredBuild[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState('11.11.0');
  const [selectedPlatformModules, setSelectedPlatformModules] = useState<string[]>(
    DEFAULT_PLATFORM_MODULES,
  );
  const [extraModulesText, setExtraModulesText] = useState('');
  const [analysis, setAnalysis] = useState<BuildAnalysis | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copyState, setCopyState] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyBuildId, setBusyBuildId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bidderItems, buildPayload] = await Promise.all([
        api.listBidders(publisherId),
        requestJson<BuildsResponse>(
          `/api/publishers/${encodeURIComponent(publisherId)}/prebid-builds`,
        ),
      ]);
      setBidders(bidderItems);
      setBuilds(buildPayload.builds);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load Prebid workspace.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
    setAnalysis(null);
    setSelectedFile(null);
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    async function loadVersions() {
      try {
        const response = await fetch(PREBID_VERSIONS_URL);
        if (!response.ok) throw new Error(`Version service returned ${response.status}.`);
        const raw = await response.text();
        const payload = JSON.parse(raw) as { versions?: unknown };
        const list = Array.isArray(payload.versions)
          ? payload.versions.filter((item): item is string => typeof item === 'string')
          : [];
        if (!cancelled && list.length) {
          setVersions(list);
          setVersion((current) => (list.includes(current) ? current : list[0]));
        }
      } catch {
        // A manually entered version remains available when the public service is unavailable.
      }
    }

    void loadVersions();
    return () => {
      cancelled = true;
    };
  }, []);

  const enabledBidders = useMemo(
    () => bidders.filter((bidder) => bidder.enabled).sort((a, b) => a.bidder.localeCompare(b.bidder)),
    [bidders],
  );

  const requiredAdapters = useMemo(
    () => uniqueSorted(enabledBidders.map((bidder) => adapterModuleForBidder(bidder.bidder))),
    [enabledBidders],
  );

  const extraModules = useMemo(() => parseExtraModules(extraModulesText), [extraModulesText]);

  const selectedModules = useMemo(
    () => uniqueSorted([...requiredAdapters, ...selectedPlatformModules, ...extraModules]),
    [extraModules, requiredAdapters, selectedPlatformModules],
  );

  const configJson = useMemo(
    () => JSON.stringify({ version: version.trim(), modules: selectedModules }, null, 2),
    [selectedModules, version],
  );

  const currentBuild = useMemo(
    () => builds.find((build) => build.status === 'current') ?? null,
    [builds],
  );
  const multipleCurrentBuilds = builds.filter((build) => build.status === 'current').length > 1;

  function resetSelectedBuild() {
    setAnalysis(null);
    setSelectedFile(null);
  }

  function togglePlatformModule(module: string) {
    setSelectedPlatformModules((current) =>
      current.includes(module)
        ? current.filter((item) => item !== module)
        : uniqueSorted([...current, module]),
    );
    resetSelectedBuild();
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState(label);
      window.setTimeout(() => setCopyState(null), 1800);
    } catch {
      setError('Clipboard access was blocked by the browser.');
    }
  }

  function downloadConfig() {
    triggerDownload(configJson, `prebid-config-${publisherId}.json`, 'application/json');
  }

  function openPrebidBuilder() {
    const params = new URLSearchParams();
    if (version.trim()) params.set('version', version.trim());
    if (selectedModules.length) params.set('modules', selectedModules.join(','));
    window.open(`${PREBID_DOWNLOAD_URL}?${params.toString()}`, '_blank', 'noopener,noreferrer');
  }

  async function analyzeFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setAnalysis(null);
    setSelectedFile(null);

    if (!/\.js$/i.test(file.name)) {
      setError('Choose a JavaScript file ending in .js.');
      return;
    }

    if (file.size > 20 * 1024 * 1024) {
      setError('The selected file is larger than 20 MB.');
      return;
    }

    try {
      const text = await file.text();
      const result = parsePrebidBuild(file, text, requiredAdapters, selectedModules);
      setAnalysis(result);
      setSelectedFile(file);
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : 'The file could not be read.');
    }
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>) {
    void analyzeFile(event.target.files?.[0]);
    event.target.value = '';
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void analyzeFile(event.dataTransfer.files?.[0]);
  }

  async function uploadBuild() {
    if (!selectedFile || !analysis) return;
    if (analysis.error || analysis.missingAdapters.length) {
      setError('Fix the build before upload. Every enabled bidder adapter is required.');
      return;
    }

    setUploading(true);
    setError(null);
    try {
      const body = new FormData();
      body.append('file', selectedFile, selectedFile.name);
      const payload = await requestJson<BuildResponse>(
        `/api/publishers/${encodeURIComponent(publisherId)}/prebid-builds`,
        { method: 'POST', body },
      );
      await load();
      resetSelectedBuild();
      if (payload.warnings?.length) setError(payload.warnings.join(' · '));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The build could not be uploaded.');
    } finally {
      setUploading(false);
    }
  }

  async function activateBuild(build: StoredBuild) {
    setBusyBuildId(build.id);
    setError(null);
    try {
      await requestJson<BuildResponse>(
        `/api/publishers/${encodeURIComponent(publisherId)}/prebid-builds/${encodeURIComponent(build.id)}/activate`,
        { method: 'POST' },
      );
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The build could not be activated.');
    } finally {
      setBusyBuildId(null);
    }
  }

  async function removeBuild(build: StoredBuild) {
    if (!window.confirm(`Delete ${build.fileName} from R2 and build history?`)) return;
    setBusyBuildId(build.id);
    setError(null);
    try {
      await requestJson<{ ok: true; deletedId: string }>(
        `/api/publishers/${encodeURIComponent(publisherId)}/prebid-builds/${encodeURIComponent(build.id)}`,
        { method: 'DELETE' },
      );
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'The build could not be deleted.');
    } finally {
      setBusyBuildId(null);
    }
  }

  const adapterStatusOk = analysis ? analysis.missingAdapters.length === 0 : false;
  const selectedStatusOk = analysis ? analysis.missingSelectedModules.length === 0 : false;
  const uploadReady = Boolean(selectedFile && analysis && !analysis.error && adapterStatusOk);

  return (
    <section className="prebid-builds-page">
      <div className="config-toolbar prebid-build-toolbar">
        <div>
          <span className="panel-kicker">Build preparation, validation & storage</span>
          <h2>Prebid.js</h2>
          <p>
            Generate the official Prebid.org import configuration, validate the downloaded custom build and keep
            approved versions in private Cloudflare R2 storage.
          </p>
        </div>
        <span className="prebid-local-badge r2-connected">R2 build storage</span>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}

      <div className="prebid-build-layout">
        <article className="prebid-build-card prebid-config-card">
          <div className="prebid-card-heading">
            <div>
              <span className="panel-kicker">Step 1</span>
              <h3>Generate Prebid.org config</h3>
            </div>
            <span className="module-count-chip">{selectedModules.length} modules</span>
          </div>

          <div className="prebid-version-row">
            <label>
              <span>Prebid version</span>
              {versions.length ? (
                <select onChange={(event) => setVersion(event.target.value)} value={version}>
                  {versions.map((item, index) => (
                    <option key={item} value={item}>
                      {item}{index === 0 ? ' · latest' : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input onChange={(event) => setVersion(event.target.value)} value={version} />
              )}
            </label>
            <div className="prebid-version-help">
              <b>{siteName}</b>
              <span>{enabledBidders.length} enabled bidder(s) found in D1.</span>
            </div>
          </div>

          <div className="adapter-requirements">
            <div className="prebid-section-heading">
              <div>
                <h4>Required bidder adapters</h4>
                <p>Generated from enabled bidders. They cannot be unchecked here.</p>
              </div>
              {loading ? <span>Loading…</span> : null}
            </div>
            <div className="module-chip-grid">
              {enabledBidders.map((bidder) => (
                <div className="required-adapter-chip" key={bidder.id}>
                  <b>{bidder.bidder}</b>
                  <code>{adapterModuleForBidder(bidder.bidder)}</code>
                </div>
              ))}
              {!loading && enabledBidders.length === 0 ? (
                <div className="prebid-empty-note">No enabled bidders exist on this site yet.</div>
              ) : null}
            </div>
          </div>

          <div className="platform-module-groups">
            {MODULE_GROUPS.map((group) => (
              <section className="platform-module-group" key={group.id}>
                <div>
                  <h4>{group.title}</h4>
                  <p>{group.description}</p>
                </div>
                <div className="platform-module-list">
                  {group.modules.map((module) => (
                    <label className="platform-module-option" key={module}>
                      <input
                        checked={selectedPlatformModules.includes(module)}
                        onChange={() => togglePlatformModule(module)}
                        type="checkbox"
                      />
                      <code>{module}</code>
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <label className="extra-modules-field">
            <span>Additional modules</span>
            <textarea
              onChange={(event) => {
                setExtraModulesText(event.target.value);
                resetSelectedBuild();
              }}
              placeholder={'One module per line, or separated by comma\nExample: bidViewability'}
              rows={4}
              value={extraModulesText}
            />
            <small>Use exact module codes from the Prebid download page.</small>
          </label>

          <div className="prebid-config-preview">
            <div className="prebid-section-heading">
              <div>
                <h4>prebid-config.json</h4>
                <p>Accepted by “Upload Configuration” on the official download page.</p>
              </div>
            </div>
            <pre>{configJson}</pre>
          </div>

          <div className="prebid-actions">
            <button className="button secondary" onClick={() => void copyText(configJson, 'config')} type="button">
              {copyState === 'config' ? '✓ Copied' : 'Copy config'}
            </button>
            <button className="button secondary" onClick={downloadConfig} type="button">Download config</button>
            <button className="button primary" disabled={!version.trim()} onClick={openPrebidBuilder} type="button">
              Open Prebid.org builder ↗
            </button>
          </div>
        </article>

        <article className="prebid-build-card prebid-validation-card">
          <div className="prebid-card-heading">
            <div>
              <span className="panel-kicker">Step 2</span>
              <h3>Validate and store prebid.js</h3>
            </div>
            {analysis ? (
              <span className={analysis.error || !adapterStatusOk ? 'build-state invalid' : 'build-state valid'}>
                {analysis.error || !adapterStatusOk ? 'Needs attention' : 'Upload ready'}
              </span>
            ) : null}
          </div>

          <input
            accept=".js,text/javascript,application/javascript"
            className="prebid-file-input"
            onChange={handleFileInput}
            ref={fileInputRef}
            type="file"
          />

          <div
            className={`prebid-dropzone${dragging ? ' dragging' : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
          >
            <span className="prebid-drop-icon">⇧</span>
            <b>Drop prebid.js here</b>
            <span>or click to select the downloaded custom build</span>
            <small>Validation happens locally first; upload is explicit.</small>
          </div>

          {analysis ? (
            <div className="build-analysis">
              <div className="build-file-summary">
                <div><span>File</span><b>{analysis.fileName}</b></div>
                <div><span>Size</span><b>{formatBytes(analysis.fileSize)}</b></div>
                <div><span>Version</span><b>{analysis.version ?? 'Not detected'}</b></div>
                <div><span>Modules</span><b>{analysis.modules.length}</b></div>
              </div>

              {analysis.error ? <div className="prebid-analysis-warning">{analysis.error}</div> : null}
              {analysis.usedFallbackDetection ? (
                <div className="prebid-analysis-warning">
                  The standard “Modules:” header was not found, so names were detected from script text.
                </div>
              ) : null}

              <section className={adapterStatusOk ? 'analysis-section ok' : 'analysis-section missing'}>
                <div className="analysis-section-heading">
                  <h4>Required bidder adapters</h4>
                  <span>{adapterStatusOk ? '✓ OK' : `✕ ${analysis.missingAdapters.length} missing`}</span>
                </div>
                {analysis.missingAdapters.length ? (
                  <div className="module-pill-list missing">
                    {analysis.missingAdapters.map((module) => <code key={module}>{module}</code>)}
                  </div>
                ) : <p>Every enabled bidder has its adapter in this build.</p>}
              </section>

              <section className={selectedStatusOk ? 'analysis-section ok' : 'analysis-section warning'}>
                <div className="analysis-section-heading">
                  <h4>Selected platform modules</h4>
                  <span>{selectedStatusOk ? '✓ OK' : `${analysis.missingSelectedModules.length} missing`}</span>
                </div>
                {analysis.missingSelectedModules.length ? (
                  <div className="module-pill-list warning">
                    {analysis.missingSelectedModules.map((module) => <code key={module}>{module}</code>)}
                  </div>
                ) : <p>All selected platform modules were detected.</p>}
              </section>

              <details className="installed-module-details">
                <summary>Installed modules ({analysis.modules.length})</summary>
                <div className="module-pill-list">
                  {analysis.modules.map((module) => <code key={module}>{module}</code>)}
                </div>
              </details>

              <div className="r2-upload-actions">
                <button
                  className="button primary"
                  disabled={!uploadReady || uploading}
                  onClick={() => void uploadBuild()}
                  type="button"
                >
                  {uploading ? 'Uploading to R2…' : 'Upload approved build to R2'}
                </button>
                <small>
                  The first valid build becomes current automatically. Later uploads are stored as archived candidates.
                </small>
              </div>
            </div>
          ) : (
            <div className="prebid-validation-placeholder">
              <h4>Validation result will appear here</h4>
              <p>The check compares the build manifest with active bidders and selected modules.</p>
            </div>
          )}
        </article>
      </div>

      <article className="prebid-build-card prebid-history-card">
        <div className="prebid-card-heading">
          <div>
            <span className="panel-kicker">Step 3</span>
            <h3>R2 build history</h3>
            <p>Current is the build that the next release generator will use.</p>
          </div>
          <span className={currentBuild && !multipleCurrentBuilds ? 'build-state valid' : 'build-state invalid'}>
            {multipleCurrentBuilds ? 'Multiple current files — use Set current to choose one' : currentBuild ? `Current v${currentBuild.version}` : 'No current build'}
          </span>
        </div>

        {loading ? <div className="prebid-history-empty">Loading stored builds…</div> : null}
        {!loading && builds.length === 0 ? (
          <div className="prebid-history-empty">No Prebid build has been uploaded to R2 for this site.</div>
        ) : null}

        <div className="prebid-build-history-list">
          {builds.map((build) => (
            <section className={`stored-build-row ${build.status}`} key={build.id}>
              <div className="stored-build-main">
                <div className="stored-build-title">
                  <b>{build.fileName}</b>
                  <span className={`stored-build-status ${build.status}`}>{build.status}</span>
                </div>
                <div className="stored-build-meta">
                  <span>v{build.version}</span>
                  <span>{formatBytes(build.fileSize)}</span>
                  <span>{build.modules.length} modules</span>
                  <span>{formatTimestamp(build.uploadedAt)}</span>
                  <span>{build.uploadedBy ?? 'system'}</span>
                </div>
                {build.missingAdapters.length ? (
                  <div className="stored-build-missing">
                    Missing: {build.missingAdapters.join(', ')}
                  </div>
                ) : null}
                {build.contentHash ? <code className="stored-build-hash">sha256 {build.contentHash.slice(0, 16)}…</code> : null}
              </div>
              <div className="stored-build-actions">
                <a className="button secondary" href={build.downloadUrl}>Download</a>
                {(build.status !== 'current' || multipleCurrentBuilds) && build.valid ? (
                  <button
                    className="button secondary"
                    disabled={busyBuildId === build.id}
                    onClick={() => void activateBuild(build)}
                    type="button"
                  >
                    {busyBuildId === build.id ? 'Working…' : 'Set current'}
                  </button>
                ) : null}
                {build.status !== 'current' ? (
                  <button
                    className="button danger"
                    disabled={busyBuildId === build.id}
                    onClick={() => void removeBuild(build)}
                    type="button"
                  >
                    Delete
                  </button>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </article>
    </section>
  );
}
