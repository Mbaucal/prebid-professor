import { apiError, getActor, json, readJson } from './http';
import type { DatabaseEnv } from './publishers';

export interface AdsTxtSourceEnv extends DatabaseEnv {}

type SiteRow = {
  id: string;
  name: string;
  domain: string;
  ads_txt_url: string | null;
};

type SourceDocumentRow = {
  site_id: string;
  source_url: string;
  base_content: string;
  draft_content: string;
  base_hash: string;
  draft_hash: string;
  revision: number;
  synced_at: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

type SourceVersionRow = {
  id: string;
  revision: number;
  change_type: string;
  summary: string | null;
  actor: string | null;
  created_at: string;
};

type ParsedDocument = {
  lines: string[];
  newline: '\n' | '\r\n';
  endsWithNewline: boolean;
};

type SourceMutationInput = {
  revision?: unknown;
  text?: unknown;
  afterIndex?: unknown;
};

const MAX_ADS_TXT_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_LINES = 50_000;
const FETCH_TIMEOUT_MS = 12_000;
const VERSION_LIMIT = 12;

let schemaReady: Promise<void> | null = null;

class SourceRequestError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

function databaseMissing(): Response {
  return apiError('D1 database binding is not configured.', 503);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function ensureSourceTables(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_source_documents (
        site_id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        base_content TEXT NOT NULL DEFAULT '',
        draft_content TEXT NOT NULL DEFAULT '',
        base_hash TEXT NOT NULL DEFAULT '',
        draft_hash TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,
        synced_at TEXT,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
      )`),
      db.prepare(`CREATE TABLE IF NOT EXISTS ads_txt_source_versions (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        change_type TEXT NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        actor TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (site_id, revision),
        FOREIGN KEY (site_id) REFERENCES publishers(id) ON DELETE CASCADE
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS idx_ads_txt_source_versions_site
        ON ads_txt_source_versions(site_id, revision DESC)`),
    ]).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

async function fetchSite(db: D1Database, siteId: string): Promise<SiteRow | null> {
  return db.prepare(
    'SELECT id, name, domain, ads_txt_url FROM publishers WHERE id = ? LIMIT 1',
  ).bind(siteId).first<SiteRow>();
}

async function fetchDocument(db: D1Database, siteId: string): Promise<SourceDocumentRow | null> {
  await ensureSourceTables(db);
  return db.prepare(`SELECT site_id, source_url, base_content, draft_content, base_hash,
      draft_hash, revision, synced_at, updated_by, created_at, updated_at
    FROM ads_txt_source_documents WHERE site_id = ? LIMIT 1`)
    .bind(siteId)
    .first<SourceDocumentRow>();
}

async function recentVersions(db: D1Database, siteId: string): Promise<SourceVersionRow[]> {
  await ensureSourceTables(db);
  const result = await db.prepare(`SELECT id, revision, change_type, summary, actor, created_at
    FROM ads_txt_source_versions
    WHERE site_id = ?
    ORDER BY revision DESC
    LIMIT ?`)
    .bind(siteId, VERSION_LIMIT)
    .all<SourceVersionRow>();
  return result.results ?? [];
}

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
  if (!['http:', 'https:'].includes(url.protocol)) throw new SourceRequestError('Only HTTP and HTTPS ads.txt URLs are allowed.');
  if (url.username || url.password) throw new SourceRequestError('Ads.txt URLs cannot contain credentials.');
  if (blockedHostname(url.hostname)) throw new SourceRequestError('The ads.txt URL must use a public hostname.');
  return url;
}

async function limitedText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > MAX_ADS_TXT_BYTES) throw new SourceRequestError('The ads.txt response is larger than 2 MB.');
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
      throw new SourceRequestError('The ads.txt response is larger than 2 MB.');
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

async function fetchLiveAdsTxt(initialUrl: string): Promise<{ content: string; finalUrl: string; httpStatus: number }> {
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
          'user-agent': 'Tessera-AdsTxt-Source-Editor/1.0',
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new SourceRequestError(`Redirect ${response.status} did not include a Location header.`);
        current = validatedPublicUrl(new URL(location, current).toString());
        continue;
      }

      if (!response.ok) throw new SourceRequestError(`ads.txt returned HTTP ${response.status}.`, 502);
      return {
        content: await limitedText(response),
        finalUrl: current.toString(),
        httpStatus: response.status,
      };
    }
    throw new SourceRequestError('The ads.txt URL redirected too many times.', 502);
  } finally {
    clearTimeout(timeout);
  }
}

function parseDocument(content: string): ParsedDocument {
  const newline: '\n' | '\r\n' = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const endsWithNewline = normalized.endsWith('\n');
  const lines = normalized.split('\n');
  if (endsWithNewline) lines.pop();
  if (lines.length > MAX_SOURCE_LINES) throw new SourceRequestError(`The ads.txt file contains more than ${MAX_SOURCE_LINES.toLocaleString('en-US')} lines.`);
  return { lines, newline, endsWithNewline };
}

function joinDocument(document: ParsedDocument): string {
  return document.lines.join(document.newline) + (document.endsWithNewline ? document.newline : '');
}

function lineKind(value: string): 'blank' | 'comment' | 'record' | 'other' {
  const trimmed = value.trim();
  if (!trimmed) return 'blank';
  if (trimmed.startsWith('#')) return 'comment';
  const commentIndex = trimmed.indexOf('#');
  const record = (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
  const fields = record.split(',').map((field) => field.trim());
  return fields.length >= 3 && fields[0].includes('.') ? 'record' : 'other';
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validateSingleLine(value: unknown): string {
  const text = String(value ?? '');
  if (text.includes('\n') || text.includes('\r')) throw new SourceRequestError('Edit one physical ads.txt line at a time.');
  if (new TextEncoder().encode(text).byteLength > 16_384) throw new SourceRequestError('One ads.txt line cannot exceed 16 KB.');
  return text;
}

function revisionValue(value: unknown): number {
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) throw new SourceRequestError('A valid draft revision is required.');
  return revision;
}

function auditStatement(
  db: D1Database,
  actor: string,
  action: string,
  siteId: string,
  details: Record<string, unknown>,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO audit_log (
      id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
    ) VALUES (?, ?, ?, ?, 'ads_txt_source', ?, ?, ?)`)
    .bind(crypto.randomUUID(), actor, action, siteId, siteId, JSON.stringify(details), createdAt);
}

function versionStatement(
  db: D1Database,
  siteId: string,
  revision: number,
  changeType: string,
  summary: string,
  content: string,
  actor: string,
  createdAt: string,
): D1PreparedStatement {
  return db.prepare(`INSERT INTO ads_txt_source_versions (
      id, site_id, revision, change_type, summary, content, actor, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), siteId, revision, changeType, summary, content, actor, createdAt);
}

async function sourcePayload(
  db: D1Database,
  site: SiteRow,
  document: SourceDocumentRow | null,
): Promise<Record<string, unknown>> {
  if (!document) {
    return {
      ok: true,
      initialized: false,
      site: {
        id: site.id,
        name: site.name,
        domain: site.domain,
        adsTxtUrl: site.ads_txt_url || `https://${site.domain}/ads.txt`,
      },
      document: null,
    };
  }

  const parsed = parseDocument(document.draft_content);
  const versions = await recentVersions(db, site.id);
  return {
    ok: true,
    initialized: true,
    site: {
      id: site.id,
      name: site.name,
      domain: site.domain,
      adsTxtUrl: site.ads_txt_url || `https://${site.domain}/ads.txt`,
    },
    document: {
      sourceUrl: document.source_url,
      revision: Number(document.revision),
      dirty: document.base_hash !== document.draft_hash,
      syncedAt: document.synced_at,
      updatedAt: document.updated_at,
      updatedBy: document.updated_by,
      content: document.draft_content,
      bytes: new TextEncoder().encode(document.draft_content).byteLength,
      lineCount: parsed.lines.length,
      nonEmptyLineCount: parsed.lines.filter((line) => line.trim()).length,
      lines: parsed.lines.map((text, index) => ({
        index,
        lineNumber: index + 1,
        text,
        kind: lineKind(text),
      })),
      versions: versions.map((version) => ({
        id: version.id,
        revision: Number(version.revision),
        changeType: version.change_type,
        summary: version.summary || '',
        actor: version.actor,
        createdAt: version.created_at,
      })),
    },
  };
}

