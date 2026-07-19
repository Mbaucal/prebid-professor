import { createAdsTxtRequirement, type AdsTxtEnv } from './ads-txt';
import { importAdsTxtRequirementsLarge, MAX_ADS_TXT_BULK_ROWS } from './ads-txt-bulk';
import { apiError } from './http';

type ManualRequirementBody = {
  sourceLabel?: unknown;
  entry?: unknown;
  required?: unknown;
};

type ManualRow = {
  sourceLabel: string;
  entry: string;
  required: boolean;
};

function booleanValue(value: unknown, fallback = true): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'no', 'optional'].includes(normalized)) return false;
    if (['true', '1', 'yes', 'required'].includes(normalized)) return true;
  }
  return fallback;
}

function cleanLabel(value: unknown): string {
  return String(value ?? '').trim().replace(/^#+\s*/, '').trim();
}

function fallbackLabel(entry: string): string {
  return entry.split('#')[0].split(',')[0]?.trim() || 'Ads.txt';
}

function jsonRequest(request: Request, body: unknown): Request {
  const headers = new Headers(request.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.delete('content-length');
  return new Request(request.url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function manualRows(body: ManualRequirementBody): ManualRow[] {
  const required = booleanValue(body.required, true);
  const baseLabel = cleanLabel(body.sourceLabel);
  let activeLabel = baseLabel;
  const rows: ManualRow[] = [];

  for (const rawLine of String(body.entry ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      const heading = cleanLabel(line);
      if (heading) activeLabel = heading;
      continue;
    }

    rows.push({
      sourceLabel: activeLabel || fallbackLabel(line),
      entry: line,
      required,
    });
  }

  return rows;
}

export async function createAdsTxtRequirementFlexible(
  request: Request,
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  let body: ManualRequirementBody;
  try {
    body = await request.clone().json() as ManualRequirementBody;
  } catch {
    return createAdsTxtRequirement(request, env, siteId);
  }

  const rows = manualRows(body);
  if (rows.length <= 1) {
    const single = rows[0];
    if (!single) return createAdsTxtRequirement(request, env, siteId);
    return createAdsTxtRequirement(jsonRequest(request, single), env, siteId);
  }

  if (rows.length > MAX_ADS_TXT_BULK_ROWS) {
    return apiError(`Add at most ${MAX_ADS_TXT_BULK_ROWS.toLocaleString('en-US')} ads.txt entries at once.`, 422);
  }

  return importAdsTxtRequirementsLarge(
    jsonRequest(request, { rows, replaceExisting: false }),
    env,
    siteId,
  );
}
