export type AdaptiveTimeoutPolicy = {enabled:boolean;minMs:number;maxMs:number;mobileAdjustmentMs:number;slowConnectionAdjustmentMs:number;videoAdjustmentMs:number;additionalPositionMs:number;maxPositionAdjustmentMs:number};
export const DEFAULT_ADAPTIVE_TIMEOUT: Readonly<AdaptiveTimeoutPolicy>;
export function normalizeAdaptiveTimeout(value?: unknown): AdaptiveTimeoutPolicy;
export function requireAdaptiveTimeoutRuntime(config: {adaptiveAuctionTimeout?:unknown},runtime: {capabilities?:string[]}):void;
