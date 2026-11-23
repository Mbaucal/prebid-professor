import type {RuntimeServiceEnv} from '../runtime/contracts';
export type {AbHistoryCollection,AbHistoryRow,AbHistorySection,AbHistoryListing} from '../experiments/ab-history-contracts.mjs';
export function abHistoryResponse(request:Request,env:RuntimeServiceEnv,site:string):Promise<Response|null>;
