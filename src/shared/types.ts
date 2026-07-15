export type PublisherStatus = 'live' | 'staging' | 'draft' | 'archived';
export type PublisherAccountStatus = 'active' | 'draft' | 'archived';

export type Site = {
  id: string;
  publisherAccountId: string | null;
  name: string;
  domain: string;
  gamPath: string;
  status: PublisherStatus;
  currentReleaseId: string | null;
  currentVersion: string;
  lastPublishedAt: string | null;
  adsTxtUrl: string | null;
  createdAt: string;
  updatedAt: string;
  adUnitsCount: number;
  biddersCount: number;
  releasesCount: number;
};

// Backwards-compatible alias while older config modules still use publisherId
// for the site/domain identifier.
export type Publisher = Site;

export type PublisherAccount = {
  id: string;
  name: string;
  status: PublisherAccountStatus;
  notes: string | null;
  sites: Site[];
  sitesCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreatePublisherAccountInput = {
  id: string;
  name: string;
  status?: PublisherAccountStatus;
  notes?: string | null;
};

export type UpdatePublisherAccountInput = Partial<Omit<CreatePublisherAccountInput, 'id'>>;

export type CreateSiteInput = {
  id: string;
  publisherAccountId?: string | null;
  name: string;
  domain: string;
  gamPath: string;
  status?: PublisherStatus;
  adsTxtUrl?: string | null;
};

export type DuplicateSiteInput = {
  id: string;
  publisherAccountId?: string | null;
  name: string;
  domain: string;
  gamPath: string;
  status?: PublisherStatus;
  adsTxtUrl?: string | null;
  copyPrebidBuild?: boolean;
  copyAdsTxtRequirements?: boolean;
};

// Backwards-compatible input aliases for the existing /api/publishers routes.
export type CreatePublisherInput = CreateSiteInput;
export type DuplicatePublisherInput = DuplicateSiteInput;

export type AdUnitType = 'ATF' | 'BTF' | 'DRAFT';

export type AdUnit = {
  id: string;
  publisherId: string;
  code: string;
  type: AdUnitType;
  mediaType: string;
  sizeMapKey: string | null;
  enabled: boolean;
  sortOrder: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateAdUnitInput = {
  code: string;
  type?: AdUnitType;
  mediaType?: string;
  sizeMapKey?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  notes?: string | null;
};

export type UpdateAdUnitInput = Partial<CreateAdUnitInput>;

export type DuplicateAdUnitInput = {
  code: string;
  type?: AdUnitType;
  mediaType?: string;
  enabled?: boolean;
  sortOrder?: number;
  notes?: string | null;
  copySizeMapReference?: boolean;
  copyUnitRule?: boolean;
  copyBidderAdUnitOverrides?: boolean;
};

export type JsonObject = Record<string, unknown>;
export type BidderOverrideScope = 'slot' | 'device' | 'adunit';

export type BidderOverride = {
  id: string;
  publisherId: string;
  bidder: string;
  scopeType: BidderOverrideScope;
  scopeKey: string;
  params: JsonObject;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Bidder = {
  id: string;
  publisherId: string;
  bidder: string;
  params: JsonObject;
  enabled: boolean;
  overrides: BidderOverride[];
  createdAt: string;
  updatedAt: string;
};

export type CreateBidderInput = {
  bidder: string;
  params?: JsonObject;
  enabled?: boolean;
};

export type UpdateBidderInput = Partial<CreateBidderInput>;

export type DuplicateBidderInput = {
  bidder: string;
  enabled?: boolean;
  copyOverrides?: boolean;
};

export type CreateBidderOverrideInput = {
  scopeType: BidderOverrideScope;
  scopeKey: string;
  params?: JsonObject;
  enabled?: boolean;
};

export type UpdateBidderOverrideInput = Partial<CreateBidderOverrideInput>;

export type DuplicateBidderOverrideInput = {
  scopeType?: BidderOverrideScope;
  scopeKey: string;
  enabled?: boolean;
};

export type CsvImportKind = 'ad-units' | 'bidders' | 'bidder-overrides' | 'size-maps';
export type CsvImportRowStatus = 'create' | 'update' | 'error';

export type CsvImportInput = {
  kind: CsvImportKind;
  csv: string;
};

export type CsvImportPreviewRow = {
  rowNumber: number;
  key: string;
  status: CsvImportRowStatus;
  summary: string;
  errors: string[];
  data: JsonObject;
};

export type CsvImportPreview = {
  kind: CsvImportKind;
  totalRows: number;
  createCount: number;
  updateCount: number;
  errorCount: number;
  rows: CsvImportPreviewRow[];
};

export type ApiErrorResponse = {
  ok: false;
  error: string;
  details?: unknown;
};

export type PublishersResponse = {
  ok: true;
  publishers: Site[];
};

export type PublisherResponse = {
  ok: true;
  publisher: Site;
};

export type PublisherAccountsResponse = {
  ok: true;
  publishers: PublisherAccount[];
};

export type PublisherAccountResponse = {
  ok: true;
  publisher: PublisherAccount;
};

export type SiteResponse = {
  ok: true;
  site: Site;
};

export type DeleteSiteResponse = {
  ok: true;
  deletedId: string;
};

export type AdUnitsResponse = {
  ok: true;
  adUnits: AdUnit[];
};

export type AdUnitResponse = {
  ok: true;
  adUnit: AdUnit;
};

export type DeleteAdUnitResponse = {
  ok: true;
  deletedId: string;
};

export type BiddersResponse = {
  ok: true;
  bidders: Bidder[];
};

export type BidderResponse = {
  ok: true;
  bidder: Bidder;
};

export type BidderOverrideResponse = {
  ok: true;
  override: BidderOverride;
};

export type DeleteBidderResponse = {
  ok: true;
  deletedId: string;
};

export type DeleteBidderOverrideResponse = {
  ok: true;
  deletedId: string;
};

export type CsvImportPreviewResponse = {
  ok: true;
  preview: CsvImportPreview;
};

export type CsvImportApplyResponse = {
  ok: true;
  kind: CsvImportKind;
  imported: number;
  created: number;
  updated: number;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  environment: string;
  database: 'connected' | 'not-bound' | 'error';
  timestamp: string;
};
