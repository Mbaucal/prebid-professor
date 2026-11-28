import {requireRevenueRuntime as previousGuard} from '../runtime-3222/settings-guard.mjs';
export {hasRevenueSettings, requireCountryRules} from '../runtime-3222/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.24.0' && descriptor.version === '3.24.0') return;
  previousGuard(config, descriptor);
}