async function applyDraftMutation(
  request: Request,
  env: AdsTxtSourceEnv,
  siteId: string,
  expectedRevision: number,
  changeType: string,
  summary: string,
  transform: (document: ParsedDocument) => void,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  try {
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    const current = await fetchDocument(env.DB, siteId);
    if (!current) return apiError('Create the managed ads.txt working copy first.', 409);
    if (Number(current.revision) !== expectedRevision) {
      return apiError('The ads.txt draft changed in another request. Refresh and try again.', 409);
    }

    const parsed = parseDocument(current.draft_content);
    transform(parsed);
    if (parsed.lines.length > MAX_SOURCE_LINES) throw new SourceRequestError(`Keep the source below ${MAX_SOURCE_LINES.toLocaleString('en-US')} lines.`);
    const nextContent = joinDocument(parsed);
    if (new TextEncoder().encode(nextContent).byteLength > MAX_ADS_TXT_BYTES) {
      throw new SourceRequestError('The managed ads.txt draft is larger than 2 MB.');
    }

    const actor = getActor(request);
    const now = new Date().toISOString();
    const nextRevision = expectedRevision + 1;
    const draftHash = await sha256(nextContent);

    try {
      const results = await env.DB.batch([
        env.DB.prepare(`UPDATE ads_txt_source_documents
          SET draft_content = ?, draft_hash = ?, revision = ?, updated_by = ?, updated_at = ?
          WHERE site_id = ? AND revision = ?`)
          .bind(nextContent, draftHash, nextRevision, actor, now, siteId, expectedRevision),
        versionStatement(env.DB, siteId, nextRevision, changeType, summary, nextContent, actor, now),
        auditStatement(env.DB, actor, `ads_txt_source.${changeType}`, siteId, {
          revision: nextRevision,
          summary,
        }, now),
      ]);
      if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
        return apiError('The ads.txt draft changed in another request. Refresh and try again.', 409);
      }
    } catch (error) {
      if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(errorText(error))) {
        return apiError('The ads.txt draft changed in another request. Refresh and try again.', 409);
      }
      throw error;
    }

    const updated = await fetchDocument(env.DB, siteId);
    return json(await sourcePayload(env.DB, site, updated));
  } catch (error) {
    const status = error instanceof SourceRequestError ? error.status : 500;
    return apiError('The managed ads.txt draft could not be updated.', status, errorText(error));
  }
}

