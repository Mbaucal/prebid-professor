import type { RuntimeServiceEnv } from '../runtime/contracts';
export function outstreamSettingsResponse(request:Request,env:RuntimeServiceEnv,siteId:string,actor:string):Promise<Response>;
export function hasEnabledOutstream(config:unknown):boolean;
