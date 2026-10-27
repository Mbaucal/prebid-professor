export type RebaseResult<T> = {
  /** The saved values with every field this editor changed since it loaded put back on top. */
  form: T;
  /** Fields this editor changed since it loaded; each keeps the value entered here. */
  changed: Array<keyof T>;
  /** Changed fields that the other save also changed, to a different value: review before saving. */
  conflicts: Array<keyof T>;
  /**
   * Changed fields that take effect as entered here, or stay editable and stored under a gate
   * that is off (`editableWhenUnused`): not a conflict, and not turned off by a gate.
   */
  applied: Array<keyof T>;
  /**
   * For a gate this editor switched (also listed in `conflicts`): the fields the other save
   * changed that took effect there and no longer do with this editor's gate value. Present
   * only when there are some.
   */
  switchedOff?: Partial<Record<keyof T, Array<keyof T>>>;
  /**
   * Fields this editor did not change that keep the value it showed, because its gate is on
   * here and off in the other save (which stores nothing for them). Present only when there
   * are some.
   */
  kept?: Array<keyof T>;
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
   * is off stores nothing), so a form value of an unused field is a form default, not a
   * value anyone entered.
   */
  storedOnlyWhenUsed?: boolean;
  /**
   * The editor hides these fields while the gate does not use them, so a value a field holds
   * then is one the operator never saw: an entry changed to it was not put back.
   */
  hiddenWhenUnused?: boolean;
  /**
   * The editor shows what the scope inherits in these fields while the gate does not use
   * them, so where this editor keeps its gate against the other save, a field it did not
   * change takes that inherited value, not the one it showed.
   */
  inheritsWhenUnused?: boolean;
  /**
   * The editor keeps these fields shown, editable and stored while the gate does not use them
   * (such as values under a switched-off Enabled), so a value either side changed there is
   * compared like any other. Without it, a value the gate does not use is left out of the
   * comparison, as one the editor did not let anyone enter.
   */
  editableWhenUnused?: boolean;
};

/**
 * Fields a snapshot shows but does not store although their gates are on: a section stored
 * in part (a Unit rules row holds some refresh settings, the form fills the rest from the
 * parent scopes). Such a value counts as inherited in that snapshot, like a field under a
 * `storedOnlyWhenUsed` gate that is off.
 */
export type RebaseOptions<T> = {
  unstored?: { loaded?: Array<keyof T>; saved?: Array<keyof T> };
  /**
   * Fields an earlier rebase of this editor carried as its own, with the values it carried
   * (see carriedEdits): each stays this editor's entry while it still holds that value, even
   * where it now equals the loaded value. One changed again since then is compared as usual,
   * so a value put back to the loaded one is no longer an entry, unless the loaded value was
   * hidden (`hiddenWhenUnused`) and so could not be put back.
   */
  carried?: Partial<T>;
  /** Whether two values of a field save the same, such as intervals spaced differently. Default: identical. */
  equal?: (key: keyof T, left: unknown, right: unknown) => boolean;
};

const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/**
 * A save was refused because another tab saved the same settings first. Start from
 * what is saved now and re-apply only the fields this editor changed since it loaded,
 * so saving again cannot put back values the other tab replaced. A field changed in
 * both places keeps this editor's value and is reported as a conflict.
 *
 * Fields are compared by what the settings store, not by what the form shows: a field
 * under a section that stores nothing (a `storedOnlyWhenUsed` gate that is off) holds a
 * form default, so it is never taken for a value either side entered, and a value the
 * other save stored there counts as changed even when it equals that default.
 *
 * Gates are applied in order (outer first). When the other save switched a gate so that
 * fields changed here would no longer take effect, this editor's gate value is kept too,
 * so those values still apply, and the gate itself is reported as the conflict. The other
 * way round, when this editor's gate turns off values the other save changed (an override
 * turned off, another strategy chosen), the gate is also a conflict and `switchedOff`
 * names those values, so they are never dropped unseen.
 */
