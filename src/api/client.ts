import type {
  ApiErrorResponse,
  CreatePublisherInput,
  DuplicatePublisherInput,
  HealthResponse,
  PublisherResponse,
  PublishersResponse,
} from '../shared/types';

type ApiSuccess = PublishersResponse | PublisherResponse | HealthResponse;

async function requestJson<T extends ApiSuccess>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const payload = (await response.json().catch(() => null)) as
    | T
    | ApiErrorResponse
    | null;

  if (!response.ok) {
    const message =
      payload && 'error' in payload
        ? payload.error
        : `API request failed with status ${response.status}`;

    throw new Error(message);
  }

  if (!payload) {
    throw new Error('API returned an empty response.');
  }

  return payload as T;
}

export const api = {
  health(): Promise<HealthResponse> {
    return requestJson<HealthResponse>('/api/health');
  },

  listPublishers(): Promise<PublishersResponse> {
    return requestJson<PublishersResponse>('/api/publishers');
  },

  getPublisher(publisherId: string): Promise<PublisherResponse> {
    return requestJson<PublisherResponse>(
      `/api/publishers/${encodeURIComponent(publisherId)}`,
    );
  },

  createPublisher(input: CreatePublisherInput): Promise<PublisherResponse> {
    return requestJson<PublisherResponse>('/api/publishers', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  duplicatePublisher(
    sourcePublisherId: string,
    input: DuplicatePublisherInput,
  ): Promise<PublisherResponse> {
    return requestJson<PublisherResponse>(
      `/api/publishers/${encodeURIComponent(sourcePublisherId)}/duplicate`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    );
  },
};
