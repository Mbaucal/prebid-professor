import { carriedEdits, rebaseEdits, rebaseReview, rebasedBaseline, type RebaseGate, type RebaseResult, type RebaseReview } from './edit-rebase';
import type { UnitRuleConditionalMapping, UnitRuleConfig } from './shared/types';

// The Unit rules edit dialog's form: how a saved rule fills it, how it is saved, and how a
// refused save names and compares its fields. Kept apart from the panel so tests use it as is.

export type RuleForm = {
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

export const BASELINE_RULE: Required<Pick<UnitRuleConfig, 'timeout' | 'lazy' | 'refresh'>> = {
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

export function formFromRule(ruleKey: string, rule: UnitRuleConfig): RuleForm {
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

// How a field is named and shown when a refused save lists what both tabs changed.
export const FIELD_LABELS: Record<keyof RuleForm, string> = {
  ruleKey: 'Rule target',
  overrideTimeout: 'Override inherited timeout',
  timeout: 'Timeout',
  overrideLazy: 'Override inherited lazy load',
  lazyEnabled: 'Lazy auction enabled',
  fetchMarginPx: 'Start auction within',
  renderMarginPx: 'Allow render within',
  overrideRefresh: 'Override inherited refresh',
  refreshEnabled: 'Refresh enabled',
  minSeconds: 'Minimum time',
  minViewPct: 'Minimum in view',
  requirePreviousViewable: 'Require previous ad to be viewable',
  checkEveryMs: 'Check interval',
  conditionalMappings: 'Key-value mappings',
};
const FIELD_UNITS: Partial<Record<keyof RuleForm, string>> = {
  timeout: ' ms', fetchMarginPx: ' px', renderMarginPx: ' px', minSeconds: ' sec', minViewPct: '%', checkEveryMs: ' ms',
};

// A section's values take effect only while its override is on (nothing is stored while it
// is off), and the inputs below an Enabled switch only while that switch is on.
export const FORM_GATES: Array<RebaseGate<RuleForm>> = [
  { gate: 'overrideTimeout', fields: ['timeout'], storedOnlyWhenUsed: true, hiddenWhenUnused: true },
  { gate: 'overrideLazy', fields: ['lazyEnabled', 'fetchMarginPx', 'renderMarginPx'], storedOnlyWhenUsed: true, hiddenWhenUnused: true },
  {
    gate: 'overrideRefresh',
    fields: ['refreshEnabled', 'minSeconds', 'minViewPct', 'requirePreviousViewable', 'checkEveryMs'],
    storedOnlyWhenUsed: true,
    hiddenWhenUnused: true,
  },
  { gate: 'lazyEnabled', fields: ['fetchMarginPx', 'renderMarginPx'] },
  { gate: 'refreshEnabled', fields: ['minSeconds', 'minViewPct', 'requirePreviousViewable', 'checkEveryMs'] },
];
const OVERRIDE_FIELDS: Array<keyof RuleForm> = ['overrideTimeout', 'overrideLazy', 'overrideRefresh'];

export function fieldText(key: keyof RuleForm, value: RuleForm[keyof RuleForm]): string {
  if (typeof value === 'boolean') return value ? 'on' : OVERRIDE_FIELDS.includes(key) ? 'off (inherited)' : 'off';
  if (Array.isArray(value)) {
    return value.length
      ? `${value.length} mapping${value.length === 1 ? '' : 's'} (${value.map((mapping) => mapping.name).join(', ')})`
      : 'no mappings';
  }
  return `${value}${FIELD_UNITS[key] ?? ''}`;
}

export function ruleFromForm(form: RuleForm): UnitRuleConfig {
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

/** What the dialog compares a refused save with: the form it loaded, and the values earlier rebases carried. */
export type DialogBaseline = { form: RuleForm; carried: Partial<RuleForm> };

/**
 * The dialog after a 409: the rule as saved now with only this dialog's changes applied, the
 * note it shows, and what it compares the next refused save with (see rebasedBaseline).
 */
export function dialogAfterRefusal(edited: RuleForm, loaded: DialogBaseline, saved: RuleForm): {
  rebased: RebaseResult<RuleForm>; review: RebaseReview; next: DialogBaseline;
} {
  const rebased = rebaseEdits(edited, loaded.form, saved, FORM_GATES, { carried: loaded.carried });
  return {
    rebased,
    review: rebaseReview(rebased, saved, (key) => FIELD_LABELS[key], fieldText),
    next: { form: rebasedBaseline(rebased, saved), carried: carriedEdits(rebased) },
  };
}
