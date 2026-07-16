import { useCallback, useEffect, useMemo, useState } from 'react';

type JsonRecord = Record<string, unknown>;
type FilterMode = 'include' | 'exclude';

type CatalogItem = {
  name: string;
  moduleCode: string;
  label: string;
  description: string;
  registration: string;
  defaultParams: JsonRecord;
  defaultStorage: JsonRecord | null;
};

type StoredModule = {
  id: string;
  name: string;
  moduleCode: string;
  enabled: boolean;
  params: JsonRecord;
  storage: JsonRecord | null;
  bidders: string[];
  value: JsonRecord | null;
  notes: string | null;
};

type StoredConfig = {
  enabled: boolean;
  syncEnabled: boolean;
  aliasSyncEnabled: boolean;
  syncsPerBidder: number;
  syncDelay: number;
  auctionDelay: number;
  filterSettings: {
    all: {
      bidders: '*' | string[];
      filter: FilterMode;
    };
  };
  ppid: string | null;
  autoRefresh: boolean;
  retainConfig: boolean;
  enforceStorageType: boolean;
  idPriority: JsonRecord;
  modules: StoredModule[];
};

type UserIdResponse = {
  ok: true;
  userIdConfig: StoredConfig;
  userSyncPreview: JsonRecord;
  requiredModules: string[];
  catalog: CatalogItem[];
  warnings: string[];
};

type EditorModule = Omit<StoredModule, 'params' | 'storage' | 'bidders' | 'value'> & {
  paramsText: string;
  storageText: string;
  biddersText: string;
  valueText: string;
};

type EditorConfig = Omit<StoredConfig, 'modules' | 'idPriority' | 'filterSettings'> & {
  filterMode: FilterMode;
  filterBiddersText: string;
  idPriorityText: string;
  modules: EditorModule[];
};

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
};

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function blankConfig(): EditorConfig {
  return {
    enabled: true,
    syncEnabled: true,
    aliasSyncEnabled: true,
    syncsPerBidder: 5,
    syncDelay: 3000,
    auctionDelay: 150,
    filterMode: 'include',
    filterBiddersText: '*',
    ppid: null,
    autoRefresh: false,
    retainConfig: true,
    enforceStorageType: false,
    idPriorityText: '{}',
    modules: [],
  };
}

function editorModule(module: StoredModule): EditorModule {
  return {
    id: module.id,
    name: module.name,
    moduleCode: module.moduleCode,
    enabled: module.enabled,
    paramsText: pretty(module.params ?? {}),
    storageText: module.storage ? pretty(module.storage) : '',
    biddersText: module.bidders.join(', '),
    valueText: module.value ? pretty(module.value) : '',
    notes: module.notes,
  };
}

function editorConfig(config: StoredConfig): EditorConfig {
  const filterBidders = config.filterSettings?.all?.bidders;
  return {
    enabled: config.enabled,
    syncEnabled: config.syncEnabled,
    aliasSyncEnabled: config.aliasSyncEnabled,
    syncsPerBidder: config.syncsPerBidder,
    syncDelay: config.syncDelay,
    auctionDelay: config.auctionDelay,
    filterMode: config.filterSettings?.all?.filter ?? 'include',
    filterBiddersText: filterBidders === '*' ? '*' : (filterBidders ?? []).join(', '),
    ppid: config.ppid,
    autoRefresh: config.autoRefresh,
    retainConfig: config.retainConfig,
    enforceStorageType: config.enforceStorageType,
    idPriorityText: pretty(config.idPriority ?? {}),
    modules: config.modules.map(editorModule),
  };
}

