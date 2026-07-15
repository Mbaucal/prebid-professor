import type {
  AdUnit,
  AdUnitResponse,
  AdUnitsResponse,
  CreateAdUnitInput,
  CreatePublisherInput,
  DeleteAdUnitResponse,
  DuplicateAdUnitInput,
  DuplicatePublisherInput,
  HealthResponse,
  Publisher,
  PublisherResponse,
  PublishersResponse,
  UpdateAdUnitInput,
} from './shared/types';

async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}.`);
  }

  return payload;
}

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
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return payload.publisher;
  },

  async duplicatePublisher(sourceId: string, input: DuplicatePublisherInput): Promise<Publisher> {
    const payload = await requestJson<PublisherResponse>(
      `/api/publishers/${encodeURIComponent(sourceId)}/duplicate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
        headers: { 'content-type': 'application/json' },
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
        headers: { 'content-type': 'application/json' },
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
        headers: { 'content-type': 'application/json' },
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
};
