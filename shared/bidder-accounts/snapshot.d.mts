import type {BidderAccount} from './settings.mjs';
export function savedBidderAccounts(snapshot: {bidders?: Array<{bidder:string; account_json?:string; enabled:number}>}, options?: {activeOnly?:boolean}): BidderAccount[];
export function bidderAccountsForBuild(snapshot: unknown): BidderAccount[];
