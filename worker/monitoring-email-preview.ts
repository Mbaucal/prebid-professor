import { apiError, json } from './http';
import type { DatabaseEnv } from './publishers';

export interface MonitoringEmailPreviewEnv extends DatabaseEnv {}

export type MonitoringEmailLiveSnapshot = {
  fetchedAt: string;
  finalUrl: string | null;
  httpStatus: number | null;
  content: string;
  error: string | null;
};

type SiteRow = {
  id: string;
  name: string;
  domain: string;
  ads_txt_url: string | null;
  publisher_name: string | null;
};

type RequirementRow = {
  source_label: string;
  entry: string;
  required: number;
};

const MAX_ADS_TXT_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

function blockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  if (normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a, b] = octets;
  return a === 10
    || a === 127
    || a === 0
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function validatedPublicUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS ads.txt URLs are allowed.');
  if (url.username || url.password) throw new Error('Ads.txt URLs cannot contain credentials.');
  if (blockedHostname(url.hostname)) throw new Error('The ads.txt URL must use a public hostname.');
  return url;
}

async function limitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_ADS_TXT_BYTES) throw new Error('The ads.txt response is larger than 2 MB.');
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_ADS_TXT_BYTES) {
      await reader.cancel();
      throw new Error('The ads.txt response is larger than 2 MB.');
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function fetchAdsTxt(initialUrl: string): Promise<{
  content: string;
  finalUrl: string;
  httpStatus: number;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort('ads.txt fetch timed out'), FETCH_TIMEOUT_MS);
  let current = validatedPublicUrl(initialUrl);

  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      const response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          accept: 'text/plain,text/*;q=0.9,*/*;q=0.5',
          'user-agent': 'Tessera-Monitoring-Preview/1.0',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new Error(`Redirect ${response.status} did not include a Location header.`);
        current = validatedPublicUrl(new URL(location, current).toString());
        continue;
      }

      return {
        content: response.ok ? await limitedText(response) : '',
        finalUrl: current.toString(),
        httpStatus: response.status,
      };
    }
    throw new Error('The ads.txt URL redirected too many times.');
  } finally {
    clearTimeout(timeout);
  }
}

export async function getMonitoringEmailPreviewData(
  env: MonitoringEmailPreviewEnv,
  siteId: string,
  snapshot?: MonitoringEmailLiveSnapshot,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured.', 503);

  const site = await env.DB
    .prepare(
      `SELECT p.id, p.name, p.domain, p.ads_txt_url, pa.name AS publisher_name
       FROM publishers p
       LEFT JOIN publisher_accounts pa ON pa.id = p.publisher_account_id
       WHERE p.id = ?
       LIMIT 1`,
    )
    .bind(siteId)
    .first<SiteRow>();

  if (!site) return apiError('Site not found.', 404);

  const requirements = await env.DB
    .prepare(
      `SELECT source_label, entry, required
       FROM ads_txt_requirements
       WHERE publisher_id = ?
       ORDER BY required DESC, source_label COLLATE NOCASE, entry COLLATE NOCASE`,
    )
    .bind(siteId)
    .all<RequirementRow>();

  const adsTxtUrl = site.ads_txt_url || `https://${site.domain}/ads.txt`;
  const fetchedAt = snapshot?.fetchedAt ?? new Date().toISOString();
  let liveContent = snapshot?.content ?? '';
  let finalUrl: string | null = snapshot?.finalUrl ?? null;
  let httpStatus: number | null = snapshot?.httpStatus ?? null;
  let fetchError: string | null = snapshot?.error ?? null;

  if (!snapshot) {
    try {
      const fetched = await fetchAdsTxt(adsTxtUrl);
      liveContent = fetched.content;
      finalUrl = fetched.finalUrl;
      httpStatus = fetched.httpStatus;
      if (fetched.httpStatus < 200 || fetched.httpStatus >= 300) {
        fetchError = `ads.txt returned HTTP ${fetched.httpStatus}.`;
      }
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
    }
  }

  return json({
    ok: true,
    readOnly: true,
    fetchedAt,
    site: {
      id: site.id,
      name: site.name,
      domain: site.domain,
      publisherName: site.publisher_name || '',
      adsTxtUrl,
    },
    live: {
      finalUrl,
      httpStatus,
      content: liveContent,
      error: fetchError,
    },
    expected: (requirements.results ?? []).map((row) => ({
      sourceLabel: row.source_label,
      entry: row.entry,
      required: row.required === 1,
    })),
  });
}