export async function getAdsTxtSource(env: AdsTxtSourceEnv, siteId: string): Promise<Response> {
  if (!env.DB) return databaseMissing();
  try {
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    return json(await sourcePayload(env.DB, site, await fetchDocument(env.DB, siteId)));
  } catch (error) {
    return apiError('The managed ads.txt source could not be loaded.', 500, errorText(error));
  }
}

export async function syncAdsTxtSource(
  request: Request,
  env: AdsTxtSourceEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  try {
    const site = await fetchSite(env.DB, siteId);
    if (!site) return apiError('Site not found.', 404);
    await ensureSourceTables(env.DB);
    const body = await readJson<{ force?: unknown }>(request);
    const force = body.force === true;
    const current = await fetchDocument(env.DB, siteId);
    if (current && current.base_hash !== current.draft_hash && !force) {
      return apiError('The managed draft contains changes. Confirm replacement before syncing from the live file.', 409);
    }

    const requestedUrl = site.ads_txt_url || `https://${site.domain}/ads.txt`;
    const fetched = await fetchLiveAdsTxt(requestedUrl);
    const parsed = parseDocument(fetched.content);
    const normalizedContent = joinDocument(parsed);
    const contentHash = await sha256(normalizedContent);
    const actor = getActor(request);
    const now = new Date().toISOString();
    const nextRevision = Number(current?.revision ?? 0) + 1;
    const summary = `Synced ${parsed.lines.length.toLocaleString('en-US')} physical line(s) from the live ads.txt file.`;

    await env.DB.batch([
      env.DB.prepare(`INSERT INTO ads_txt_source_documents (
          site_id, source_url, base_content, draft_content, base_hash, draft_hash,
          revision, synced_at, updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(site_id) DO UPDATE SET
          source_url = excluded.source_url,
          base_content = excluded.base_content,
          draft_content = excluded.draft_content,
          base_hash = excluded.base_hash,
          draft_hash = excluded.draft_hash,
          revision = excluded.revision,
          synced_at = excluded.synced_at,
          updated_by = excluded.updated_by,
          updated_at = excluded.updated_at`)
        .bind(
          siteId,
          fetched.finalUrl,
          normalizedContent,
          normalizedContent,
          contentHash,
          contentHash,
          nextRevision,
          now,
          actor,
          current?.created_at ?? now,
          now,
        ),
      versionStatement(env.DB, siteId, nextRevision, 'sync', summary, normalizedContent, actor, now),
      auditStatement(env.DB, actor, 'ads_txt_source.synced', siteId, {
        revision: nextRevision,
        sourceUrl: fetched.finalUrl,
        httpStatus: fetched.httpStatus,
        lineCount: parsed.lines.length,
        replacedDirtyDraft: Boolean(current && current.base_hash !== current.draft_hash),
      }, now),
    ]);

    return json(await sourcePayload(env.DB, site, await fetchDocument(env.DB, siteId)));
  } catch (error) {
    const status = error instanceof SourceRequestError ? error.status : 500;
    return apiError('The live ads.txt file could not be synced into the managed draft.', status, errorText(error));
  }
}

