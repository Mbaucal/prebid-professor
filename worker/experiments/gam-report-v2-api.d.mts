import type {AbTestsOptions} from './ab-tests-api.mjs';
export function gamReportV2Response(request:Request,options:Pick<AbTestsOptions,'bucket'|'site'|'actor'|'base'|'headers'|'readVersion'>):Promise<Response|null>;
