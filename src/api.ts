import { normalizeCsvForApi } from './csv';
import type {
  AdUnit,
  AdUnitResponse,
  AdUnitsResponse,
  Bidder,
  BidderOverride,
  BidderOverrideResponse,
  BidderResponse,
  BiddersResponse,
  CreateAdUnitInput,
  CreateBidderInput,
  CreateBidderOverrideInput,
  CreatePublisherAccountInput,
  CreatePublisherInput,
  CreateSiteInput,
  CreateSizeMapInput,
  CreateUnitRuleInput,
  CsvImportApplyResponse,
  CsvImportInput,
  CsvImportPreview,
  CsvImportPreviewResponse,
  DeleteAdUnitResponse,
  DeleteBidderOverrideResponse,
  DeleteBidderResponse,
  DeleteSiteResponse,
  DeleteSizeMapResponse,
  DeleteUnitRuleResponse,
  DuplicateAdUnitInput,
  DuplicateBidderInput,
  DuplicateBidderOverrideInput,
  DuplicatePublisherInput,
  DuplicateSiteInput,
  DuplicateSizeMapInput,
  DuplicateUnitRuleInput,
  HealthResponse,
  Publisher,
  PublisherAccount,
  PublisherAccountResponse,
  PublisherAccountsResponse,
  PublisherResponse,
  PublishersResponse,
  Site,
  SiteResponse,
  SizeMap,
  SizeMapResponse,
  SizeMapsResponse,
  UnitRule,
  UnitRuleResponse,
  UnitRulesResponse,
  UpdateAdUnitInput,
  UpdateBidderInput,
  UpdateBidderOverrideInput,
  UpdatePublisherAccountInput,
  UpdateSiteInput,
  UpdateSizeMapInput,
  UpdateUnitRuleInput,
} from './shared/types';

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}.`);
  }
  return payload;
}

const jsonHeaders = { 'content-type': 'application/json' };

export const api = {
  health(): Promise<HealthResponse> {
    return requestJson<HealthResponse>('/api/health');
  },

  async listPublisherAccounts(): Promise<PublisherAccount[]> {
    const payload = await requestJson<PublisherAccountsResponse>('/api/publisher-accounts');
    return payload.publishers;
  },

  async getPublisherAccount(id: string): Promise<PublisherAccount> {
    const payload = await requestJson<PublisherAccountResponse>(
      `/api/publisher-accounts/${encodeURIComponent(id)}`,
    );
    return payload.publisher;
  },

  async createPublisherAccount(input: CreatePublisherAccountInput): Promise<PublisherAccount> {
    const payload = await requestJson<PublisherAccountResponse>('/api/publisher-accounts', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    });
    return payload.publisher;
  },

  async updatePublisherAccount(
    id: string,
    input: UpdatePublisherAccountInput,
  ): Promise<PublisherAccount> {
    const payload = await requestJson<PublisherAccountResponse>(
      `/api/publisher-accounts/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.publisher;
  },

  async deletePublisherAccount(id: string): Promise<string> {
    const payload = await requestJson<{ ok: true; deletedId: string }>(
      `/api/publisher-accounts/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    return payload.deletedId;
  },

  async createSite(input: CreateSiteInput): Promise<Site> {
    const payload = await requestJson<SiteResponse>('/api/sites', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    });
    return payload.site;
  },

  async updateSite(siteId: string, input: UpdateSiteInput): Promise<Site> {
    const payload = await requestJson<SiteResponse>(`/api/sites/${encodeURIComponent(siteId)}`, {
      method: 'PATCH',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    });
    return payload.site;
  },

  async duplicateSite(sourceId: string, input: DuplicateSiteInput): Promise<Site> {
    const payload = await requestJson<SiteResponse>(
      `/api/sites/${encodeURIComponent(sourceId)}/duplicate`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.site;
  },

  async moveSite(siteId: string, publisherAccountId: string): Promise<Site> {
    const payload = await requestJson<SiteResponse>(
      `/api/sites/${encodeURIComponent(siteId)}/move`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ publisherAccountId }),
      },
    );
    return payload.site;
  },

  async deleteSite(siteId: string): Promise<string> {
    const payload = await requestJson<DeleteSiteResponse>(
      `/api/sites/${encodeURIComponent(siteId)}`,
      { method: 'DELETE' },
    );
    return payload.deletedId;
  },

  // Legacy site API aliases retained while configuration modules still use publisherId.
  async listPublishers(): Promise<Publisher[]> {
    const payload = await requestJson<PublishersResponse>('/api/publishers');
    return payload.publishers;
  },

  async getPublisher(id: string): Promise<Publisher> {
    const payload = await requestJson<PublisherResponse>(`/api/publishers/${encodeURIComponent(id)}`);
    return payload.publisher;
  },

  async createPublisher(input: CreatePublisherInput): Promise<Publisher> {
    const payload = await requestJson<PublisherResponse>('/api/publishers', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify(input),
    });
    return payload.publisher;
  },

  async duplicatePublisher(sourceId: string, input: DuplicatePublisherInput): Promise<Publisher> {
    const payload = await requestJson<PublisherResponse>(
      `/api/publishers/${encodeURIComponent(sourceId)}/duplicate`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.publisher;
  },

  async listAdUnits(publisherId: string): Promise<AdUnit[]> {
    const payload = await requestJson<AdUnitsResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/ad-units`,
    );
    return payload.adUnits;
  },

  async createAdUnit(publisherId: string, input: CreateAdUnitInput): Promise<AdUnit> {
    const payload = await requestJson<AdUnitResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/ad-units`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.adUnit;
  },

  async updateAdUnit(
    publisherId: string,
    adUnitId: string,
    input: UpdateAdUnitInput,
  ): Promise<AdUnit> {
    const payload = await requestJson<AdUnitResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/ad-units/${encodeURIComponent(adUnitId)}`,
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.adUnit;
  },

  async duplicateAdUnit(
    publisherId: string,
    adUnitId: string,
    input: DuplicateAdUnitInput,
  ): Promise<AdUnit> {
    const payload = await requestJson<AdUnitResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/ad-units/${encodeURIComponent(adUnitId)}/duplicate`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.adUnit;
  },

  async deleteAdUnit(publisherId: string, adUnitId: string): Promise<string> {
    const payload = await requestJson<DeleteAdUnitResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/ad-units/${encodeURIComponent(adUnitId)}`,
      { method: 'DELETE' },
    );
    return payload.deletedId;
  },

  async listSizeMaps(publisherId: string): Promise<SizeMap[]> {
    const payload = await requestJson<SizeMapsResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/size-maps`,
    );
    return payload.sizeMaps;
  },

  async createSizeMap(publisherId: string, input: CreateSizeMapInput): Promise<SizeMap> {
    const payload = await requestJson<SizeMapResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/size-maps`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.sizeMap;
  },

  async updateSizeMap(
    publisherId: string,
    sizeMapId: string,
    input: UpdateSizeMapInput,
  ): Promise<SizeMap> {
    const payload = await requestJson<SizeMapResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/size-maps/${encodeURIComponent(sizeMapId)}`,
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.sizeMap;
  },

  async duplicateSizeMap(
    publisherId: string,
    sizeMapId: string,
    input: DuplicateSizeMapInput,
  ): Promise<SizeMap> {
    const payload = await requestJson<SizeMapResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/size-maps/${encodeURIComponent(sizeMapId)}/duplicate`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.sizeMap;
  },

  async deleteSizeMap(publisherId: string, sizeMapId: string): Promise<string> {
    const payload = await requestJson<DeleteSizeMapResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/size-maps/${encodeURIComponent(sizeMapId)}`,
      { method: 'DELETE' },
    );
    return payload.deletedId;
  },

  async listUnitRules(publisherId: string): Promise<UnitRule[]> {
    const payload = await requestJson<UnitRulesResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/unit-rules`,
    );
    return payload.unitRules;
  },

  async createUnitRule(publisherId: string, input: CreateUnitRuleInput): Promise<UnitRule> {
    const payload = await requestJson<UnitRuleResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/unit-rules`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.unitRule;
  },

  async updateUnitRule(
    publisherId: string,
    unitRuleId: string,
    input: UpdateUnitRuleInput,
  ): Promise<UnitRule> {
    const payload = await requestJson<UnitRuleResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/unit-rules/${encodeURIComponent(unitRuleId)}`,
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.unitRule;
  },

  async duplicateUnitRule(
    publisherId: string,
    unitRuleId: string,
    input: DuplicateUnitRuleInput,
  ): Promise<UnitRule> {
    const payload = await requestJson<UnitRuleResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/unit-rules/${encodeURIComponent(unitRuleId)}/duplicate`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.unitRule;
  },

  async deleteUnitRule(publisherId: string, unitRuleId: string): Promise<string> {
    const payload = await requestJson<DeleteUnitRuleResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/unit-rules/${encodeURIComponent(unitRuleId)}`,
      { method: 'DELETE' },
    );
    return payload.deletedId;
  },

  async listBidders(publisherId: string): Promise<Bidder[]> {
    const payload = await requestJson<BiddersResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidders`,
    );
    return payload.bidders;
  },

  async createBidder(publisherId: string, input: CreateBidderInput): Promise<Bidder> {
    const payload = await requestJson<BidderResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidders`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.bidder;
  },

  async updateBidder(
    publisherId: string,
    bidderId: string,
    input: UpdateBidderInput,
  ): Promise<Bidder> {
    const payload = await requestJson<BidderResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidders/${encodeURIComponent(bidderId)}`,
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.bidder;
  },

  async duplicateBidder(
    publisherId: string,
    bidderId: string,
    input: DuplicateBidderInput,
  ): Promise<Bidder> {
    const payload = await requestJson<BidderResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidders/${encodeURIComponent(bidderId)}/duplicate`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.bidder;
  },

  async deleteBidder(publisherId: string, bidderId: string): Promise<string> {
    const payload = await requestJson<DeleteBidderResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidders/${encodeURIComponent(bidderId)}`,
      { method: 'DELETE' },
    );
    return payload.deletedId;
  },

  async createBidderOverride(
    publisherId: string,
    bidderId: string,
    input: CreateBidderOverrideInput,
  ): Promise<BidderOverride> {
    const payload = await requestJson<BidderOverrideResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidders/${encodeURIComponent(bidderId)}/overrides`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.override;
  },

  async updateBidderOverride(
    publisherId: string,
    overrideId: string,
    input: UpdateBidderOverrideInput,
  ): Promise<BidderOverride> {
    const payload = await requestJson<BidderOverrideResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidder-overrides/${encodeURIComponent(overrideId)}`,
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.override;
  },

  async duplicateBidderOverride(
    publisherId: string,
    overrideId: string,
    input: DuplicateBidderOverrideInput,
  ): Promise<BidderOverride> {
    const payload = await requestJson<BidderOverrideResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidder-overrides/${encodeURIComponent(overrideId)}/duplicate`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(input),
      },
    );
    return payload.override;
  },

  async deleteBidderOverride(publisherId: string, overrideId: string): Promise<string> {
    const payload = await requestJson<DeleteBidderOverrideResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/bidder-overrides/${encodeURIComponent(overrideId)}`,
      { method: 'DELETE' },
    );
    return payload.deletedId;
  },

  async previewCsvImport(publisherId: string, input: CsvImportInput): Promise<CsvImportPreview> {
    const payload = await requestJson<CsvImportPreviewResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/imports/preview`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ ...input, csv: normalizeCsvForApi(input.csv) }),
      },
    );
    return payload.preview;
  },

  applyCsvImport(publisherId: string, input: CsvImportInput): Promise<CsvImportApplyResponse> {
    return requestJson<CsvImportApplyResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}/imports/apply`,
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ ...input, csv: normalizeCsvForApi(input.csv) }),
      },
    );
  },
};
