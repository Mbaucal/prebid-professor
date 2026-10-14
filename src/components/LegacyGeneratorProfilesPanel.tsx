import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';

type Props = {
  publisherId: string;
};

type GeneratorEngine = 'legacy-frozen-v1' | 'legacy-advanced-refresh-v1';

type GeneratorProfile = {
  schemaVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  engine: GeneratorEngine;
  createdAt: string;
  createdBy: string;
  templateFileName: string;
  templateSize: number;
  templateSha256: string;
  sourceFileName: string | null;
  sourceSize: number | null;
  sourceSha256: string | null;
  baseProfileId: string | null;
  immutableTemplate: boolean;
  capabilities: {
    perSlotPrebidTimeout: boolean;
    perSlotCmpWait: boolean;
    fixedRefresh: boolean;
    firstThenFixedRefresh: boolean;
    percentageRefresh: boolean;
    sequenceRefresh: boolean;
    accumulatedViewTime: boolean;
  };
};

type CreateMode = 'upload' | 'derive';

type ProfileForm = {
  id: string;
  name: string;
  version: string;
  description: string;
  engine: GeneratorEngine;
  baseProfileId: string;
};

const ENGINES: Array<{ value: GeneratorEngine; label: string; description: string }> = [
  {
    value: 'legacy-frozen-v1',
    label: 'Frozen legacy runtime',
    description: 'Keeps the uploaded ads.js behavior unchanged and only patches configuration values.',
  },
  {
    value: 'legacy-advanced-refresh-v1',
    label: 'Legacy + advanced refresh',
    description: 'Uses the same frozen template and adds per-slot CMP wait plus configurable refresh schedules.',
  },
];

