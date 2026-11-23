import type {ScriptSettings} from './saved-script-settings.mjs';

export const AB_HISTORY_PAGE_SIZE:5;
export type AbHistoryCollection='scripts'|'namedTests'|'generatedTests';
export type AbHistoryRow={
  id:string;
  name:string;
  createdAt:string|null;
  deletedAt:string|null;
  state:'stored'|'unavailable';
  reason:string|null;
  runtimeVersion:'3.9.1'|null;
  prebidVersion:'11.34.0'|null;
  testId:null;
  reporting:'variant-only'|'not-instrumented';
  bytes:number|null;
  sha256:string|null;
  downloadUrl:string|null;
  settings?:ScriptSettings;
  trafficBPercent?:number;
  scripts?:Record<'A'|'B',{id:string|null;name:string;settings:ScriptSettings}>;
};
export type AbHistorySection={items:AbHistoryRow[];deleted:AbHistoryRow[];nextCursor:string|null;error:string|null};
/** The first page includes all sections; a collection/cursor response includes only that section. */
export type AbHistoryListing={site:string;sections:Partial<Record<AbHistoryCollection,AbHistorySection>>;baseline:AbHistoryRow|null;baselineError:string|null};
