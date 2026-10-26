export type RebaseResult<T> = {
  /** The saved values with every field this editor changed since it loaded put back on top. */
  form: T;
  /** Fields this editor changed since it loaded; each keeps the value entered here. */
  changed: Array<keyof T>;
  /** Changed fields that the other save also changed, to a different value: review before saving. */
  conflicts: Array<keyof T>;
  /**
   * For a gate this editor switched (also listed in `conflicts`): the fields the other save
   * changed that took effect there and no longer do with this editor's gate value. Present
   * only when there are some.
   */
  switchedOff?: Partial<Record<keyof T, Array<keyof T>>>;
};

/**
 * A switch or choice that decides whether other fields take effect, such as a section's
 * "Override inherited value" or a schedule mode. A field changed here only counts while
 * its gate lets it take effect, so a rebase must look at the gate and the field together.
 */
export type RebaseGate<T> = {
  gate: keyof T;
  fields: Array<keyof T>;
  /** Whether `field` takes effect with this gate value. Default: while the gate is on. */
  uses?: (value: T[keyof T], field: keyof T) => boolean;
  /**
   * The saved settings keep these fields only while the gate uses them (an override that
   * is off stores nothing), so a saved value of an unused field is a form default, not a
   * value the other save entered.
   */
  storedOnlyWhenUsed?: boolean;
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * A save was refused because another tab saved the same settings first. Start from
 * what is saved now and re-apply only the fields this editor changed since it loaded,
 * so saving again cannot put back values the other tab replaced. A field changed in
 * both places keeps this editor's value and is reported as a conflict.
 *
 * Gates are applied in order (outer first). When the other save switched a gate so that
 * fields changed here would no longer take effect, this editor's gate value is kept too,
 * so those values still apply, and the gate itself is reported as the conflict. The other
 * way round, when this editor switched a gate so that values the other save changed no
 * longer take effect (an override turned off, another strategy chosen), the gate is also
 * a conflict and `switchedOff` names those values, so they are never dropped unseen.
 */
export function rebaseEdits<T extends Record<string, unknown>>(
  edited: T,
  loaded: T,
  saved: T,
  gates: Array<RebaseGate<T>> = [],
): RebaseResult<T> {
  const form = { ...saved };
  const changed = new Set<keyof T>();
  const conflicts = new Set<keyof T>();
  const order = Object.keys(edited) as Array<keyof T>;
  const usesOf = (rule: RebaseGate<T>) => rule.uses ?? ((value: T[keyof T]) => value === true);
  for (const key of order) {
    if (same(edited[key], loaded[key])) continue;
    form[key] = edited[key];
    changed.add(key);
    if (!same(saved[key], loaded[key]) && !same(saved[key], edited[key])) conflicts.add(key);
  }
  for (const rule of gates) {
    const { gate, fields, storedOnlyWhenUsed } = rule;
    const uses = usesOf(rule);
    // Fields changed here while they took effect in this editor.
    const mine = fields.filter((field) => changed.has(field) && uses(edited[gate], field));
    if (mine.every((field) => uses(form[gate], field))) continue;
    form[gate] = edited[gate];
    changed.add(gate);
    conflicts.add(gate);
    if (!storedOnlyWhenUsed) continue;
    for (const field of fields) {
      if (!uses(edited[gate], field) || uses(saved[gate], field)) continue;
      // The other save stored nothing for this field: keep what this editor showed, and
      // report the gate rather than the form default as the other tab's value.
      if (!changed.has(field)) form[field] = edited[field];
      conflicts.delete(field);
    }
  }
  // Whether a field takes effect under every gate that covers it.
  const inEffect = (values: T, field: keyof T) =>
    gates.every((rule) => !rule.fields.includes(field) || usesOf(rule)(values[rule.gate], field));
  const switchedOff: Partial<Record<keyof T, Array<keyof T>>> = {};
  const reported = new Set<keyof T>();
  for (const rule of gates) {
    if (!changed.has(rule.gate)) continue;
    // Values only the other save changed, in effect as it saved them, that this editor's gate turns off.
    const lost = rule.fields.filter((field) => !reported.has(field) && !changed.has(field)
      && !same(saved[field], loaded[field]) && inEffect(saved, field) && !usesOf(rule)(form[rule.gate], field));
    if (!lost.length) continue;
    lost.forEach((field) => reported.add(field));
    switchedOff[rule.gate] = lost;
    conflicts.add(rule.gate);
  }
  return {
    form,
    changed: order.filter((key) => changed.has(key)),
    conflicts: order.filter((key) => conflicts.has(key)),
    ...(reported.size ? { switchedOff } : {}),
  };
}

export type RebaseReview = {
  conflicts: Array<{ field: string; yours: string; saved: string }>;
  /** Labels of the changed fields that applied without a conflict. */
  applied: string[];
};

/** What the editor shows after a rebase: each conflict with both values, then the other changes kept. */
export function rebaseReview<T extends Record<string, unknown>>(
  result: RebaseResult<T>,
  saved: T,
  label: (key: keyof T) => string,
  text: (key: keyof T, value: T[keyof T]) => string,
): RebaseReview {
  return {
    conflicts: result.conflicts.map((key) => {
      const yours = text(key, result.form[key]);
      const off = result.switchedOff?.[key] ?? [];
      // Name the other tab's values that this tab's switch would no longer apply.
      const other = off.length
        ? `${text(key, saved[key])} (${off.map((field) => `${label(field)}: ${text(field, saved[field])}`).join('; ')})`
        : text(key, saved[key]);
      // Values that read the same but differ in detail (for example mapping conditions).
      return yours === other
        ? { field: label(key), yours: 'your version', saved: 'a different version' }
        : { field: label(key), yours, saved: other };
    }),
    applied: result.changed.filter((key) => !result.conflicts.includes(key)).map(label),
  };
}
