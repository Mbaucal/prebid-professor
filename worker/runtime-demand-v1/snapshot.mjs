import {previewInput as positionsInput} from '../runtime-next/snapshot.mjs';

export function normalizeGpid(value) {
  if (typeof value !== 'string' || value.length > 512 || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw Error('GPID must be a stable identifier of up to 512 characters, without whitespace.');
  }
  return value;
}

export function demandSignals(input, config) {
  if (!input.options.enablePrebid) return null;
  const overrides = config.runtimeControls?.demandSignals?.gpidOverrides ?? {};
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw Error('GPID overrides must be an object.');
  const base = '/' + String(input.core.gamPath).trim().replace(/^\/+|\/+$/g, '') + '/';
  const placements = {};
  for (const unit of input.core.explicitUnits) {
    // Keep the complete MCM path, including both network IDs. Always include
    // the stable saved position code: lazy slot registration cannot change it.
    const adslot = base + unit.id;
    const override = Object.hasOwn(overrides, unit.id) ? normalizeGpid(overrides[unit.id]) : '';
    placements[unit.id] = {adslot, gpid: override || adslot + '#' + unit.id, override};
  }
  const values = Object.values(placements).map(p => p.gpid);
  if (new Set(values).size !== values.length) throw Error('Each enabled position needs a distinct GPID.');
  return {enableSendAllBids:true, alwaysIncludeDeals:true, placements};
}

export function previewInput(snapshot, descriptor, timestamp, takeOver) {
  const input = positionsInput(snapshot, descriptor, timestamp, takeOver);
  input.demandSignals = demandSignals(input, JSON.parse(snapshot.config.config_json));
  return input;
}
