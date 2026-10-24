import {previewInput as previousInput} from '../runtime-316/snapshot.mjs';

/** Explicit patch release: old adapters and saved configurations remain exact. */
export function previewInput(snapshot, descriptor, timestamp, takeOver) {
  const input = previousInput(snapshot, descriptor, timestamp, takeOver);
  const rules = input.core.adUnitRules;
  const disabled = new Set(input.outstream.disabledRefreshCodes);
  const sticky = input.options.sticky;
  const content = input.core.explicitUnits.filter(unit => unit.id !== input.overlay?.code &&
    unit.id !== sticky.bottomAdUnitId && unit.id !== sticky.topAdUnitId && !disabled.has(unit.id));
  const enabled = content.some(unit => {
    const refresh = Object.assign({}, rules.__DEFAULT__?.refresh,
      rules[String(unit.type).toUpperCase() === 'ATF' ? '__ATF__' : '__BTF__']?.refresh,
      rules[unit.id]?.refresh);
    return refresh.enabled !== false;
  });
  input.core.globalRefresh = {...input.core.globalRefresh, enabled};
  return input;
}
