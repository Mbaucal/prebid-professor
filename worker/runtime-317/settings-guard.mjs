import {hasRevenueSettings,requireRevenueRuntime as previousGuard} from '../runtime-3162/settings-guard.mjs';
export {hasRevenueSettings};
export function requireRevenueRuntime(config,descriptor) {
  if (descriptor?.id === 'tessera-3.17.0' && descriptor.version === '3.17.0') return;
  previousGuard(config,descriptor);
}
