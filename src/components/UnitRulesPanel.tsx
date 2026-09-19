import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import type {
  AdUnit,
  SizeMap,
  UnitRule,
  UnitRuleCondition,
  UnitRuleConditionalMapping,
  UnitRuleConditionOperator,
  UnitRuleConfig,
  UnitRuleMatchMode,
  UnitRuleSlotAction,
} from '../shared/types';

type Props = {
  publisherId: string;
  onChanged?: () => void | Promise<void>;
  onOpenRefresh?: () => void;
};

type FormMode = 'create' | 'edit' | 'duplicate';

type RuleForm = {
  ruleKey: string;
  overrideTimeout: boolean;
  timeout: number;
  overrideLazy: boolean;
  lazyEnabled: boolean;
  fetchMarginPx: number;
  renderMarginPx: number;
  overrideRefresh: boolean;
  refreshEnabled: boolean;
  minSeconds: number;
  minViewPct: number;
  requirePreviousViewable: boolean;
  checkEveryMs: number;
  conditionalMappings: UnitRuleConditionalMapping[];
};

const RESERVED_RULES = [
  { key: '__DEFAULT__', label: 'Default', description: 'Base behavior inherited by every ad unit.' },
  { key: '__ATF__', label: 'ATF', description: 'Overrides for all above-the-fold ad units.' },
  { key: '__BTF__', label: 'BTF', description: 'Overrides for all below-the-fold ad units.' },
] as const;

const BASELINE_RULE: Required<Pick<UnitRuleConfig, 'timeout' | 'lazy' | 'refresh'>> = {
  timeout: 2500,
  lazy: {
    enabled: false,
    fetchMarginPx: 500,
    renderMarginPx: 200,
  },
  refresh: {
    enabled: true,
    minSeconds: 30,
    minViewPct: 50,
    requirePreviousViewable: false,
    checkEveryMs: 5000,
  },
};

