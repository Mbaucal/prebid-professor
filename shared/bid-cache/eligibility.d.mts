export const BID_CACHE_CAPABILITY: 'bid-cache';
export const BID_CACHE_RUNTIME_VERSION: '3.23.0';
/** An ad_units row as D1 returns it. Other columns are allowed and ignored. */
export type BidCacheUnitRow = { code: string; type: string; media_type: string; enabled: number };
export function runtimeSupportsBidCache(descriptor: unknown): boolean;
export function bidCacheEligibleCodes(units: readonly BidCacheUnitRow[] | null | undefined, config: Readonly<Record<string, unknown>> | null | undefined): string[];
export function bidCacheEligibleInputCodes(input: unknown): string[];