export async function updateAdsTxtSourceLine(
  request: Request,
  env: AdsTxtSourceEnv,
  siteId: string,
  lineIndex: number,
): Promise<Response> {
  try {
    const input = await readJson<SourceMutationInput>(request);
    const revision = revisionValue(input.revision);
    const text = validateSingleLine(input.text);
    return applyDraftMutation(
      request,
      env,
      siteId,
      revision,
      'line_updated',
      `Updated physical line ${lineIndex + 1}.`,
      (document) => {
        if (lineIndex < 0 || lineIndex >= document.lines.length) throw new SourceRequestError('Source line not found.', 404);
        document.lines[lineIndex] = text;
      },
    );
  } catch (error) {
    const status = error instanceof SourceRequestError ? error.status : 422;
    return apiError('The source line could not be updated.', status, errorText(error));
  }
}

export async function deleteAdsTxtSourceLine(
  request: Request,
  env: AdsTxtSourceEnv,
  siteId: string,
  lineIndex: number,
): Promise<Response> {
  try {
    const input = await readJson<SourceMutationInput>(request);
    const revision = revisionValue(input.revision);
    return applyDraftMutation(
      request,
      env,
      siteId,
      revision,
      'line_deleted',
      `Deleted physical line ${lineIndex + 1}.`,
      (document) => {
        if (lineIndex < 0 || lineIndex >= document.lines.length) throw new SourceRequestError('Source line not found.', 404);
        document.lines.splice(lineIndex, 1);
      },
    );
  } catch (error) {
    const status = error instanceof SourceRequestError ? error.status : 422;
    return apiError('The source line could not be deleted.', status, errorText(error));
  }
}

export async function addAdsTxtSourceLine(
  request: Request,
  env: AdsTxtSourceEnv,
  siteId: string,
): Promise<Response> {
  try {
    const input = await readJson<SourceMutationInput>(request);
    const revision = revisionValue(input.revision);
    const text = validateSingleLine(input.text);
    const afterIndexRaw = input.afterIndex === undefined ? null : Number(input.afterIndex);
    if (afterIndexRaw !== null && (!Number.isInteger(afterIndexRaw) || afterIndexRaw < -1)) {
      throw new SourceRequestError('afterIndex must be a valid physical line index.');
    }
    return applyDraftMutation(
      request,
      env,
      siteId,
      revision,
      'line_added',
      afterIndexRaw === null ? 'Added a physical line at the end of the draft.' : `Added a physical line after line ${afterIndexRaw + 1}.`,
      (document) => {
        const insertIndex = afterIndexRaw === null
          ? document.lines.length
          : Math.min(document.lines.length, afterIndexRaw + 1);
        document.lines.splice(insertIndex, 0, text);
      },
    );
  } catch (error) {
    const status = error instanceof SourceRequestError ? error.status : 422;
    return apiError('The source line could not be added.', status, errorText(error));
  }
}

export async function resetAdsTxtSourceDraft(
  request: Request,
  env: AdsTxtSourceEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return databaseMissing();
  try {
    const input = await readJson<{ revision?: unknown }>(request);
    const revision = revisionValue(input.revision);
    const current = await fetchDocument(env.DB, siteId);
    if (!current) return apiError('Create the managed ads.txt working copy first.', 409);
    return applyDraftMutation(
      request,
      env,
      siteId,
      revision,
      'draft_reset',
      'Reset the working draft to the most recently synced live version.',
      (document) => {
        const base = parseDocument(current.base_content);
        document.lines = base.lines;
        document.newline = base.newline;
        document.endsWithNewline = base.endsWithNewline;
      },
    );
  } catch (error) {
    const status = error instanceof SourceRequestError ? error.status : 422;
    return apiError('The managed ads.txt draft could not be reset.', status, errorText(error));
  }
}