function uid(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function emptyCondition(): UnitRuleCondition {
  return { id: uid(), key: '', operator: 'equals', value: '' };
}

function emptyMapping(): UnitRuleConditionalMapping {
  return {
    id: uid(),
    name: 'New mapping',
    enabled: true,
    priority: 100,
    match: 'all',
    conditions: [emptyCondition()],
    sizeMapKey: null,
    slotAction: 'inherit',
  };
}

function presetForKey(ruleKey: string): UnitRuleConfig {
  if (ruleKey === '__DEFAULT__') {
    return {
      timeout: 2500,
      lazy: { enabled: false, fetchMarginPx: 500, renderMarginPx: 200 },
      refresh: {
        enabled: true,
        minSeconds: 30,
        minViewPct: 50,
        requirePreviousViewable: false,
        checkEveryMs: 5000,
      },
      conditionalMappings: [],
    };
  }

  if (ruleKey === '__ATF__') {
    return {
      timeout: 2200,
      lazy: { enabled: false, fetchMarginPx: 0, renderMarginPx: 0 },
      refresh: {
        enabled: true,
        minSeconds: 30,
        minViewPct: 60,
        requirePreviousViewable: false,
        checkEveryMs: 5000,
      },
      conditionalMappings: [],
    };
  }

  if (ruleKey === '__BTF__') {
    return {
      timeout: 2500,
      lazy: { enabled: true, fetchMarginPx: 500, renderMarginPx: 200 },
      refresh: {
        enabled: true,
        minSeconds: 30,
        minViewPct: 50,
        requirePreviousViewable: false,
        checkEveryMs: 5000,
      },
      conditionalMappings: [],
    };
  }

  return { conditionalMappings: [] };
}

function formFromRule(ruleKey: string, rule: UnitRuleConfig): RuleForm {
  return {
    ruleKey,
    overrideTimeout: rule.timeout !== undefined,
    timeout: rule.timeout ?? BASELINE_RULE.timeout,
    overrideLazy: rule.lazy !== undefined,
    lazyEnabled: rule.lazy?.enabled ?? BASELINE_RULE.lazy.enabled,
    fetchMarginPx: rule.lazy?.fetchMarginPx ?? BASELINE_RULE.lazy.fetchMarginPx,
    renderMarginPx: rule.lazy?.renderMarginPx ?? BASELINE_RULE.lazy.renderMarginPx,
    overrideRefresh: rule.refresh !== undefined,
    refreshEnabled: rule.refresh?.enabled ?? BASELINE_RULE.refresh.enabled,
    minSeconds: rule.refresh?.minSeconds ?? BASELINE_RULE.refresh.minSeconds,
    minViewPct: rule.refresh?.minViewPct ?? BASELINE_RULE.refresh.minViewPct,
    requirePreviousViewable:
      rule.refresh?.requirePreviousViewable ?? BASELINE_RULE.refresh.requirePreviousViewable,
    checkEveryMs: rule.refresh?.checkEveryMs ?? BASELINE_RULE.refresh.checkEveryMs,
    conditionalMappings: (rule.conditionalMappings ?? []).map((mapping) => ({
      ...mapping,
      conditions: mapping.conditions.map((condition) => ({ ...condition })),
    })),
  };
}

function ruleFromForm(form: RuleForm): UnitRuleConfig {
  const rule: UnitRuleConfig = {};
  if (form.overrideTimeout) rule.timeout = Number(form.timeout);
  if (form.overrideLazy) {
    rule.lazy = {
      enabled: form.lazyEnabled,
      fetchMarginPx: Number(form.fetchMarginPx),
      renderMarginPx: Number(form.renderMarginPx),
    };
  }
  if (form.overrideRefresh) {
    rule.refresh = {
      enabled: form.refreshEnabled,
      minSeconds: Number(form.minSeconds),
      minViewPct: Number(form.minViewPct),
      requirePreviousViewable: form.requirePreviousViewable,
      checkEveryMs: Number(form.checkEveryMs),
    };
  }
  if (form.conditionalMappings.length) {
    rule.conditionalMappings = form.conditionalMappings;
  }
  return rule;
}

function mergeEffectiveRule(...rules: Array<UnitRuleConfig | undefined>): UnitRuleConfig {
  const merged: UnitRuleConfig = {
    timeout: BASELINE_RULE.timeout,
    lazy: { ...BASELINE_RULE.lazy },
    refresh: { ...BASELINE_RULE.refresh },
    conditionalMappings: [],
  };

  rules.forEach((rule) => {
    if (!rule) return;
    if (rule.timeout !== undefined) merged.timeout = rule.timeout;
    if (rule.lazy) merged.lazy = { ...rule.lazy };
    if (rule.refresh) merged.refresh = { ...rule.refresh };
    if (rule.conditionalMappings?.length) {
      merged.conditionalMappings = [
        ...(merged.conditionalMappings ?? []),
        ...rule.conditionalMappings,
      ];
    }
  });

  merged.conditionalMappings = (merged.conditionalMappings ?? []).sort(
    (a, b) => b.priority - a.priority,
  );
  return merged;
}

function scopeLabel(ruleKey: string): string {
  if (ruleKey === '__DEFAULT__') return 'Default';
  if (ruleKey === '__ATF__') return 'ATF group';
  if (ruleKey === '__BTF__') return 'BTF group';
  return `Exact · ${ruleKey}`;
}

function timeoutText(rule: UnitRuleConfig): string {
  return rule.timeout === undefined ? 'Inherited' : `${rule.timeout} ms`;
}

function lazyText(rule: UnitRuleConfig): string {
  if (!rule.lazy) return 'Inherited';
  if (!rule.lazy.enabled) return 'Disabled';
  return `Auction within ${rule.lazy.fetchMarginPx}px · render within ${rule.lazy.renderMarginPx}px`;
}

function refreshText(rule: UnitRuleConfig): string {
  if (!rule.refresh) return 'Inherited';
  if (!rule.refresh.enabled) return 'Disabled';
  const previous = rule.refresh.requirePreviousViewable
    ? 'previous ad must be viewable'
    : 'blank/no-fill may retry';
  return `${rule.refresh.minSeconds}s · ${rule.refresh.minViewPct}% in view · ${previous}`;
}

export default function UnitRulesPanel({ publisherId, onChanged, onOpenRefresh }: Props) {
  const [unitRules, setUnitRules] = useState<UnitRule[]>([]);
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [sizeMaps, setSizeMaps] = useState<SizeMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [source, setSource] = useState<UnitRule | null>(null);
  const [form, setForm] = useState<RuleForm>(() => formFromRule('__DEFAULT__', presetForKey('__DEFAULT__')));
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [creatingBaseRules, setCreatingBaseRules] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rules, units, maps] = await Promise.all([
        api.listUnitRules(publisherId),
        api.listAdUnits(publisherId),
        api.listSizeMaps(publisherId),
      ]);
      setUnitRules(rules);
      setAdUnits(units);
      setSizeMaps(maps);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load unit rules.');
    } finally {
      setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
  }, [load]);

  const rulesByKey = useMemo(
    () => new Map(unitRules.map((rule) => [rule.ruleKey, rule])),
    [unitRules],
  );

  const targetOptions = useMemo(() => {
    return [
      ...RESERVED_RULES.map((item) => ({ key: item.key, label: item.label })),
      ...adUnits.map((unit) => ({ key: unit.code, label: `${unit.code} · ${unit.type}` })),
    ];
  }, [adUnits]);

  const availableTargetOptions = useMemo(() => {
    return targetOptions.filter((option) => !rulesByKey.has(option.key));
  }, [rulesByKey, targetOptions]);

  const missingReserved = RESERVED_RULES.filter((item) => !rulesByKey.has(item.key));

  function openCreate(ruleKey?: string) {
    const target = ruleKey ?? availableTargetOptions[0]?.key ?? '';
    setMode('create');
    setSource(null);
    setForm(formFromRule(target, presetForKey(target)));
    setFormError(null);
  }

  function openEdit(rule: UnitRule) {
    setMode('edit');
    setSource(rule);
    setForm(formFromRule(rule.ruleKey, rule.rule));
    setFormError(null);
  }

  function openDuplicate(rule: UnitRule) {
    const target = availableTargetOptions[0]?.key ?? '';
    setMode('duplicate');
    setSource(rule);
    setForm(formFromRule(target, rule.rule));
    setFormError(null);
  }

  function closeForm() {
    if (submitting) return;
    setMode(null);
    setSource(null);
    setFormError(null);
  }

  function updateForm<K extends keyof RuleForm>(key: K, value: RuleForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function addMapping() {
    updateForm('conditionalMappings', [...form.conditionalMappings, emptyMapping()]);
  }

  function updateMapping(mappingId: string, patch: Partial<UnitRuleConditionalMapping>) {
    updateForm(
      'conditionalMappings',
      form.conditionalMappings.map((mapping) =>
        mapping.id === mappingId ? { ...mapping, ...patch } : mapping,
      ),
    );
  }

  function removeMapping(mappingId: string) {
    updateForm(
      'conditionalMappings',
      form.conditionalMappings.filter((mapping) => mapping.id !== mappingId),
    );
  }

  function addCondition(mappingId: string) {
    updateForm(
      'conditionalMappings',
      form.conditionalMappings.map((mapping) =>
        mapping.id === mappingId
          ? { ...mapping, conditions: [...mapping.conditions, emptyCondition()] }
          : mapping,
      ),
    );
  }

  function updateCondition(
    mappingId: string,
    conditionId: string,
    patch: Partial<UnitRuleCondition>,
  ) {
    updateForm(
      'conditionalMappings',
      form.conditionalMappings.map((mapping) =>
        mapping.id === mappingId
          ? {
              ...mapping,
              conditions: mapping.conditions.map((condition) =>
                condition.id === conditionId ? { ...condition, ...patch } : condition,
              ),
            }
          : mapping,
      ),
    );
  }

  function removeCondition(mappingId: string, conditionId: string) {
    updateForm(
      'conditionalMappings',
      form.conditionalMappings.map((mapping) =>
        mapping.id === mappingId
          ? {
              ...mapping,
              conditions: mapping.conditions.filter((condition) => condition.id !== conditionId),
            }
          : mapping,
      ),
    );
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    if (!form.ruleKey) {
      setFormError('Select a rule target.');
      return;
    }

    const rule = ruleFromForm(form);
    if (
      rule.timeout === undefined &&
      rule.lazy === undefined &&
      rule.refresh === undefined &&
      !rule.conditionalMappings?.length
    ) {
      setFormError('Add at least one override or conditional mapping.');
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'edit' && source) {
        await api.updateUnitRule(publisherId, source.id, { rule });
      } else if (mode === 'duplicate' && source) {
        await api.duplicateUnitRule(publisherId, source.id, { ruleKey: form.ruleKey });
      } else {
        await api.createUnitRule(publisherId, { ruleKey: form.ruleKey, rule });
      }
      await load();
      await onChanged?.();
      closeForm();
    } catch (requestError) {
      setFormError(requestError instanceof Error ? requestError.message : 'Unit rule operation failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(rule: UnitRule) {
    if (!window.confirm(`Delete rule ${scopeLabel(rule.ruleKey)}? Its values will fall back to inherited rules.`)) {
      return;
    }
    try {
      await api.deleteUnitRule(publisherId, rule.id);
      await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not delete unit rule.');
    }
  }

  async function createBaseRules() {
    if (!missingReserved.length) return;
    setCreatingBaseRules(true);
    setError(null);
    try {
      for (const item of missingReserved) {
        await api.createUnitRule(publisherId, {
          ruleKey: item.key,
          rule: presetForKey(item.key),
        });
      }
      await load();
      await onChanged?.();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Base rules could not be created.');
    } finally {
      setCreatingBaseRules(false);
    }
  }

  const effectiveRows = useMemo(() => {
    const defaultRule = rulesByKey.get('__DEFAULT__')?.rule;
    const atfRule = rulesByKey.get('__ATF__')?.rule;
    const btfRule = rulesByKey.get('__BTF__')?.rule;

    return adUnits.map((unit) => {
      const groupRule = unit.type === 'ATF' ? atfRule : unit.type === 'BTF' ? btfRule : undefined;
      const exactRule = rulesByKey.get(unit.code)?.rule;
      return {
        unit,
        effective: mergeEffectiveRule(defaultRule, groupRule, exactRule),
        exact: Boolean(exactRule),
      };
    });
  }, [adUnits, rulesByKey]);

  return (
    <>
      <section className="unit-rules-page">
        <div className="config-toolbar">
          <div>
            <span className="panel-kicker">Auction, lazy load and refresh control</span>
            <h2>Unit rules</h2>
            <p>
              Rules inherit in order: platform baseline → Default → ATF/BTF → exact ad unit.
              Conditional mappings can select a size map or enable/disable a slot from page key-values.
            </p>
          </div>
          <div className="unit-rule-toolbar-actions">
            {onOpenRefresh ? <button className="button secondary" type="button" onClick={onOpenRefresh}>Refresh schedules</button> : null}
            {missingReserved.length ? (
              <button
                className="button secondary"
                disabled={creatingBaseRules}
                onClick={() => void createBaseRules()}
                type="button"
              >
                {creatingBaseRules ? 'Creating…' : 'Create base rules'}
              </button>
            ) : null}
            <button
              className="button primary"
              disabled={!availableTargetOptions.length}
              onClick={() => openCreate()}
              type="button"
            >
              ＋ New rule
            </button>
          </div>
        </div>

        {error ? <div className="form-error config-error">{error}</div> : null}
        {loading ? <div className="config-loading">Loading unit rules from D1…</div> : null}

        <div className="rule-inheritance-strip">
          <span>Platform baseline</span><b>→</b><span>__DEFAULT__</span><b>→</b><span>__ATF__ / __BTF__</span><b>→</b><span>Exact slot</span>
        </div>

        <div className="reserved-rules-grid">
          {RESERVED_RULES.map((item) => {
            const existing = rulesByKey.get(item.key);
            return (
              <article className={existing ? 'unit-rule-card reserved configured' : 'unit-rule-card reserved missing'} key={item.key}>
                <div className="unit-rule-heading">
                  <div>
                    <span className="rule-scope-chip">{item.label}</span>
                    <h3>{item.key}</h3>
                    <p>{item.description}</p>
                  </div>
                  <span className={existing ? 'rule-status configured' : 'rule-status inherited'}>
                    {existing ? 'configured' : 'baseline only'}
                  </span>
                </div>

                {existing ? (
                  <>
                    <div className="rule-summary-list">
                      <div><span>Timeout</span><strong>{timeoutText(existing.rule)}</strong></div>
                      <div><span>Lazy</span><strong>{lazyText(existing.rule)}</strong></div>
                      <div><span>Refresh</span><strong>{refreshText(existing.rule)}</strong></div>
                      <div><span>Key-value mappings</span><strong>{existing.rule.conditionalMappings?.length ?? 0}</strong></div>
                    </div>
                    <div className="ad-unit-actions">
                      <button onClick={() => openEdit(existing)} type="button">Edit</button>
                      <button disabled={!availableTargetOptions.length} onClick={() => openDuplicate(existing)} type="button">Copy to…</button>
                      <button className="danger-link" onClick={() => void remove(existing)} type="button">Delete</button>
                    </div>
                  </>
                ) : (
                  <button className="add-reserved-rule" onClick={() => openCreate(item.key)} type="button">
                    ＋ Configure {item.label}
                  </button>
                )}
              </article>
            );
          })}
        </div>

        <div className="unit-rules-section-heading">
          <div>
            <span className="panel-kicker">Exact overrides</span>
            <h3>Rules by ad unit</h3>
          </div>
          <span>{unitRules.filter((rule) => !RESERVED_RULES.some((item) => item.key === rule.ruleKey)).length} exact rule(s)</span>
        </div>

        <div className="exact-rules-grid">
          {unitRules
            .filter((rule) => !RESERVED_RULES.some((item) => item.key === rule.ruleKey))
            .map((rule) => (
              <article className="unit-rule-card exact configured" key={rule.id}>
                <div className="unit-rule-heading">
                  <div>
                    <span className="rule-scope-chip exact">Exact</span>
                    <h3>{rule.ruleKey}</h3>
                    <p>Overrides inherited behavior only for this ad unit.</p>
                  </div>
                  <span className="rule-status configured">configured</span>
                </div>
                <div className="rule-summary-list">
                  <div><span>Timeout</span><strong>{timeoutText(rule.rule)}</strong></div>
                  <div><span>Lazy</span><strong>{lazyText(rule.rule)}</strong></div>
                  <div><span>Refresh</span><strong>{refreshText(rule.rule)}</strong></div>
                  <div><span>Key-value mappings</span><strong>{rule.rule.conditionalMappings?.length ?? 0}</strong></div>
                </div>
                <div className="ad-unit-actions">
                  <button onClick={() => openEdit(rule)} type="button">Edit</button>
                  <button disabled={!availableTargetOptions.length} onClick={() => openDuplicate(rule)} type="button">Copy to…</button>
                  <button className="danger-link" onClick={() => void remove(rule)} type="button">Delete</button>
                </div>
              </article>
            ))}

          {!loading && !unitRules.some((rule) => !RESERVED_RULES.some((item) => item.key === rule.ruleKey)) ? (
            <button className="empty-rule-card" disabled={!availableTargetOptions.some((option) => !option.key.startsWith('__'))} onClick={() => {
              const firstExact = availableTargetOptions.find((option) => !option.key.startsWith('__'));
              if (firstExact) openCreate(firstExact.key);
            }} type="button">
              ＋ Add an exact rule for Billboard, P1, Sticky or another ad unit
            </button>
          ) : null}
        </div>

        <div className="unit-rules-section-heading effective-heading">
          <div>
            <span className="panel-kicker">Resolved configuration</span>
            <h3>Effective behavior by ad unit</h3>
          </div>
          <span>Includes inheritance</span>
        </div>

        <div className="effective-rule-table-wrap">
          <table className="effective-rule-table">
            <thead>
              <tr>
                <th>Ad unit</th>
                <th>Scope</th>
                <th>Timeout</th>
                <th>Lazy auction</th>
                <th>Refresh</th>
                <th>Mappings</th>
              </tr>
            </thead>
            <tbody>
              {effectiveRows.map(({ unit, effective, exact }) => (
                <tr key={unit.id}>
                  <td><strong>{unit.code}</strong><small>{unit.type}</small></td>
                  <td>{exact ? 'Exact override' : `${unit.type} inherited`}</td>
                  <td>{effective.timeout} ms</td>
                  <td>{effective.lazy?.enabled ? `${effective.lazy.fetchMarginPx}px → ${effective.lazy.renderMarginPx}px` : 'Disabled'}</td>
                  <td>
                    {effective.refresh?.enabled
                      ? `${effective.refresh.minSeconds}s · ${effective.refresh.minViewPct}%`
                      : 'Disabled'}
                  </td>
                  <td>{effective.conditionalMappings?.filter((mapping) => mapping.enabled).length ?? 0}</td>
                </tr>
              ))}
              {!effectiveRows.length ? (
                <tr><td colSpan={6}>Create or import ad units to see resolved rules.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {mode ? (
        <div className="modal-backdrop" onMouseDown={closeForm} role="presentation">
          <section className="modal-card unit-rule-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog">
            <div className="modal-heading">
              <div>
                <span className="panel-kicker">Unit rule workflow</span>
                <h2>
                  {mode === 'edit'
                    ? `Edit ${scopeLabel(source?.ruleKey ?? form.ruleKey)}`
                    : mode === 'duplicate'
                      ? `Copy ${scopeLabel(source?.ruleKey ?? '')}`
                      : 'Create unit rule'}
                </h2>
              </div>
              <button className="icon-button" onClick={closeForm} type="button">×</button>
            </div>

            <form className="unit-rule-form" onSubmit={submit}>
              <section className="rule-form-section scope-section">
                <div>
                  <span className="rule-section-kicker">Target</span>
                  <h3>Inheritance scope</h3>
                  <p>Exact ad-unit rules are applied after Default and ATF/BTF rules.</p>
                </div>
                <label>
                  <span>Rule target</span>
                  <select
                    disabled={mode === 'edit'}
                    onChange={(event) => {
                      const target = event.target.value;
                      setForm(formFromRule(target, mode === 'duplicate' ? source?.rule ?? {} : presetForKey(target)));
                    }}
                    value={form.ruleKey}
                  >
                    <option value="">Select target</option>
                    {(mode === 'edit'
                      ? targetOptions.filter((option) => option.key === form.ruleKey)
                      : availableTargetOptions
                    ).map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </section>

              <section className="rule-form-section">
                <div className="rule-section-heading">
                  <div>
                    <span className="rule-section-kicker">Auction</span>
                    <h3>Prebid timeout</h3>
                    <p>Maximum wait time for this scope before the ad-server request continues.</p>
                  </div>
                  <label className="rule-override-toggle">
                    <input checked={form.overrideTimeout} onChange={(event) => updateForm('overrideTimeout', event.target.checked)} type="checkbox" />
                    <span>Override inherited value</span>
                  </label>
                </div>
                {form.overrideTimeout ? (
                  <label className="compact-number-field">
                    <span>Timeout</span>
                    <div><input min="100" max="60000" onChange={(event) => updateForm('timeout', Number(event.target.value))} type="number" value={form.timeout} /><b>ms</b></div>
                  </label>
                ) : <div className="inherit-note">This scope inherits timeout from its parent rule.</div>}
              </section>

              <section className="rule-form-section">
                <div className="rule-section-heading">
                  <div>
                    <span className="rule-section-kicker">Lazy load</span>
                    <h3>Auction and render distance</h3>
                    <p>Distances are measured before the slot enters the viewport.</p>
                  </div>
                  <label className="rule-override-toggle">
                    <input checked={form.overrideLazy} onChange={(event) => updateForm('overrideLazy', event.target.checked)} type="checkbox" />
                    <span>Override inherited value</span>
                  </label>
                </div>
                {form.overrideLazy ? (
                  <div className="rule-field-grid three">
                    <label className="check-card">
                      <input checked={form.lazyEnabled} onChange={(event) => updateForm('lazyEnabled', event.target.checked)} type="checkbox" />
                      <span><strong>Lazy auction enabled</strong><small>Disabled means the slot can join the initial auction.</small></span>
                    </label>
                    <label>
                      <span>Start auction within</span>
                      <div className="number-with-unit"><input disabled={!form.lazyEnabled} min="0" max="20000" onChange={(event) => updateForm('fetchMarginPx', Number(event.target.value))} type="number" value={form.fetchMarginPx} /><b>px</b></div>
                    </label>
                    <label>
                      <span>Allow render within</span>
                      <div className="number-with-unit"><input disabled={!form.lazyEnabled} min="0" max="20000" onChange={(event) => updateForm('renderMarginPx', Number(event.target.value))} type="number" value={form.renderMarginPx} /><b>px</b></div>
                    </label>
                  </div>
                ) : <div className="inherit-note">This scope inherits lazy-load behavior from its parent rule.</div>}
              </section>

              <section className="rule-form-section">
                <div className="rule-section-heading">
                  <div>
                    <span className="rule-section-kicker">Refresh</span>
                    <h3>Viewability refresh guard</h3>
                    <p>Refresh is eligible only after the time and in-view conditions are satisfied.</p>
                  </div>
                  <label className="rule-override-toggle">
                    <input checked={form.overrideRefresh} onChange={(event) => updateForm('overrideRefresh', event.target.checked)} type="checkbox" />
                    <span>Override inherited value</span>
                  </label>
                </div>
                {form.overrideRefresh ? (
                  <div className="refresh-editor-grid">
                    <label className="check-card refresh-enabled-card">
                      <input checked={form.refreshEnabled} onChange={(event) => updateForm('refreshEnabled', event.target.checked)} type="checkbox" />
                      <span><strong>Refresh enabled</strong><small>Turn off refresh for this scope.</small></span>
                    </label>
                    <label><span>Minimum time</span><div className="number-with-unit"><input disabled={!form.refreshEnabled} min="5" max="3600" onChange={(event) => updateForm('minSeconds', Number(event.target.value))} type="number" value={form.minSeconds} /><b>sec</b></div></label>
                    <label><span>Minimum in view</span><div className="number-with-unit"><input disabled={!form.refreshEnabled} min="0" max="100" onChange={(event) => updateForm('minViewPct', Number(event.target.value))} type="number" value={form.minViewPct} /><b>%</b></div></label>
                    <label><span>Check interval</span><div className="number-with-unit"><input disabled={!form.refreshEnabled} min="250" max="60000" onChange={(event) => updateForm('checkEveryMs', Number(event.target.value))} type="number" value={form.checkEveryMs} /><b>ms</b></div></label>
                    <label className="check-card previous-viewable-card">
                      <input checked={form.requirePreviousViewable} disabled={!form.refreshEnabled} onChange={(event) => updateForm('requirePreviousViewable', event.target.checked)} type="checkbox" />
                      <span><strong>Require previous ad to be viewable</strong><small>Leave off when blank/no-fill slots should get another auction opportunity.</small></span>
                    </label>
                  </div>
                ) : <div className="inherit-note">This scope inherits refresh behavior from its parent rule.</div>}
              </section>

              <section className="rule-form-section conditional-section">
                <div className="rule-section-heading">
                  <div>
                    <span className="rule-section-kicker">Key-values</span>
                    <h3>Conditional size-map and slot rules</h3>
                    <p>Example: when pageType equals home, use Billboard_Home. Higher priority runs first.</p>
                  </div>
                  <button className="button secondary" onClick={addMapping} type="button">＋ Mapping</button>
                </div>

                <div className="conditional-mapping-list">
                  {form.conditionalMappings.map((mapping, mappingIndex) => (
                    <article className="conditional-mapping-card" key={mapping.id}>
                      <div className="conditional-mapping-heading">
                        <label className="mapping-enabled">
                          <input checked={mapping.enabled} onChange={(event) => updateMapping(mapping.id, { enabled: event.target.checked })} type="checkbox" />
                          <span>Enabled</span>
                        </label>
                        <label className="mapping-name"><span>Name</span><input onChange={(event) => updateMapping(mapping.id, { name: event.target.value })} value={mapping.name} /></label>
                        <label><span>Priority</span><input min="0" max="10000" onChange={(event) => updateMapping(mapping.id, { priority: Number(event.target.value) })} type="number" value={mapping.priority} /></label>
                        <label><span>Match</span><select onChange={(event) => updateMapping(mapping.id, { match: event.target.value as UnitRuleMatchMode })} value={mapping.match}><option value="all">ALL conditions</option><option value="any">ANY condition</option></select></label>
                        <button aria-label={`Remove mapping ${mappingIndex + 1}`} className="mapping-remove" onClick={() => removeMapping(mapping.id)} type="button">×</button>
                      </div>

                      <div className="condition-list">
                        {mapping.conditions.map((condition, conditionIndex) => (
                          <div className="condition-row" key={condition.id}>
                            <label><span>Key</span><input onChange={(event) => updateCondition(mapping.id, condition.id, { key: event.target.value })} placeholder="pageType" value={condition.key} /></label>
                            <label><span>Operator</span><select onChange={(event) => updateCondition(mapping.id, condition.id, { operator: event.target.value as UnitRuleConditionOperator })} value={condition.operator}><option value="equals">equals</option><option value="notEquals">does not equal</option><option value="contains">contains</option><option value="notContains">does not contain</option><option value="exists">exists</option><option value="notExists">does not exist</option></select></label>
                            <label><span>Value</span><input disabled={condition.operator === 'exists' || condition.operator === 'notExists'} onChange={(event) => updateCondition(mapping.id, condition.id, { value: event.target.value })} placeholder="home" value={condition.value} /></label>
                            <button aria-label={`Remove condition ${conditionIndex + 1}`} className="condition-remove" disabled={mapping.conditions.length === 1} onClick={() => removeCondition(mapping.id, condition.id)} type="button">×</button>
                          </div>
                        ))}
                        <button className="add-condition" onClick={() => addCondition(mapping.id)} type="button">＋ Condition</button>
                      </div>

                      <div className="mapping-action-grid">
                        <label><span>Use size map</span><select onChange={(event) => updateMapping(mapping.id, { sizeMapKey: event.target.value || null })} value={mapping.sizeMapKey ?? ''}><option value="">Keep inherited map</option>{sizeMaps.map((map) => <option key={map.id} value={map.name}>{map.name}</option>)}</select></label>
                        <label><span>Slot action</span><select onChange={(event) => updateMapping(mapping.id, { slotAction: event.target.value as UnitRuleSlotAction })} value={mapping.slotAction}><option value="inherit">Keep inherited state</option><option value="enable">Enable slot</option><option value="disable">Disable slot</option></select></label>
                      </div>
                    </article>
                  ))}

                  {!form.conditionalMappings.length ? (
                    <button className="empty-mapping-card" onClick={addMapping} type="button">＋ Add a page key-value mapping</button>
                  ) : null}
                </div>
              </section>

              {formError ? <div className="form-error">{formError}</div> : null}
              <div className="modal-actions unit-rule-modal-actions">
                <button className="button secondary" disabled={submitting} onClick={closeForm} type="button">Cancel</button>
                <button className="button primary" disabled={submitting || !form.ruleKey} type="submit">
                  {submitting ? 'Saving…' : mode === 'duplicate' ? 'Copy rule' : 'Save rule'}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </>
  );
}
