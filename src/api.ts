import type {
  CreatePublisherInput,
  DuplicatePublisherInput,
  HealthResponse,
  Publisher,
  PublisherResponse,
  PublishersResponse,
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
};
