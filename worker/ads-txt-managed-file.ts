import type { AdsTxtEnv } from './ads-txt';
import { listAdsTxtRequirementSources } from './ads-txt-requirement-sources';
import { apiError, json } from './http';

const MAX_MANAGED_ADS_TXT_BYTES = 2 * 1024 * 1024;

type ManagedSourceRow = {
  id: string;
  sourceLabel: string;
  entry: string;
  required: boolean;
};

type RequirementListPayload = {
  ok: true;
  siteId: string;
  adsTxtUrl: string;
  requirements: ManagedSourceRow[];
  requirementRowCount?: number;
  canonicalRequirementCount?: number;
};

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

function cleanHeading(value: string): string {
  return value.trim().replace(/^#+\s*/, '').trim();
}

function splitEntry(value: string): {
  record: string;
  inlineComment: string;
} {
  const raw = value.replace(/^\uFEFF/, '').trim();
  const commentIndex = raw.indexOf('#');
  return {
    record: (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim(),
    inlineComment: (commentIndex >= 0 ? raw.slice(commentIndex + 1) : '').trim(),
  };
}

function inferredLabel(entry: string): string {
  const { record } = splitEntry(entry);
  const equalsIndex = record.indexOf('=');
  const commaIndex = record.indexOf(',');
  if (equalsIndex > 0 && (commaIndex < 0 || equalsIndex < commaIndex)) {
    return record.slice(0, equalsIndex).trim();
  }
  return record.split(',')[0]?.trim() ?? '';
}

function visibleHeading(row: ManagedSourceRow): string | null {
  const heading = cleanHeading(row.sourceLabel);
  if (!heading) return null;

  const { inlineComment } = splitEntry(row.entry);
  if (inlineComment && normalized(heading) === normalized(inlineComment)) return null;

  const automaticLabel = inferredLabel(row.entry);
  if (automaticLabel && normalized(heading) === normalized(automaticLabel)) return null;
  return heading;
}

function buildManagedContent(rows: ManagedSourceRow[]): {
  content: string;
  headingCount: number;
} {
  const lines: string[] = [];
  let activeHeading: string | null = null;
  let headingCount = 0;

  for (const row of rows) {
    const entry = row.entry.replace(/^\uFEFF/, '').trim();
    if (!entry) continue;

    const heading = visibleHeading(row);
    const headingKey = heading ? normalized(heading) : null;

    if (headingKey) {
      if (headingKey !== activeHeading) {
        if (lines.length && lines[lines.length - 1] !== '') lines.push('');
        lines.push(`#${heading}`);
        headingCount += 1;
        activeHeading = headingKey;
      }
    } else if (activeHeading !== null) {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      activeHeading = null;
    }

    lines.push(entry);
  }

  while (lines[lines.length - 1] === '') lines.pop();
  return {
    content: lines.length ? `${lines.join('\n')}\n` : '',
    headingCount,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function getManagedAdsTxtFile(
  env: AdsTxtEnv,
  siteId: string,
): Promise<Response> {
  const requirementsResponse = await listAdsTxtRequirementSources(env, siteId);
  if (!requirementsResponse.ok) return requirementsResponse;

  let payload: RequirementListPayload;
  try {
    payload = await requirementsResponse.json() as RequirementListPayload;
  } catch (error) {
    return apiError(
      'Managed ads.txt file could not be generated.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  const generated = buildManagedContent(payload.requirements ?? []);
  const bytes = new TextEncoder().encode(generated.content).byteLength;
  if (bytes > MAX_MANAGED_ADS_TXT_BYTES) {
    return apiError(
      'The generated ads.txt file is larger than 2 MB. Remove unnecessary rows before downloading it.',
      413,
    );
  }

  const rowCount = payload.requirementRowCount ?? payload.requirements.length;
  const canonicalCount = payload.canonicalRequirementCount ?? rowCount;
  const generatedAt = new Date().toISOString();

  return json({
    ok: true,
    file: {
      siteId,
      adsTxtUrl: payload.adsTxtUrl,
      fileName: 'ads.txt',
      content: generated.content,
      generatedAt,
      rowCount,
      canonicalCount,
      repeatedRowCount: Math.max(0, rowCount - canonicalCount),
      headingCount: generated.headingCount,
      lineCount: generated.content
        ? generated.content.slice(0, -1).split('\n').length
        : 0,
      byteSize: bytes,
      checksum: `sha256:${await sha256(generated.content)}`,
    },
  });
}
