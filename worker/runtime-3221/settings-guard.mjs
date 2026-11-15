import {requireRevenueRuntime as previousGuard} from '../runtime-3212/settings-guard.mjs';
export {hasRevenueSettings, requireCountryRules} from '../runtime-3212/settings-guard.mjs';
export function requireRevenueRuntime(config, descriptor) {
  if (descriptor?.id === 'tessera-3.22.1' && descriptor.version === '3.22.1') return;
  previousGuard(config, descriptor);
}