function emptyForm(): ProfileForm {
  return {
    id: '',
    name: '',
    version: '3.8.1',
    description: '',
    engine: 'legacy-frozen-v1',
    baseProfileId: '',
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function formatBytes(bytes: number | null): string {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDate(value: string): string {
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
  const payload = (await response.json()) as T & { error?: string; details?: unknown };
  if (!response.ok) throw new Error(payload.error || `Request failed with status ${response.status}.`);
  return payload;
}

export default function GeneratorProfilesPanel({ publisherId }: Props) {
  const [profiles, setProfiles] = useState<GeneratorProfile[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [mode, setMode] = useState<CreateMode>('upload');
  const [form, setForm] = useState<ProfileForm>(emptyForm());
  const [templateFile, setTemplateFile] = useState<File | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [profilesPayload, selectionPayload] = await Promise.all([
        requestJson<{ ok: true; profiles: GeneratorProfile[] }>('/api/generator-profiles'),
        requestJson<{ ok: true; profileId: string | null }>(
          `/api/publishers/${encodeURIComponent(publisherId)}/generator-selection`,
        ),
      ]);
      setProfiles(profilesPayload.profiles);
      setSelectedProfileId(selectionPayload.profileId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Generator profiles could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId],
  );

  function openUpload() {
    setMode('upload');
    setForm(emptyForm());
    setTemplateFile(null);
    setSourceFile(null);
    setError(null);
    setShowForm(true);
  }

  function openDerived(profile: GeneratorProfile) {
    setMode('derive');
    setForm({
      id: `${profile.id}-advanced`,
      name: `${profile.name} · advanced`,
      version: profile.version,
      description: `Derived from ${profile.id}. The source template remains unchanged.`,
      engine: 'legacy-advanced-refresh-v1',
      baseProfileId: profile.id,
    });
    setTemplateFile(null);
    setSourceFile(null);
    setError(null);
    setShowForm(true);
  }

  function closeForm() {
    if (submitting) return;
    setShowForm(false);
    setError(null);
  }

  function updateForm<K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function templateChanged(event: ChangeEvent<HTMLInputElement>) {
    setTemplateFile(event.target.files?.[0] ?? null);
  }

  function sourceChanged(event: ChangeEvent<HTMLInputElement>) {
    setSourceFile(event.target.files?.[0] ?? null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    if (!form.id || !form.name || !form.version) {
      setError('Profile ID, name and version are required.');
      return;
    }
    if (mode === 'upload' && !templateFile) {
      setError('Choose the frozen ads.js template.');
      return;
    }
    if (mode === 'derive' && !form.baseProfileId) {
      setError('Choose a base profile.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'upload') {
        const body = new FormData();
        body.append('id', form.id);
        body.append('name', form.name);
        body.append('version', form.version);
        body.append('description', form.description);
        body.append('engine', form.engine);
        body.append('template', templateFile!, templateFile!.name);
        if (sourceFile) body.append('source', sourceFile, sourceFile.name);
        await requestJson('/api/generator-profiles', { method: 'POST', body });
      } else {
        await requestJson(
          `/api/generator-profiles/${encodeURIComponent(form.baseProfileId)}/duplicate`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: form.id,
              name: form.name,
              version: form.version,
              description: form.description,
              engine: form.engine,
            }),
          },
        );
      }
      setShowForm(false);
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Generator profile could not be saved.');
    } finally {
      setSubmitting(false);
    }
  }

  async function selectProfile(profileId: string | null) {
    setBusyId(profileId ?? 'none');
    setError(null);
    try {
      await requestJson(
        `/api/publishers/${encodeURIComponent(publisherId)}/generator-selection`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profileId }),
        },
      );
      setSelectedProfileId(profileId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Generator profile could not be selected.');
    } finally {
      setBusyId(null);
    }
  }

  async function removeProfile(profile: GeneratorProfile) {
    const answer = window.prompt(
      `Delete generator profile ${profile.name}?\n\nType the exact profile ID to confirm:\n${profile.id}`,
    );
    if (answer !== profile.id) return;

    setBusyId(profile.id);
    setError(null);
    try {
      await requestJson(`/api/generator-profiles/${encodeURIComponent(profile.id)}`, { method: 'DELETE' });
      await load();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Generator profile could not be deleted.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <section className="generator-profiles-page">
        <div className="config-toolbar generator-profile-toolbar">
          <div>
            <span className="panel-kicker">Imported script templates</span>
            <h2>Imported templates</h2>
            <p>
              Keep the current production ads.js logic frozen. New behavior is created as a derived profile,
              so an older release can always be reproduced with the exact same runtime source.
            </p>
          </div>
          <button className="button primary" onClick={openUpload} type="button">＋ Import template</button>
        </div>

        {error ? <div className="form-error config-error">{error}</div> : null}
        {loading ? <div className="config-loading">Loading generator profiles from R2…</div> : null}

        <article className="active-generator-card">
          <div>
            <span className="panel-kicker">Selected for this site</span>
            <h3>{selectedProfile?.name ?? 'No imported template selected'}</h3>
            <p>
              {selectedProfile
                ? `${selectedProfile.id} · ${selectedProfile.engine}`
                : 'Use Script setup to generate with the built-in script. An imported template is optional.'}
            </p>
          </div>
          {selectedProfile ? (
            <button className="button secondary" disabled={busyId !== null} onClick={() => void selectProfile(null)} type="button">
              Clear selection
            </button>
          ) : null}
        </article>

        <div className="generator-profile-grid">
          {profiles.map((profile) => {
            const selected = profile.id === selectedProfileId;
            const advanced = profile.engine === 'legacy-advanced-refresh-v1';
            return (
              <article className={selected ? 'generator-profile-card selected' : 'generator-profile-card'} key={profile.id}>
                <div className="generator-profile-heading">
                  <div>
                    <span className={advanced ? 'profile-engine advanced' : 'profile-engine frozen'}>
                      {advanced ? 'Advanced engine' : 'Imported template'}
                    </span>
                    <h3>{profile.name}</h3>
                    <code>{profile.id}</code>
                  </div>
                  {selected ? <span className="profile-selected-badge">Selected</span> : null}
                </div>

                <p>{profile.description || 'No description.'}</p>

                <div className="profile-facts">
                  <div><span>Version</span><strong>{profile.version}</strong></div>
                  <div><span>Template</span><strong>{profile.templateFileName}</strong></div>
                  <div><span>Template size</span><strong>{formatBytes(profile.templateSize)}</strong></div>
                  <div><span>Source archive</span><strong>{profile.sourceFileName ?? 'Not attached'}</strong></div>
                  <div><span>Created</span><strong>{formatDate(profile.createdAt)}</strong></div>
                  <div><span>Base profile</span><strong>{profile.baseProfileId ?? 'Original import'}</strong></div>
                </div>

                <details className="profile-capabilities">
                  <summary>Capabilities and hashes</summary>
                  <div className="capability-pills">
                    <span>Per-slot PB timeout</span>
                    {profile.capabilities.perSlotCmpWait ? <span>Per-slot CMP wait</span> : null}
                    {profile.capabilities.firstThenFixedRefresh ? <span>First → fixed</span> : null}
                    {profile.capabilities.percentageRefresh ? <span>Percentage backoff</span> : null}
                    {profile.capabilities.sequenceRefresh ? <span>Sequence schedule</span> : null}
                    {profile.capabilities.accumulatedViewTime ? <span>Accumulated view time</span> : null}
                  </div>
                  <code>template sha256: {profile.templateSha256}</code>
                  {profile.sourceSha256 ? <code>source sha256: {profile.sourceSha256}</code> : null}
                </details>

                <div className="generator-profile-actions">
                  <button
                    className={selected ? 'button secondary' : 'button primary'}
                    disabled={selected || busyId !== null}
                    onClick={() => void selectProfile(profile.id)}
                    type="button"
                  >
                    {selected ? 'In use' : 'Use for this site'}
                  </button>
                  <button className="button secondary" disabled={busyId !== null} onClick={() => openDerived(profile)} type="button">
                    Create derived profile
                  </button>
                  <a className="button secondary" href={`/api/generator-profiles/${encodeURIComponent(profile.id)}/template/download`}>
                    Download template
                  </a>
                  {profile.sourceFileName ? (
                    <a className="button secondary" href={`/api/generator-profiles/${encodeURIComponent(profile.id)}/source/download`}>
                      Download source
                    </a>
                  ) : null}
                  <button className="button danger" disabled={busyId !== null} onClick={() => void removeProfile(profile)} type="button">
                    Delete
                  </button>
                </div>
              </article>
            );
          })}

          {!loading && profiles.length === 0 ? (
            <button className="empty-generator-profile" onClick={openUpload} type="button">
              <b>Import the current production generator</b>
              <span>Use the uploaded ads.js as the frozen template and attach Server.zip as its source archive.</span>
            </button>
          ) : null}
        </div>
      </section>

      {showForm ? (
        <div className="modal-backdrop" onMouseDown={closeForm} role="presentation">
          <section className="modal-card generator-profile-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Runtime source workflow</span>
                <h2>{mode === 'upload' ? 'Import frozen generator profile' : 'Create derived generator profile'}</h2>
              </div>
              <button className="icon-button" onClick={closeForm} type="button">×</button>
            </div>

            <form className="publisher-form generator-profile-form" onSubmit={submit}>
              <div className="profile-mode-switch">
                <button className={mode === 'upload' ? 'active' : ''} onClick={() => setMode('upload')} type="button">Upload source</button>
                <button className={mode === 'derive' ? 'active' : ''} disabled={!profiles.length} onClick={() => setMode('derive')} type="button">Derive from profile</button>
              </div>

              {mode === 'derive' ? (
                <label>
                  <span>Base profile</span>
                  <select onChange={(event) => updateForm('baseProfileId', event.target.value)} value={form.baseProfileId}>
                    <option value="">Select profile</option>
                    {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.id}</option>)}
                  </select>
                </label>
              ) : null}

              <label>
                <span>Profile name</span>
                <input
                  autoFocus
                  onChange={(event) => {
                    const name = event.target.value;
                    setForm((current) => ({ ...current, name, id: current.id || slugify(name) }));
                  }}
                  placeholder="Legacy v3.8.1 · frozen"
                  value={form.name}
                />
              </label>

              <label>
                <span>Profile ID</span>
                <input onChange={(event) => updateForm('id', slugify(event.target.value))} placeholder="legacy-v3.8.1" value={form.id} />
              </label>

              <label>
                <span>Runtime version</span>
                <input onChange={(event) => updateForm('version', event.target.value)} placeholder="3.8.1" value={form.version} />
              </label>

              <label>
                <span>Generator engine</span>
                <select onChange={(event) => updateForm('engine', event.target.value as GeneratorEngine)} value={form.engine}>
                  {ENGINES.map((engine) => <option key={engine.value} value={engine.value}>{engine.label}</option>)}
                </select>
                <small>{ENGINES.find((engine) => engine.value === form.engine)?.description}</small>
              </label>

              <label className="profile-description-field">
                <span>Description</span>
                <textarea onChange={(event) => updateForm('description', event.target.value)} rows={3} value={form.description} />
              </label>

              {mode === 'upload' ? (
                <>
                  <label className="profile-file-field">
                    <span>Frozen ads.js template</span>
                    <input accept=".js,.txt,text/javascript,application/javascript,text/plain" onChange={templateChanged} type="file" />
                    <small>{templateFile ? `${templateFile.name} · ${formatBytes(templateFile.size)}` : 'Required. The template is immutable after upload.'}</small>
                  </label>
                  <label className="profile-file-field">
                    <span>Generator source archive</span>
                    <input accept=".zip,application/zip" onChange={sourceChanged} type="file" />
                    <small>{sourceFile ? `${sourceFile.name} · ${formatBytes(sourceFile.size)}` : 'Optional but recommended: attach Server.zip.'}</small>
                  </label>
                </>
              ) : (
                <div className="profile-derive-note">
                  The template and source hashes are copied exactly from the base profile. Only the external engine behavior changes.
                </div>
              )}

              {error ? <div className="form-error">{error}</div> : null}
              <div className="modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeForm} type="button">Cancel</button>
                <button className="button primary" disabled={submitting} type="submit">
                  {submitting ? 'Saving…' : mode === 'upload' ? 'Import frozen profile' : 'Create derived profile'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
