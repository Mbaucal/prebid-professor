export type PublisherStatus = 'live' | 'staging' | 'draft' | 'archived';

export type Publisher = {
  id: string;
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

export type CreatePublisherInput = {
  id: string;
  name: string;
  domain: string;
  gamPath: string;
  status?: PublisherStatus;
  adsTxtUrl?: string | null;
};

export type DuplicatePublisherInput = {
  id: string;
  name: string;
  domain: string;
  gamPath: string;
  status?: PublisherStatus;
  adsTxtUrl?: string | null;
  copyPrebidBuild?: boolean;
  copyAdsTxtRequirements?: boolean;
};

export type ApiErrorResponse = {
  ok: false;
  error: string;
  details?: unknown;
};

export type PublishersResponse = {
  ok: true;
  publishers: Publisher[];
};

export type PublisherResponse = {
  ok: true;
  publisher: Publisher;
};

export type HealthResponse = {
  ok: boolean;
  service: string;
  environment: string;
  database: 'connected' | 'not-bound' | 'error';
  timestamp: string;
};
