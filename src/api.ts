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
  CreatePublisherInput,
  DeleteAdUnitResponse,
  DeleteBidderOverrideResponse,
  DeleteBidderResponse,
  DuplicateAdUnitInput,
  DuplicateBidderInput,
  DuplicateBidderOverrideInput,
  DuplicatePublisherInput,
  HealthResponse,
  Publisher,
  PublisherResponse,
  PublishersResponse,
  UpdateAdUnitInput,
  UpdateBidderInput,
  UpdateBidderOverrideInput,
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
};
