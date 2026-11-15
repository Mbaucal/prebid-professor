export type AccountSchainNode = {asi: string; sid: string; hp: 1; rid?: string; name?: string; domain?: string; ext?: Record<string, unknown>};
export type AccountSchainConfig = {ver: '1.0'; complete: 0 | 1; nodes: AccountSchainNode[]; ext?: Record<string, unknown>};
export type BidderAccountSchain = {mode: 'inherit' | 'custom' | 'none'; config?: AccountSchainConfig};
export type BidderAccount = {bidder: string; baseAdapter: string; displayName: string; schain: BidderAccountSchain};
export function normalizeAccountSchain(value: unknown): AccountSchainConfig;
export function normalizeBidderAccount(value?: unknown, context?: {bidder?: string}): BidderAccount;
export function normalizeBidderAccounts(value?: unknown): BidderAccount[];
