/** The caller authenticates, checks the origin and owns the selected site's boundary. */
export type { MeasurementReport, MeasurementPlan, MeasurementPlanListing, MeasurementPlanDetail, GamReportPreview } from './ab-measurement-contracts.mjs';
export type AbSavedPackage = {
  files: Record<string, Uint8Array>;
  release: {
    id: string;
    siteId?: string;
    publisher_id?: string;
    note?: string | null;
    notes?: string | null;
    runtime?: { runtimeVersion?: string };
  };
  manifest?: Record<string, unknown>;
};

export type AbVersionChoice = {
  id: string;
  name: string;
  createdAt: string;
  runtimeVersion: string;
  prebidVersion: string | null;
};

export type AbTestsOptions = {
  bucket: R2Bucket;
  site: string;
  actor: { email: string };
  base: string;
  headers: HeadersInit;
  testOnly?: boolean;
  /** Read the complete immutable package, including its original manifest. */
  readVersion(id: string): Promise<AbSavedPackage>;
  listVersions(): Promise<readonly AbVersionChoice[]>;
  current?(): string | null | Promise<string | null>;
  defaults?: { trafficBPercent: number };
};

export function abTestsResponse(request: Request, options: AbTestsOptions): Promise<Response | null>;
