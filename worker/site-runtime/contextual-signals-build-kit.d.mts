import type {RuntimeServiceEnv} from '../runtime/contracts';
export function contextualBuildKit(snapshot: {site:{id:string};prebidBuilds?:Array<{version:string;modules_json:string}>}): Record<string, Uint8Array>;
export function contextualBuildKitResponse(request:Request,env:RuntimeServiceEnv,siteId:string):Promise<Response>;
