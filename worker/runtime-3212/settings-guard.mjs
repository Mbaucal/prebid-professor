import {requireRevenueRuntime as previousGuard} from '../runtime-3211/settings-guard.mjs';
export {hasRevenueSettings, requireCountryRules} from '../runtime-3211/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.21.2' && descriptor.version === '3.21.2') return;
  previousGuard(config, descriptor);
}
