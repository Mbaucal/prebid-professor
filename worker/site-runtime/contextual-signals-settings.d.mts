import type {RuntimeServiceEnv} from '../runtime/contracts';
import type {ContextualSignals} from '../../shared/contextual-signals/settings.mjs';
export type ContextualSignalsPayload={
  revision:string;
  settings:ContextualSignals;
  bidders:{bidder:string;enabled:boolean;configured:boolean}[];
  enablePrebid:boolean;
  prebidVersion:string|null;
  runtimeEligible:boolean;
  compatibility:{bidder:string;delivery:string;note:string;source:string|null;evidence:string;serverAcceptance:string}[];
  taxonomies:{id:string;label:string;segtax:number;categories:{id:string;name:string}[]}[];
  published:false;
};
export function getContextualSignalSettings(env:RuntimeServiceEnv,siteId:string):Promise<ContextualSignalsPayload>;
export function saveContextualSignalSettings(env:RuntimeServiceEnv,siteId:string,actor:string,body:unknown):Promise<ContextualSignalsPayload>;
export function contextualSignalSettingsResponse(request:Request,env:RuntimeServiceEnv,siteId:string,actor:string):Promise<Response>;