export function rebaseEdits<T extends Record<string, unknown>>(
  edited: T,
  loaded: T,
  saved: T,
  gates: Array<RebaseGate<T>> = [],
  options: RebaseOptions<T> = {},
): RebaseResult<T> {
  const form = { ...saved };
  const changed = new Set<keyof T>();
  const conflicts = new Set<keyof T>();
  const order = Object.keys(edited) as Array<keyof T>;
  const usesOf = (rule: RebaseGate<T>) => rule.uses ?? ((value: T[keyof T]) => value === true);
  const unstoredLoaded = new Set(options.unstored?.loaded ?? []);
  const unstoredSaved = new Set(options.unstored?.saved ?? []);
  const carried: Partial<T> = options.carried ?? {};
  const equal = options.equal ?? ((_key: keyof T, left: unknown, right: unknown) => same(left, right));
  const hidden = (values: T, field: keyof T) => gates.some((rule) => rule.hiddenWhenUnused && rule.fields.includes(field)
    && !usesOf(rule)(values[rule.gate], field));
  const isCarried = (key: keyof T) => key in carried && (same(edited[key], carried[key]) || hidden(loaded, key));
  const kept = new Set<keyof T>();
  // What the settings hold for a field: nothing while a section that stores nothing is off,
  // or for a field the snapshot does not store.
  const stored = (values: T, field: keyof T, unstored = new Set<keyof T>()) => unstored.has(field)
    || gates.some((rule) => rule.storedOnlyWhenUsed && rule.fields.includes(field) && !usesOf(rule)(values[rule.gate], field))
    ? { inherited: true } : { value: values[field] };
  // Whether a field counts in these values: every gate that covers it uses it, or lets it be
  // edited while it does not (editableWhenUnused).
  const matters = (values: T, field: keyof T) => gates.every((rule) => !rule.fields.includes(field)
    || usesOf(rule)(values[rule.gate], field) || rule.editableWhenUnused === true);
  for (const key of order) {
    // Changed here: entered in this editor and stored by it, and what it would store differs
    // from what it loaded (or an earlier rebase carried it). A value left under a section
    // switched off here is not stored: the switch is the change, and the field keeps the
    // saved value.
    if ('inherited' in stored(edited, key)) continue;
    if (!isCarried(key) && (same(edited[key], loaded[key])
      || same(stored(edited, key), stored(loaded, key, unstoredLoaded)))) continue;
    form[key] = edited[key];
    changed.add(key);
  }
  for (const rule of gates) {
    const { gate, fields, storedOnlyWhenUsed, inheritsWhenUnused } = rule;
    const uses = usesOf(rule);
    // Fields changed here while they took effect in this editor.
    const mine = fields.filter((field) => changed.has(field) && uses(edited[gate], field));
    if (!mine.every((field) => uses(form[gate], field))) {
      form[gate] = edited[gate];
      changed.add(gate);
      conflicts.add(gate);
    }
    if (!storedOnlyWhenUsed || inheritsWhenUnused || !same(form[gate], edited[gate])) continue;
    for (const field of fields) {
      // This editor's gate is in effect and the other save stores nothing under it: keep what
      // this editor showed, not the form default, unless that was itself inherited (then the
      // saved inheritance shows).
      if (!changed.has(field) && uses(edited[gate], field) && !uses(saved[gate], field) && !unstoredLoaded.has(field)) {
        form[field] = edited[field];
        kept.add(field);
      }
    }
  }
  const switchedOff: Partial<Record<keyof T, Array<keyof T>>> = {};
  for (const key of order) {
    // Values the other save changed and stored, where they count there, or where this editor
    // puts a value it changed into effect over one the other save stored (such as a value the
    // Refresh tab saved under a switched-off Enabled, which the Unit rules dialog switches on).
    const savedValue = stored(saved, key, unstoredSaved);
    const loadedValue = stored(loaded, key, unstoredLoaded);
    if (same(savedValue, loadedValue) || unstoredSaved.has(key)) continue;
    // Where the loaded section stored nothing, the value the other save stored counts when it
    // differs from what this editor showed there (a default it prefilled and left does not).
    if (!matters(saved, key) && !(changed.has(key) && matters(form, key) && !('inherited' in savedValue)
      && (!('inherited' in loadedValue) || !same(saved[key], loaded[key])))) continue;
    // This editor's gate turns off a value that took effect in the other save: name it under
    // the outermost such gate.
    const rule = matters(saved, key) ? gates.find((item) => item.fields.includes(key)
      && usesOf(item)(saved[item.gate], key) && !usesOf(item)(form[item.gate], key)) : undefined;
    if (rule) {
      (switchedOff[rule.gate] ??= []).push(key);
      conflicts.add(rule.gate);
    }
    // In effect here, or editable under a switch that is off: a value both changed is a
    // conflict of its own, also under a switch this editor turned off that keeps it editable.
    if ((!rule || (rule.editableWhenUnused && changed.has(key))) && !equal(key, form[key], saved[key])) conflicts.add(key);
  }
  return {
    form,
    changed: order.filter((key) => changed.has(key)),
    conflicts: order.filter((key) => conflicts.has(key)),
    applied: order.filter((key) => changed.has(key) && !conflicts.has(key) && matters(form, key)),
    ...(Object.keys(switchedOff).length ? { switchedOff } : {}),
    ...(kept.size ? { kept: order.filter((key) => kept.has(key)) } : {}),
  };
}

/**
 * What the editor counts as loaded once it shows a rebase, for the next refused save: the
 * rebased form with this editor's changes taken back to the saved values. With carriedEdits
 * passed as `carried`, the next rebase carries exactly the fields this one did, and a value
 * the form only kept from what it showed is not taken for one entered here.
 */
export function rebasedBaseline<T extends Record<string, unknown>>(result: RebaseResult<T>, saved: T): T {
  const baseline = { ...result.form };
  for (const key of result.changed) baseline[key] = saved[key];
  return baseline;
}

/** The fields this rebase carried as this editor's, with the values the rebased form shows for them. */
export function carriedEdits<T extends Record<string, unknown>>(result: RebaseResult<T>): Partial<T> {
  const carried: Partial<T> = {};
  for (const key of result.changed) carried[key] = result.form[key];
  return carried;
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
  const conflicts = result.conflicts.map((key) => {
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
  });
  // A field and the switch that keeps it for this scope can share a label: name it once.
  const named = new Set(conflicts.map((conflict) => conflict.field));
  return { conflicts, applied: [...new Set(result.applied.map(label))].filter((field) => !named.has(field)) };
}