function parseObject(text: string, field: string, nullable = false): JsonRecord | null {
  const trimmed = text.trim();
  if (!trimmed && nullable) return null;
  if (!trimmed) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${field} is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object${nullable ? ' or empty' : ''}.`);
  }
  return parsed as JsonRecord;
}

function splitList(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[;,\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

function toStoredConfig(config: EditorConfig): StoredConfig {
  const filterBidders = config.filterBiddersText.trim() === '*'
    ? '*'
    : splitList(config.filterBiddersText);

  return {
    enabled: config.enabled,
    syncEnabled: config.syncEnabled,
    aliasSyncEnabled: config.aliasSyncEnabled,
    syncsPerBidder: Number(config.syncsPerBidder),
    syncDelay: Number(config.syncDelay),
    auctionDelay: Number(config.auctionDelay),
    filterSettings: { all: { bidders: filterBidders, filter: config.filterMode } },
    ppid: config.ppid?.trim() || null,
    autoRefresh: config.autoRefresh,
    retainConfig: config.retainConfig,
    enforceStorageType: config.enforceStorageType,
    idPriority: parseObject(config.idPriorityText, 'ID priority') ?? {},
    modules: config.modules.map((module, index) => ({
      id: module.id || uid(),
      name: module.name.trim(),
      moduleCode: module.moduleCode.trim(),
      enabled: module.enabled,
      params: parseObject(module.paramsText, `Module ${index + 1} params`) ?? {},
      storage: parseObject(module.storageText, `Module ${index + 1} storage`, true),
      bidders: splitList(module.biddersText),
      value: parseObject(module.valueText, `Module ${index + 1} value`, true),
      notes: module.notes?.trim() || null,
    })),
  };
}

function compilePreview(config: StoredConfig): JsonRecord {
  const userIds = config.enabled
    ? config.modules
        .filter((module) => module.enabled)
        .map((module) => {
          const entry: JsonRecord = { name: module.name };
          if (Object.keys(module.params).length) entry.params = module.params;
          if (module.storage) entry.storage = module.storage;
          if (module.bidders.length) entry.bidders = module.bidders;
          if (module.value) entry.value = module.value;
          return entry;
        })
    : [];

  const result: JsonRecord = {
    syncEnabled: config.syncEnabled,
    aliasSyncEnabled: config.aliasSyncEnabled,
    syncsPerBidder: config.syncsPerBidder,
    syncDelay: config.syncDelay,
    auctionDelay: config.auctionDelay,
    filterSettings: config.filterSettings,
    autoRefresh: config.autoRefresh,
    retainConfig: config.retainConfig,
    enforceStorageType: config.enforceStorageType,
    userIds,
  };
  if (config.ppid) result.ppid = config.ppid;
  if (Object.keys(config.idPriority).length) result.idPriority = config.idPriority;
  return result;
}

function moduleFromCatalog(item: CatalogItem): EditorModule {
  return {
    id: uid(),
    name: item.name,
    moduleCode: item.moduleCode,
    enabled: true,
    paramsText: pretty(item.defaultParams),
    storageText: item.defaultStorage ? pretty(item.defaultStorage) : '',
    biddersText: '',
    valueText: '',
    notes: null,
  };
}

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string; details?: unknown };
  if (!response.ok) {
    const details = payload.details ? ` ${JSON.stringify(payload.details)}` : '';
    throw new Error(`${payload.error || `Request failed with ${response.status}.`}${details}`);
  }
  return payload;
}

export default function UserIdModulesPanel({ publisherId, onChanged }: Props) {
  const [config, setConfig] = useState<EditorConfig>(blankConfig());
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [requiredModules, setRequiredModules] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [catalogName, setCatalogName] = useState('sharedId');
  const [importText, setImportText] = useState('');
  const [copyState, setCopyState] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<UserIdResponse>(
        `/api/publishers/${encodeURIComponent(publisherId)}/user-id-config`,
      );
      setConfig(editorConfig(payload.userIdConfig));
      setCatalog(payload.catalog);
      setRequiredModules(payload.requiredModules);
      setWarnings(payload.warnings);
      if (payload.catalog.length && !payload.catalog.some((item) => item.name === catalogName)) {
        setCatalogName(payload.catalog[0].name);
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User ID configuration could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [catalogName, publisherId]);

  useEffect(() => {
    void load();
  }, [publisherId]);

  const localResult = useMemo(() => {
    try {
      const stored = toStoredConfig(config);
      return { stored, preview: compilePreview(stored), error: null as string | null };
    } catch (localError) {
      return {
        stored: null,
        preview: null,
        error: localError instanceof Error ? localError.message : 'Local configuration is invalid.',
      };
    }
  }, [config]);

  const activeCount = config.modules.filter((module) => module.enabled).length;

  function updateConfig<K extends keyof EditorConfig>(key: K, value: EditorConfig[K]) {
    setConfig((current) => ({ ...current, [key]: value }));
    setSaved(null);
  }

  function updateModule(id: string, patch: Partial<EditorModule>) {
    updateConfig(
      'modules',
      config.modules.map((module) => (module.id === id ? { ...module, ...patch } : module)),
    );
  }

  function addCatalogModule(name = catalogName) {
    const item = catalog.find((candidate) => candidate.name === name);
    if (!item) return;
    if (config.modules.some((module) => module.name.toLowerCase() === item.name.toLowerCase())) {
      setError(`${item.label} already exists in this site configuration.`);
      return;
    }
    updateConfig('modules', [...config.modules, moduleFromCatalog(item)]);
    setError(null);
  }

  function addCommonSet() {
    const existing = new Set(config.modules.map((module) => module.name.toLowerCase()));
    const additions = catalog
      .filter((item) => !existing.has(item.name.toLowerCase()))
      .map(moduleFromCatalog);
    updateConfig('modules', [...config.modules, ...additions]);
    setError(null);
  }

  function addCustomModule() {
    updateConfig('modules', [
      ...config.modules,
      {
        id: uid(),
        name: 'customId',
        moduleCode: 'customIdSystem',
        enabled: true,
        paramsText: '{}',
        storageText: '',
        biddersText: '',
        valueText: '',
        notes: 'Replace name and module code with the exact values from the official Prebid documentation.',
      },
    ]);
  }

  function duplicateModule(module: EditorModule) {
    updateConfig('modules', [
      ...config.modules,
      {
        ...module,
        id: uid(),
        name: `${module.name}Copy`,
        moduleCode: `${module.moduleCode}Copy`,
        notes: module.notes ? `${module.notes} Copy.` : 'Copied module; update its name and module code.',
      },
    ]);
  }

  function removeModule(module: EditorModule) {
    if (!window.confirm(`Remove ${module.name} from this site configuration?`)) return;
    updateConfig('modules', config.modules.filter((item) => item.id !== module.id));
  }

  async function save() {
    if (!localResult.stored) {
      setError(localResult.error || 'Fix local JSON errors before saving.');
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(null);
    try {
      const payload = await requestJson<UserIdResponse>(
        `/api/publishers/${encodeURIComponent(publisherId)}/user-id-config`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(localResult.stored),
        },
      );
      setConfig(editorConfig(payload.userIdConfig));
      setRequiredModules(payload.requiredModules);
      setWarnings(payload.warnings);
      setSaved('User ID configuration saved. Prebid build requirements were updated.');
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'User ID configuration could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  function importNativeUserSync() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch (parseError) {
      setError(`Import JSON is invalid: ${parseError instanceof Error ? parseError.message : 'parse error'}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setError('Import must be a userSync JSON object.');
      return;
    }
    const userSync = parsed as JsonRecord;
    const rawUserIds = Array.isArray(userSync.userIds) ? userSync.userIds : [];
    const importedModules: EditorModule[] = rawUserIds.map((entry, index) => {
      const object = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as JsonRecord) : {};
      const name = String(object.name ?? `customId${index + 1}`);
      const preset = catalog.find((item) => item.name === name);
      return {
        id: uid(),
        name,
        moduleCode: preset?.moduleCode ?? `${name}System`,
        enabled: true,
        paramsText: pretty(object.params && typeof object.params === 'object' ? object.params : {}),
        storageText: object.storage && typeof object.storage === 'object' ? pretty(object.storage) : '',
        biddersText: Array.isArray(object.bidders) ? object.bidders.join(', ') : '',
        valueText: object.value && typeof object.value === 'object' ? pretty(object.value) : '',
        notes: 'Imported from native Prebid userSync JSON.',
      };
    });

    const filterSettings = userSync.filterSettings && typeof userSync.filterSettings === 'object'
      ? (userSync.filterSettings as JsonRecord)
      : {};
    const all = filterSettings.all && typeof filterSettings.all === 'object'
      ? (filterSettings.all as JsonRecord)
      : {};
    const bidders = all.bidders;

    setConfig((current) => ({
      ...current,
      syncEnabled: typeof userSync.syncEnabled === 'boolean' ? userSync.syncEnabled : current.syncEnabled,
      aliasSyncEnabled:
        typeof userSync.aliasSyncEnabled === 'boolean' ? userSync.aliasSyncEnabled : current.aliasSyncEnabled,
      syncsPerBidder: Number(userSync.syncsPerBidder ?? current.syncsPerBidder),
      syncDelay: Number(userSync.syncDelay ?? current.syncDelay),
      auctionDelay: Number(userSync.auctionDelay ?? current.auctionDelay),
      filterMode: all.filter === 'exclude' ? 'exclude' : 'include',
      filterBiddersText: bidders === '*' ? '*' : Array.isArray(bidders) ? bidders.join(', ') : '*',
      ppid: typeof userSync.ppid === 'string' ? userSync.ppid : null,
      autoRefresh: typeof userSync.autoRefresh === 'boolean' ? userSync.autoRefresh : current.autoRefresh,
      retainConfig: typeof userSync.retainConfig === 'boolean' ? userSync.retainConfig : current.retainConfig,
      enforceStorageType:
        typeof userSync.enforceStorageType === 'boolean' ? userSync.enforceStorageType : current.enforceStorageType,
      idPriorityText:
        userSync.idPriority && typeof userSync.idPriority === 'object' ? pretty(userSync.idPriority) : '{}',
      modules: importedModules,
    }));
    setError(null);
    setSaved('Native userSync JSON imported locally. Review partner IDs and click Save.');
  }

  async function copyPreview() {
    if (!localResult.preview) return;
    try {
      await navigator.clipboard.writeText(pretty(localResult.preview));
      setCopyState(true);
      window.setTimeout(() => setCopyState(false), 1800);
    } catch {
      setError('Clipboard access was blocked by the browser.');
    }
  }

  return (
    <section className="user-id-page">
      <div className="config-toolbar user-id-toolbar">
        <div>
          <span className="panel-kicker">Prebid identity configuration</span>
          <h2>User ID modules</h2>
          <p>
            Configure the native <code>userSync</code> object per site. Enabled submodules automatically become
            required modules in the Prebid.js build workspace.
          </p>
        </div>
        <div className="user-id-toolbar-actions">
          <span className={config.enabled ? 'identity-state enabled' : 'identity-state disabled'}>
            {config.enabled ? `${activeCount} active` : 'disabled'}
          </span>
          <button className="button primary" disabled={saving || Boolean(localResult.error)} onClick={() => void save()} type="button">
            {saving ? 'Saving…' : 'Save User ID config'}
          </button>
        </div>
      </div>

      {error ? <div className="form-error config-error">{error}</div> : null}
      {localResult.error ? <div className="form-error config-error">{localResult.error}</div> : null}
      {saved ? <div className="identity-save-message">✓ {saved}</div> : null}
      {warnings.map((warning) => <div className="identity-warning" key={warning}>⚠ {warning}</div>)}
      {loading ? <div className="config-loading">Loading User ID configuration…</div> : null}

      <div className="user-id-layout">
        <div className="user-id-main">
          <article className="identity-card identity-global-card">
            <div className="identity-card-heading">
              <div>
                <span className="panel-kicker">Global userSync</span>
                <h3>Sync and auction timing</h3>
              </div>
              <label className="identity-toggle">
                <input checked={config.enabled} onChange={(event) => updateConfig('enabled', event.target.checked)} type="checkbox" />
                <span>User ID enabled</span>
              </label>
            </div>

            <div className="identity-toggle-grid">
              <label><input checked={config.syncEnabled} onChange={(event) => updateConfig('syncEnabled', event.target.checked)} type="checkbox" /><span>Cookie sync enabled</span></label>
              <label><input checked={config.aliasSyncEnabled} onChange={(event) => updateConfig('aliasSyncEnabled', event.target.checked)} type="checkbox" /><span>Alias sync enabled</span></label>
              <label><input checked={config.autoRefresh} onChange={(event) => updateConfig('autoRefresh', event.target.checked)} type="checkbox" /><span>Auto-refresh IDs</span></label>
              <label><input checked={config.retainConfig} onChange={(event) => updateConfig('retainConfig', event.target.checked)} type="checkbox" /><span>Retain previous config</span></label>
              <label><input checked={config.enforceStorageType} onChange={(event) => updateConfig('enforceStorageType', event.target.checked)} type="checkbox" /><span>Enforce storage type</span></label>
            </div>

            <div className="identity-field-grid four">
              <label><span>Auction delay</span><div className="number-with-unit"><input min="0" max="10000" onChange={(event) => updateConfig('auctionDelay', Number(event.target.value))} type="number" value={config.auctionDelay} /><b>ms</b></div><small>Maximum initial auction delay for IDs.</small></label>
              <label><span>Sync delay</span><div className="number-with-unit"><input min="0" max="120000" onChange={(event) => updateConfig('syncDelay', Number(event.target.value))} type="number" value={config.syncDelay} /><b>ms</b></div><small>Delay after the first bid request.</small></label>
              <label><span>Syncs per bidder</span><input min="0" max="50" onChange={(event) => updateConfig('syncsPerBidder', Number(event.target.value))} type="number" value={config.syncsPerBidder} /></label>
              <label><span>GAM PPID source</span><input onChange={(event) => updateConfig('ppid', event.target.value)} placeholder="gpid.id5-sync.com" value={config.ppid ?? ''} /><small>Optional EID source used as GAM PPID.</small></label>
            </div>

            <div className="identity-field-grid filter-grid">
              <label><span>Global filter</span><select onChange={(event) => updateConfig('filterMode', event.target.value as FilterMode)} value={config.filterMode}><option value="include">include</option><option value="exclude">exclude</option></select></label>
              <label className="wide"><span>Filter bidders</span><input onChange={(event) => updateConfig('filterBiddersText', event.target.value)} placeholder="* or openx, pubmatic" value={config.filterBiddersText} /><small>Use <code>*</code> for all bidders or a comma-separated list.</small></label>
            </div>

            <details className="identity-advanced-json">
              <summary>Advanced ID priority</summary>
              <label><span>idPriority JSON</span><textarea onChange={(event) => updateConfig('idPriorityText', event.target.value)} rows={5} value={config.idPriorityText} /><small>Example: {`{"uid2":["liveIntentId","uid2"]}`}</small></label>
            </details>
          </article>

          <article className="identity-card identity-catalog-card">
            <div className="identity-card-heading">
              <div><span className="panel-kicker">Submodules</span><h3>Configured identity providers</h3><p>Add known presets or a custom Prebid User ID submodule.</p></div>
              <div className="identity-add-controls">
                <select onChange={(event) => setCatalogName(event.target.value)} value={catalogName}>
                  {catalog.map((item) => <option key={item.name} value={item.name}>{item.label}</option>)}
                </select>
                <button className="button secondary" onClick={() => addCatalogModule()} type="button">＋ Add</button>
                <button className="button secondary" onClick={addCommonSet} type="button">Add common set</button>
                <button className="button secondary" onClick={addCustomModule} type="button">Custom</button>
              </div>
            </div>

            <div className="identity-module-list">
              {config.modules.map((module, index) => {
                const preset = catalog.find((item) => item.name === module.name);
                return (
                  <article className={module.enabled ? 'identity-module-card enabled' : 'identity-module-card disabled'} key={module.id}>
                    <div className="identity-module-heading">
                      <div><span className="identity-order">{index + 1}</span><div><h4>{preset?.label ?? module.name}</h4><code>{module.moduleCode}</code></div></div>
                      <div className="identity-module-actions">
                        <label className="identity-toggle compact"><input checked={module.enabled} onChange={(event) => updateModule(module.id, { enabled: event.target.checked })} type="checkbox" /><span>{module.enabled ? 'Enabled' : 'Disabled'}</span></label>
                        <button onClick={() => duplicateModule(module)} type="button">Copy</button>
                        <button className="danger-link" onClick={() => removeModule(module)} type="button">Remove</button>
                      </div>
                    </div>

                    {preset ? <div className="identity-preset-note"><b>{preset.description}</b><span>{preset.registration}</span></div> : null}

                    <div className="identity-field-grid two">
                      <label><span>Prebid config name</span><input onChange={(event) => updateModule(module.id, { name: event.target.value })} value={module.name} /></label>
                      <label><span>Build module code</span><input onChange={(event) => updateModule(module.id, { moduleCode: event.target.value })} value={module.moduleCode} /></label>
                    </div>

                    <div className="identity-json-grid">
                      <label><span>params JSON</span><textarea onChange={(event) => updateModule(module.id, { paramsText: event.target.value })} rows={7} value={module.paramsText} /></label>
                      <label><span>storage JSON</span><textarea onChange={(event) => updateModule(module.id, { storageText: event.target.value })} placeholder="Leave empty when the module uses its own caching." rows={7} value={module.storageText} /></label>
                    </div>

                    <div className="identity-field-grid two">
                      <label><span>Allowed bidders</span><input onChange={(event) => updateModule(module.id, { biddersText: event.target.value })} placeholder="Empty = all bidders; or openx, pubmatic" value={module.biddersText} /></label>
                      <label><span>Notes</span><input onChange={(event) => updateModule(module.id, { notes: event.target.value })} placeholder="Partner account, approval or rollout note" value={module.notes ?? ''} /></label>
                    </div>

                    <details className="identity-advanced-json">
                      <summary>Externally supplied value</summary>
                      <label><span>value JSON</span><textarea onChange={(event) => updateModule(module.id, { valueText: event.target.value })} placeholder="Only use when the publisher supplies the ID through another integration." rows={5} value={module.valueText} /></label>
                    </details>
                  </article>
                );
              })}

              {!config.modules.length ? <div className="identity-empty">No User ID submodules are configured. Add a preset above or import existing userSync JSON.</div> : null}
            </div>
          </article>
        </div>

        <aside className="user-id-side">
          <article className="identity-card identity-required-card">
            <span className="panel-kicker">Prebid build</span>
            <h3>Required modules</h3>
            <p>These must be present in the active prebid.js build.</p>
            <div className="identity-required-modules">
              {requiredModules.map((module) => <code key={module}>{module}</code>)}
              {!requiredModules.length ? <span>No active identity modules.</span> : null}
            </div>
          </article>

          <article className="identity-card identity-preview-card">
            <div className="identity-card-heading compact"><div><span className="panel-kicker">Generated output</span><h3>userSync preview</h3></div><button className="button secondary" disabled={!localResult.preview} onClick={() => void copyPreview()} type="button">{copyState ? '✓ Copied' : 'Copy'}</button></div>
            <pre>{localResult.preview ? pretty(localResult.preview) : localResult.error}</pre>
          </article>

          <article className="identity-card identity-import-card">
            <span className="panel-kicker">Migration helper</span>
            <h3>Import existing userSync</h3>
            <p>Paste the object currently used inside <code>pbjs.setConfig({`{ userSync: ... }`})</code>.</p>
            <textarea onChange={(event) => setImportText(event.target.value)} placeholder={'{\n  "auctionDelay": 150,\n  "userIds": [...]\n}'} rows={10} value={importText} />
            <button className="button secondary" disabled={!importText.trim()} onClick={importNativeUserSync} type="button">Import locally</button>
          </article>
        </aside>
      </div>
    </section>
  );
}
