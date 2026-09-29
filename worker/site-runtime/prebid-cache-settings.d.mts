import type { ArmSettings } from '../experiments/package-settings-v1.mjs';
export type BidCacheSettings = { enabled: boolean; maxBidAgeSeconds: number };
export const DEFAULT_BID_CACHE: Readonly<BidCacheSettings>;
export const BID_CACHE_GENERATOR_MESSAGE: string;
export function bidCacheSettings(value?: unknown): BidCacheSettings;
export function supportsNamedScripts(row: unknown): boolean;
export function savedPrebidSettings(config: Record<string, unknown>): { enabled: boolean; bidCache: BidCacheSettings };
export function settingsForScript(config: Record<string, unknown>, refreshSeconds: number | null): ArmSettings;
export function requireSupportedCacheGenerator(config: Record<string, unknown>): void;
