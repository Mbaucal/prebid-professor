import { createAdsTxtRequirement, importAdsTxtRequirements, type AdsTxtEnv } from './ads-txt';
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

const MAX_MANUAL_ROWS = 100;

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
    const normalizedRequest = new Request(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(single),
    });
    return createAdsTxtRequirement(normalizedRequest, env, siteId);
  }

  if (rows.length > MAX_MANUAL_ROWS) {
    return apiError(`Add at most ${MAX_MANUAL_ROWS} ads.txt entries at once.`, 422);
  }

  const importRequest = new Request(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ rows, replaceExisting: false }),
  });
  return importAdsTxtRequirements(importRequest, env, siteId);
}
