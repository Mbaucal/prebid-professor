import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

type Props = {
  publisherId: string;
  releases: Array<{
    id: string;
    version: string;
    status: 'draft' | 'staging' | 'production' | 'archived' | 'failed';
    createdAt: string;
  }>;
};

type DeploymentTarget = {
  id: string;
  publisherId: string;
  name: string;
  provider: 'cloudflare-pages';
  accountId: string;
  projectName: string;
  githubEnvironment: string;
  productionBranch: string;
  previewBranch: string;
  publicBaseUrl: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type ExternalDeployment = {
  id: string;
  publisherId: string;
  targetId: string;
  targetName: string | null;
  projectName: string | null;
  releaseId: string;
  releaseVersion: string;
  channel: 'staging' | 'production';
  status: 'queued' | 'running' | 'success' | 'failed';
  correlationId: string;
  githubRunId: string | null;
  githubRunUrl: string | null;
  deploymentUrl: string | null;
  aliasUrl: string | null;
  message: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type TargetsResponse = {
  ok: true;
  targets: DeploymentTarget[];
  deployments: ExternalDeployment[];
  orchestrator: {
    githubConfigured: boolean;
    callbackConfigured: boolean;
    repository: string;
    workflow: string;
  };
};

type TargetResponse = {
  ok: true;
  target: DeploymentTarget | null;
};

type DeploymentResponse = {
  ok: true;
  deployment: ExternalDeployment | null;
  actionsUrl?: string;
};

type TargetForm = {
  name: string;
  accountId: string;
  projectName: string;
  githubEnvironment: string;
  productionBranch: string;
  previewBranch: string;
  publicBaseUrl: string;
  enabled: boolean;
};

const emptyForm: TargetForm = {
  name: '',
  accountId: '',
  projectName: '',
  githubEnvironment: '',
  productionBranch: 'main',
  previewBranch: 'staging',
  publicBaseUrl: '',
  enabled: true,
};

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

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const text = await response.text();
  let payload: (T & { error?: string; details?: unknown }) | null = null;
  try {
    payload = text ? (JSON.parse(text) as T & { error?: string; details?: unknown }) : null;
  } catch {
    throw new Error(text || `Request failed with status ${response.status}.`);
  }

  if (!response.ok) {
    const details = payload?.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload?.error || `Request failed with status ${response.status}.`}${details}`);
  }
  return payload as T;
}

function targetToForm(target: DeploymentTarget): TargetForm {
  return {
    name: target.name,
    accountId: target.accountId,
    projectName: target.projectName,
    githubEnvironment: target.githubEnvironment,
    productionBranch: target.productionBranch,
    previewBranch: target.previewBranch,
    publicBaseUrl: target.publicBaseUrl ?? '',
    enabled: target.enabled,
  };
}

export default function ExternalDeploymentsPanel({ publisherId, releases }: Props) {
  const [targets, setTargets] = useState<DeploymentTarget[]>([]);
  const [deployments, setDeployments] = useState<ExternalDeployment[]>([]);
  const [orchestrator, setOrchestrator] = useState<TargetsResponse['orchestrator'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingTarget, setEditingTarget] = useState<DeploymentTarget | null>(null);
  const [form, setForm] = useState<TargetForm>(emptyForm);
  const [savingTarget, setSavingTarget] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState('');
  const [selectedReleaseId, setSelectedReleaseId] = useState('');
  const [channel, setChannel] = useState<'staging' | 'production'>('staging');
  const [dispatching, setDispatching] = useState(false);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<TargetsResponse>(
        `/api/publishers/${encodeURIComponent(publisherId)}/deployment-targets`,
      );
      setTargets(payload.targets);
      setDeployments(payload.deployments);
      setOrchestrator(payload.orchestrator);
      setSelectedTargetId((current) => {
        if (current && payload.targets.some((target) => target.id === current && target.enabled)) return current;
        return payload.targets.find((target) => target.enabled)?.id ?? '';
      });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Deployment targets could not be loaded.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!deployments.some((deployment) => deployment.status === 'queued' || deployment.status === 'running')) return;
    const timer = window.setInterval(() => void load(true), 5000);
    return () => window.clearInterval(timer);
  }, [deployments, load]);

  const selectedTarget = useMemo(
    () => targets.find((target) => target.id === selectedTargetId) ?? null,
    [selectedTargetId, targets],
  );

  const eligibleReleases = useMemo(() => {
    return releases.filter((release) =>
      channel === 'production'
        ? release.status === 'production'
        : ['draft', 'staging', 'production', 'archived'].includes(release.status),
    );
  }, [channel, releases]);

  useEffect(() => {
    setSelectedReleaseId((current) => {
      if (current && eligibleReleases.some((release) => release.id === current)) return current;
      return eligibleReleases[0]?.id ?? '';
    });
  }, [eligibleReleases]);

  const selectedRelease = useMemo(
    () => eligibleReleases.find((release) => release.id === selectedReleaseId) ?? null,
    [eligibleReleases, selectedReleaseId],
  );

  const orchestratorReady = Boolean(orchestrator?.githubConfigured && orchestrator?.callbackConfigured);

  function updateForm<K extends keyof TargetForm>(key: K, value: TargetForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function openCreate() {
    setEditingTarget(null);
    setForm(emptyForm);
    setError(null);
    setSuccess(null);
    setFormOpen(true);
  }

  function openEdit(target: DeploymentTarget) {
    setEditingTarget(target);
    setForm(targetToForm(target));
    setError(null);
    setSuccess(null);
    setFormOpen(true);
  }

  function closeForm() {
    if (savingTarget) return;
    setFormOpen(false);
    setEditingTarget(null);
    setForm(emptyForm);
  }

  async function saveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setSavingTarget(true);
    try {
      const payload = await requestJson<TargetResponse>(
        editingTarget
          ? `/api/publishers/${encodeURIComponent(publisherId)}/deployment-targets/${encodeURIComponent(editingTarget.id)}`
          : `/api/publishers/${encodeURIComponent(publisherId)}/deployment-targets`,
        {
          method: editingTarget ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: form.name.trim(),
            accountId: form.accountId.trim(),
            projectName: form.projectName.trim(),
            githubEnvironment: form.githubEnvironment.trim(),
            productionBranch: form.productionBranch.trim(),
            previewBranch: form.previewBranch.trim(),
            publicBaseUrl: form.publicBaseUrl.trim() || null,
            enabled: form.enabled,
          }),
        },
      );
      setSuccess(payload.target ? `Saved deployment target ${payload.target.name}.` : 'Deployment target saved.');
      setFormOpen(false);
      setEditingTarget(null);
      await load(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Deployment target could not be saved.');
    } finally {
      setSavingTarget(false);
    }
  }

  async function removeTarget(target: DeploymentTarget) {
    const confirmation = window.prompt(
      `Delete deployment target ${target.name}?\n\nType the Pages project name to continue.`,
    );
    if (confirmation !== target.projectName) return;

    setError(null);
    setSuccess(null);
    try {
      await requestJson<{ ok: true; deletedId: string }>(
        `/api/publishers/${encodeURIComponent(publisherId)}/deployment-targets/${encodeURIComponent(target.id)}`,
        { method: 'DELETE' },
      );
      setSuccess(`Deleted deployment target ${target.name}.`);
      await load(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Deployment target could not be deleted.');
    }
  }

  async function dispatch() {
    if (!selectedTarget || !selectedRelease) return;

    if (channel === 'production') {
      const confirmation = window.prompt(
        `Deploy release ${selectedRelease.version} to the external PRODUCTION Pages project ${selectedTarget.projectName}?\n\nType the exact release version to continue.`,
      );
      if (confirmation !== selectedRelease.version) return;
    } else if (!window.confirm(
      `Deploy ${selectedRelease.version} to the ${selectedTarget.previewBranch} preview branch of ${selectedTarget.projectName}?`,
    )) {
      return;
    }

    setDispatching(true);
    setError(null);
    setSuccess(null);
    try {
      const payload = await requestJson<DeploymentResponse>(
        `/api/publishers/${encodeURIComponent(publisherId)}/deployment-targets/${encodeURIComponent(selectedTarget.id)}/dispatch`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ releaseId: selectedRelease.id, channel }),
        },
      );
      setSuccess(
        payload.deployment
          ? `Queued ${selectedRelease.version} for ${selectedTarget.name}. GitHub Actions is now deploying it.`
          : 'Deployment workflow queued.',
      );
      await load(true);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'External deployment could not be started.');
    } finally {
      setDispatching(false);
    }
  }

  return (
    <section className="external-deployments-page">
      <div className="external-deploy-toolbar">
        <div>
          <span className="panel-kicker">Cross-account delivery</span>
          <h3>Cloudflare Pages deployment targets</h3>
          <p>
            Deploy an immutable release to a Pages project in another Cloudflare account. Cloudflare API tokens stay
            in GitHub repository secrets and are never stored in the browser or D1.
          </p>
        </div>
        <div className="external-deploy-toolbar-actions">
          <button className="button secondary" disabled={loading} onClick={() => void load()} type="button">
            {loading ? 'Loading…' : 'Refresh status'}
          </button>
          <button className="button primary" onClick={openCreate} type="button">＋ Add target</button>
        </div>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {success ? <div className="release-success">✓ {success}</div> : null}

      <div className={`external-orchestrator-state ${orchestratorReady ? 'ready' : 'blocked'}`}>
        <div>
          <strong>{orchestratorReady ? 'GitHub deployment runner ready' : 'Deployment runner needs secrets'}</strong>
          <span>
            {orchestrator?.repository ?? 'Mbaucal/prebid-professor'} · {orchestrator?.workflow ?? 'deploy-pages-release.yml'}
          </span>
        </div>
        <div>
          <code>GitHub {orchestrator?.githubConfigured ? '✓' : 'missing'}</code>
          <code>Callback {orchestrator?.callbackConfigured ? '✓' : 'missing'}</code>
        </div>
      </div>

      {formOpen ? (
        <form className="external-target-form" onSubmit={saveTarget}>
          <div className="external-target-form-heading">
            <div>
              <span className="panel-kicker">Non-secret destination metadata</span>
              <h4>{editingTarget ? `Edit ${editingTarget.name}` : 'Create deployment target'}</h4>
            </div>
            <button className="icon-button" onClick={closeForm} type="button">×</button>
          </div>

          <div className="external-target-fields">
            <label>
              <span>Target name</span>
              <input onChange={(event) => updateForm('name', event.target.value)} placeholder="Politika production CDN" required value={form.name} />
            </label>
            <label>
              <span>Cloudflare Account ID</span>
              <input autoComplete="off" onChange={(event) => updateForm('accountId', event.target.value)} placeholder="32-character account ID" required value={form.accountId} />
            </label>
            <label>
              <span>Pages project name</span>
              <input onChange={(event) => updateForm('projectName', event.target.value.toLowerCase())} placeholder="politika" required value={form.projectName} />
            </label>
            <label>
              <span>GitHub repository secret name</span>
              <input onChange={(event) => updateForm('githubEnvironment', event.target.value)} placeholder="CLOUDFLARE_API_TOKEN_POLITIKA" required value={form.githubEnvironment} />
              <small>Enter the exact Repository secret name that contains the target account's Cloudflare API token. Never paste the token value here.</small>
            </label>
            <label>
              <span>Production branch</span>
              <input onChange={(event) => updateForm('productionBranch', event.target.value)} placeholder="main" required value={form.productionBranch} />
            </label>
            <label>
              <span>Preview / staging branch</span>
              <input onChange={(event) => updateForm('previewBranch', event.target.value)} placeholder="staging" required value={form.previewBranch} />
            </label>
            <label className="wide">
              <span>Public base URL</span>
              <input onChange={(event) => updateForm('publicBaseUrl', event.target.value)} placeholder="https://cdn.example.com (optional)" value={form.publicBaseUrl} />
            </label>
            <label className="external-enabled-check">
              <input checked={form.enabled} onChange={(event) => updateForm('enabled', event.target.checked)} type="checkbox" />
              <span>Target enabled</span>
            </label>
          </div>

          <div className="modal-actions">
            <button className="button secondary" disabled={savingTarget} onClick={closeForm} type="button">Cancel</button>
            <button className="button primary" disabled={savingTarget} type="submit">
              {savingTarget ? 'Saving…' : 'Save target'}
            </button>
          </div>
        </form>
      ) : null}

      <div className="external-target-grid">
        {targets.map((target) => (
          <article className={`external-target-card ${target.enabled ? 'enabled' : 'disabled'}`} key={target.id}>
            <div className="external-target-card-heading">
              <div>
                <span className="panel-kicker">{target.provider}</span>
                <h4>{target.name}</h4>
                <p>{target.projectName}</p>
              </div>
              <span className={target.enabled ? 'external-target-status enabled' : 'external-target-status disabled'}>
                {target.enabled ? 'ENABLED' : 'DISABLED'}
              </span>
            </div>
            <dl>
              <div><dt>Account ID</dt><dd><code>{target.accountId}</code></dd></div>
              <div><dt>Repository secret</dt><dd><code>{target.githubEnvironment}</code></dd></div>
              <div><dt>Production</dt><dd><code>{target.productionBranch}</code></dd></div>
              <div><dt>Preview</dt><dd><code>{target.previewBranch}</code></dd></div>
              <div><dt>Public URL</dt><dd>{target.publicBaseUrl ? <a href={target.publicBaseUrl} rel="noreferrer" target="_blank">Open ↗</a> : '—'}</dd></div>
            </dl>
            <div className="external-target-actions">
              <button onClick={() => openEdit(target)} type="button">Edit</button>
              <button className="danger-link" onClick={() => void removeTarget(target)} type="button">Delete</button>
            </div>
          </article>
        ))}

        {!loading && !targets.length ? (
          <button className="external-target-empty" onClick={openCreate} type="button">
            ＋ Add the first Cloudflare Pages destination
          </button>
        ) : null}
      </div>

      <article className="external-dispatch-card">
        <div className="external-dispatch-heading">
          <div>
            <span className="panel-kicker">GitHub Actions runner</span>
            <h4>Deploy a release package</h4>
            <p>The selected immutable release is downloaded, given an explicit CORS _headers file and deployed with Wrangler.</p>
          </div>
        </div>

        <div className="external-dispatch-fields">
          <label>
            <span>Target</span>
            <select onChange={(event) => setSelectedTargetId(event.target.value)} value={selectedTargetId}>
              <option value="">Select target</option>
              {targets.filter((target) => target.enabled).map((target) => (
                <option key={target.id} value={target.id}>{target.name} · {target.projectName}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Channel</span>
            <select onChange={(event) => setChannel(event.target.value as 'staging' | 'production')} value={channel}>
              <option value="staging">staging / preview</option>
              <option value="production">production</option>
            </select>
          </label>
          <label>
            <span>Release</span>
            <select onChange={(event) => setSelectedReleaseId(event.target.value)} value={selectedReleaseId}>
              <option value="">Select release</option>
              {eligibleReleases.map((release) => (
                <option key={release.id} value={release.id}>
                  {release.version} · {release.status} · {formatTime(release.createdAt)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button primary"
            disabled={!orchestratorReady || !selectedTarget || !selectedRelease || dispatching}
            onClick={() => void dispatch()}
            type="button"
          >
            {dispatching ? 'Queuing…' : channel === 'production' ? 'Deploy production ↗' : 'Deploy staging ↗'}
          </button>
        </div>

        {!orchestratorReady ? (
          <p className="external-dispatch-warning">
            Add Worker secrets GITHUB_ACTIONS_TOKEN and DEPLOY_CALLBACK_SECRET before dispatching.
          </p>
        ) : null}
        {channel === 'production' && !eligibleReleases.length ? (
          <p className="external-dispatch-warning">Publish a release to the internal production channel before external production deployment.</p>
        ) : null}
      </article>

      <div className="external-history-heading">
        <div><span className="panel-kicker">Last 100 dispatches</span><h4>External deployment history</h4></div>
        <span>{deployments.length} deployment(s)</span>
      </div>

      <div className="external-deployment-list">
        {deployments.map((deployment) => (
          <article className={`external-deployment-row ${deployment.status}`} key={deployment.id}>
            <div>
              <span className={`external-deployment-status ${deployment.status}`}>{deployment.status.toUpperCase()}</span>
              <strong>{deployment.releaseVersion}</strong>
              <small>{deployment.targetName ?? deployment.projectName ?? deployment.targetId} · {deployment.channel}</small>
            </div>
            <div className="external-deployment-timing">
              <span>{formatTime(deployment.createdAt)}</span>
              <small>{deployment.message ?? 'Waiting for workflow callback.'}</small>
            </div>
            <div className="external-deployment-links">
              {deployment.githubRunUrl ? <a href={deployment.githubRunUrl} rel="noreferrer" target="_blank">GitHub run ↗</a> : null}
              {deployment.deploymentUrl ? <a href={deployment.deploymentUrl} rel="noreferrer" target="_blank">Deployment ↗</a> : null}
              {deployment.aliasUrl ? <a href={deployment.aliasUrl} rel="noreferrer" target="_blank">Alias ↗</a> : null}
            </div>
          </article>
        ))}

        {!loading && !deployments.length ? (
          <div className="external-deployment-empty">No cross-account deployments have been queued for this site.</div>
        ) : null}
      </div>
    </section>
  );
}
