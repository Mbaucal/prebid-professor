import type {ContextualTaxonomy} from './catalog.mjs';
export type {ContextualTaxonomy} from './catalog.mjs';
export type ContextualSignals = {
  schemaVersion: 1;
  enabled: boolean;
  sourceKey: string;
  gam: {enabled: boolean};
  bidders: {bidder: string; taxonomy: ContextualTaxonomy}[];
  mappings: {value: string; taxonomies: Partial<Record<ContextualTaxonomy, string[]>>}[];
};
export function defaultContextualSignals(): ContextualSignals;
export function normalizeContextualSignals(value?: unknown, context?: {bidders?: {bidder: string; enabled?: number | boolean}[]}): ContextualSignals;
export function requireContextualRuntime(config: unknown, descriptor: unknown): void;
export function contextualSignalsInput(snapshot: {config: {config_json: string}; site: {id: string; domain?: string}; bidders?: {bidder: string; enabled: number}[]; prebidBuilds?: {status: string; version: string}[]}): ContextualSignals & {providerName: string; prebidVersion: string | null};
