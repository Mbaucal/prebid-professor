import type {RuntimeServiceEnv} from '../runtime/contracts';
import type {BidderRules} from '../../shared/bidder-rules/settings.mjs';
export type BidderRulesPayload={
  revision:string;
  settings:BidderRules;
  bidders:{bidder:string;enabled:boolean;configured:boolean}[];
  positions:{code:string;enabled:boolean;configured:boolean}[];
  enablePrebid:boolean;
  runtimeEligible:boolean;
  published:false;
};
export function getBidderRuleSettings(env:RuntimeServiceEnv,siteId:string):Promise<BidderRulesPayload>;
export function saveBidderRuleSettings(env:RuntimeServiceEnv,siteId:string,actor:string,body:unknown):Promise<BidderRulesPayload>;
export function bidderRuleSettingsResponse(request:Request,env:RuntimeServiceEnv,siteId:string,actor:string):Promise<Response>;
