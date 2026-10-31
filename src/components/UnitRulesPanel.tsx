import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { RebaseReview } from '../edit-rebase';
import { BASELINE_RULE, dialogAfterRefusal, formFromRule, ruleFromForm, type DialogBaseline, type RuleForm } from '../unit-rule-form';
import { runtimeLabel } from '../site-workspace/runtime-labels';
import EditRebaseReview from './EditRebaseReview';
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
};

type FormMode = 'create' | 'edit' | 'duplicate';

// 404/409 from a rule save means another tab deleted or changed the rules first.
function isStaleRuleError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 404 || error.status === 409);
}

type LoadingSummary = {
  runtimeVersion: string | null;
  issue: string | null;
  units: Array<{ code: string; label: string; detail: string; source: string }>;
  refresh?: {units: Array<{code: string; label: string; detail: string; timeout: number}>; warnings: string[]};
};

async function loadLoadingSummary(publisherId: string): Promise<LoadingSummary> {
  const response = await fetch(`/api/publishers/${encodeURIComponent(publisherId)}/builtin-site-settings`, {
    credentials: 'same-origin', cache: 'no-store',
  });
  if (!response.ok) throw new Error('Loading behavior is unavailable. Reload to try again.');
  const data = await response.json() as { loadingSummary: LoadingSummary; refreshSummary?: LoadingSummary['refresh'] };
  if (!Array.isArray(data.loadingSummary?.units)) throw new Error('Loading behavior is unavailable. Reload to try again.');
  return {...data.loadingSummary, refresh: data.refreshSummary};
}

const RESERVED_RULES = [
  { key: '__DEFAULT__', label: 'Default', description: 'Base behavior inherited by every ad unit.' },
  { key: '__ATF__', label: 'ATF', description: 'Overrides for all above-the-fold ad units.' },
  { key: '__BTF__', label: 'BTF', description: 'Overrides for all below-the-fold ad units.' },
] as const;

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

