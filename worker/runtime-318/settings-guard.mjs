import {hasRevenueSettings,requireRevenueRuntime as previousGuard} from '../runtime-317/settings-guard.mjs';
export {hasRevenueSettings};
export function requireRevenueRuntime(config,descriptor) {
  if (descriptor?.id === 'tessera-3.18.0' && descriptor.version === '3.18.0') return;
  previousGuard(config,descriptor);
}
