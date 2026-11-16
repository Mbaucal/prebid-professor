import type {BidderAccount} from '../../shared/bidder-accounts/settings.mjs';
export function savedBidderAccounts(snapshot: {bidders?: Array<{bidder:string; account_json?:string; enabled:number}>}, options?: {activeOnly?:boolean}): BidderAccount[];
export function requireBidderAccounts(snapshot: unknown, descriptor: unknown): void;
export function bidderAccountsForBuild(snapshot: unknown, descriptor: unknown): BidderAccount[];