/** Names rules whose Unit rules interval a save gave its own fixed schedule. */
function keptIntervalsNotice(keys: string[]): string | null {
  if (!keys.length) return null;
  const names = keys.map((key) => key === '__DEFAULT__' ? 'Default' : key === '__ATF__' ? 'ATF group' : key === '__BTF__' ? 'BTF group' : key);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return names.length === 1
    ? `${list} uses its own refresh interval from Unit rules instead of an inherited Refresh schedule. Refresh schedules shows it as “Same every time”.`
    : `${list} use their own refresh interval from Unit rules instead of an inherited Refresh schedule. Refresh schedules shows them as “Same every time”.`;
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

export default function UnitRulesPanel({ publisherId, onChanged }: Props) {
  const [unitRules, setUnitRules] = useState<UnitRule[]>([]);
  const [adUnits, setAdUnits] = useState<AdUnit[]>([]);
  const [sizeMaps, setSizeMaps] = useState<SizeMap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [mode, setMode] = useState<FormMode | null>(null);
  const [source, setSource] = useState<UnitRule | null>(null);
  const [form, setForm] = useState<RuleForm>(() => formFromRule('__DEFAULT__', presetForKey('__DEFAULT__')));
  const [formError, setFormError] = useState<string | null>(null);
  const [rebaseNote, setRebaseNote] = useState<RebaseReview | null>(null);
  // After a refused save: what the dialog counts as loaded for the next one (see rebasedBaseline).
  const [rebasedFrom, setRebasedFrom] = useState<DialogBaseline | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [creatingBaseRules, setCreatingBaseRules] = useState(false);
  const [loadingSummary, setLoadingSummary] = useState<LoadingSummary | null>(null);
  const loadSequence = useRef(0);

  // Resolves to the loaded rules, or null when the load failed or a newer load replaced it.
  const load = useCallback(async (): Promise<UnitRule[] | null> => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadingSummary(null);
    try {
      const [rules, units, maps, summary] = await Promise.all([
        api.listUnitRules(publisherId),
        api.listAdUnits(publisherId),
        api.listSizeMaps(publisherId),
        loadLoadingSummary(publisherId).catch(() => ({
          runtimeVersion: null, units: [], issue: 'Loading behavior is unavailable. Reload to try again.',
        })),
      ]);
      if (sequence !== loadSequence.current) return null;
      setUnitRules(rules);
      setAdUnits(units);
      setSizeMaps(maps);
      setLoadingSummary(summary);
      setError(null);
      return rules;
    } catch (requestError) {
      if (sequence !== loadSequence.current) return null;
      setError(requestError instanceof Error ? requestError.message : 'Could not load unit rules.');
      return null;
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [publisherId]);

  useEffect(() => {
    void load();
    return () => { loadSequence.current++; };
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
    setRebaseNote(null);
    setRebasedFrom(null);
  }

  function openEdit(rule: UnitRule) {
    setMode('edit');
    setSource(rule);
    setForm(formFromRule(rule.ruleKey, rule.rule));
    setFormError(null);
    setRebaseNote(null);
    setRebasedFrom(null);
  }

  function openDuplicate(rule: UnitRule) {
    const target = availableTargetOptions[0]?.key ?? '';
    setMode('duplicate');
    setSource(rule);
    setForm(formFromRule(target, rule.rule));
    setFormError(null);
    setRebaseNote(null);
    setRebasedFrom(null);
  }

  function closeForm() {
    if (submitting) return;
    setMode(null);
    setSource(null);
    setFormError(null);
    setRebaseNote(null);
    setRebasedFrom(null);
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
    setRebaseNote(null);

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
    setNotice(null);
    try {
      const saved = mode === 'edit' && source
        ? await api.updateUnitRule(publisherId, source.id, { rule, expectedUpdatedAt: source.updatedAt })
        : mode === 'duplicate' && source
          ? await api.duplicateUnitRule(publisherId, source.id, { ruleKey: form.ruleKey })
          : await api.createUnitRule(publisherId, { ruleKey: form.ruleKey, rule });
      setNotice(keptIntervalsNotice(saved.keptUnitRuleIntervals));
      await load();
      await onChanged?.();
      closeForm();
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Unit rule operation failed.';
      if (isStaleRuleError(requestError)) {
        // Another tab changed or deleted the rule and nothing was saved. Refresh the list
        // behind the dialog, but keep the dialog and every entered value.
        const rules = await load();
        // The rule as saved now, with its version from the same list read.
        const latest = mode === 'edit' && source ? rules?.find((item) => item.id === source.id) : undefined;
        if (requestError.status === 409 && source && latest && latest.updatedAt !== source.updatedAt) {
          // Edit the rule as it is saved now: only the fields changed in this dialog stay,
          // so saving again cannot put back what the other tab replaced. The next save is
          // checked against this reloaded version, never the one the dialog opened with.
          const { rebased, review, next } = dialogAfterRefusal(
            form,
            rebasedFrom ?? { form: formFromRule(source.ruleKey, source.rule), carried: {} },
            formFromRule(latest.ruleKey, latest.rule),
          );
          setRebasedFrom(next);
          setSource(latest);
          setForm(rebased.form);
          setRebaseNote(review);
          setFormError(rebased.changed.length
            ? 'This rule was changed in another tab, so nothing was saved. The dialog now shows the saved rule with your changes applied. Review it and select Save rule again.'
            : 'This rule was changed in another tab, so nothing was saved. You had not changed anything in this dialog, so it now shows the rule as saved in the other tab.');
          return;
        }
        if (requestError.status === 404 && mode === 'edit') {
          setMode('create');
          setSource(null);
          setRebasedFrom(null);
          setFormError(`${message} Your entries are kept: select Save rule to create this rule again, or Cancel.`);
          return;
        }
      }
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(rule: UnitRule) {
    if (!window.confirm(`Delete rule ${scopeLabel(rule.ruleKey)}? Its values will fall back to inherited rules.`)) {
      return;
    }
    setNotice(null);
    try {
      const deleted = await api.deleteUnitRule(publisherId, rule.id);
      setNotice(keptIntervalsNotice(deleted.keptUnitRuleIntervals));
      await load();
      await onChanged?.();
    } catch (requestError) {
      // A successful reload clears the panel error, so reload first and report after.
      if (isStaleRuleError(requestError)) await load();
      setError(requestError instanceof Error ? requestError.message : 'Could not delete unit rule.');
    }
  }

  async function createBaseRules() {
    if (!missingReserved.length) return;
    setCreatingBaseRules(true);
    setError(null);
    setNotice(null);
    try {
      const kept: string[] = [];
      for (const item of missingReserved) {
        // Presets are starting values: a schedule already saved in Refresh schedules keeps applying.
        const saved = await api.createUnitRule(publisherId, {
          ruleKey: item.key,
          rule: presetForKey(item.key),
          followInheritedSchedule: true,
        });
        kept.push(...saved.keptUnitRuleIntervals);
      }
      setNotice(keptIntervalsNotice(kept));
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
            <button className="button secondary" disabled={loading || submitting || creatingBaseRules} onClick={() => void load()} type="button">Reload rules</button>
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
        {notice ? <p role="status" className="loading-summary-help unit-rules-notice">{notice}</p> : null}
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
          <span>{loadingSummary?.runtimeVersion ? `Loading · script ${runtimeLabel(loadingSummary.runtimeVersion)}` : 'Includes inheritance'}</span>
        </div>
        <p className="loading-summary-help">Loading follows the selected script’s ATF/BTF defaults, group rules and Display &amp; loading overrides. These are saved settings for the next generated package.</p>
        {loadingSummary?.issue ? <p role="status" className="form-error">{loadingSummary.issue}</p> : null}
        {loadingSummary?.refresh?.warnings.map(warning => <p role="status" className="loading-summary-help" key={warning}>{warning}</p>)}

        <div className="effective-rule-table-wrap">
          <table className="effective-rule-table">
            <thead>
              <tr>
                <th>Ad unit</th>
                <th>Scope</th>
                <th>Timeout</th>
                <th>Loading</th>
                <th>Refresh</th>
                <th>Mappings</th>
              </tr>
            </thead>
            <tbody>
              {effectiveRows.map(({ unit, effective, exact }) => (
                <tr key={unit.id}>
                  <td><strong>{unit.code}</strong><small>{unit.type}</small></td>
                  <td>{exact ? 'Exact override' : `${unit.type} inherited`}</td>
                  <td>{loadingSummary?.refresh?.units.find(item => item.code === unit.code)?.timeout ?? effective.timeout} ms</td>
                  <td className="effective-loading-cell">{(() => {
                    const summary = loadingSummary?.units.find(item => item.code === unit.code);
                    return summary ? <><strong>{summary.label}</strong><small>{summary.source}</small><small>{summary.detail}</small></>
                      : <span>{loading ? 'Loading settings…' : 'Loading behavior unavailable'}</span>;
                  })()}</td>
                  <td>
                    {(() => {
                      const refresh = loadingSummary?.refresh?.units.find(item => item.code === unit.code);
                      return refresh ? <><strong>{refresh.label}</strong><small>{refresh.detail}</small></> : 'Refresh behavior unavailable';
                    })()}
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
                    <div><input min="100" max="30000" onChange={(event) => updateForm('timeout', Number(event.target.value))} type="number" value={form.timeout} /><b>ms</b></div>
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
              {rebaseNote ? <EditRebaseReview review={rebaseNote} /> : null}
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
