import { apiError, getActor, json } from './http';
import type { ReleaseEnv } from './releases';

type JsonRecord = Record<string, unknown>;

type SchainNode = {
  asi: string;
  sid: string;
  hp: 0 | 1;
  rid?: string;
  name?: string;
  domain?: string;
};

type SchainConfig = {
  configured: boolean;
  enabled: boolean;
  version: string;
  complete: 0 | 1;
  nodes: SchainNode[];
};

type ConsentConfig = {
  mode: 'cmp' | 'contextual-test';
};

type RuntimeIntegrations = {
  schain: SchainConfig;
  consent: ConsentConfig;
};

type ConfigState = {
  config: JsonRecord;
  integrations: RuntimeIntegrations;
  inheritedFromTemplate: boolean;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: string | null | undefined): JsonRecord {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function nullableString(value: unknown): string | undefined {
  const normalized = String(value ?? '').trim();
  return normalized || undefined;
}

function normalizeNode(value: unknown): SchainNode | null {
  if (!isRecord(value)) return null;
  const asi = String(value.asi ?? '').trim().toLowerCase();
  const sid = String(value.sid ?? '').trim();
  if (!asi || !sid) return null;
  const hp: 0 | 1 = Number(value.hp) === 0 ? 0 : 1;
  const node: SchainNode = { asi, sid, hp };
  const rid = nullableString(value.rid);
  const name = nullableString(value.name);
  const domain = nullableString(value.domain)?.toLowerCase();
  if (rid) node.rid = rid;
  if (name) node.name = name;
  if (domain) node.domain = domain;
  return node;
}

function normalizeNodes(value: unknown): SchainNode[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, SchainNode>();
  for (const candidate of value) {
    const node = normalizeNode(candidate);
    if (!node) continue;
    unique.set(`${node.asi}|${node.sid}`, node);
  }
  return Array.from(unique.values());
}

function normalizeSchainObject(value: unknown): Omit<SchainConfig, 'configured'> | null {
  if (!isRecord(value)) return null;
  const version = String(value.version ?? value.ver ?? '1.0').trim();
  const complete: 0 | 1 = Number(value.complete) === 0 ? 0 : 1;
  const nodes = normalizeNodes(value.nodes);
  return {
    enabled: value.enabled !== false,
    version: /^\d+\.\d+$/.test(version) ? version : '1.0',
    complete,
    nodes,
  };
}

async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare('SELECT id FROM publishers WHERE id = ? LIMIT 1')
    .bind(siteId)
    .first<{ id: string }>();
  return Boolean(row);
}

async function readTemplateSchain(env: ReleaseEnv, config: JsonRecord): Promise<Omit<SchainConfig, 'configured'> | null> {
  if (!env.BUILDS) return null;
  const profileId = String(config.generatorProfileId ?? '').trim();
  if (!profileId) return null;

  const manifestObject = await env.BUILDS.get(`generator-profiles/${profileId}/manifest.json`);
  if (!manifestObject) return null;
  const manifest = parseRecord(await manifestObject.text());
  const templateKey = String(manifest.templateKey ?? '').trim();
  if (!templateKey) return null;

  const templateObject = await env.BUILDS.get(templateKey);
  if (!templateObject) return null;
  const template = await templateObject.text();
  const match = template.match(/\b(?:var|let|const)\s+SCHAIN_CONFIG\s*=\s*([\s\S]*?)\s*;\s*(?:\r?\n|$)/);
  if (!match) return null;
  try {
    return normalizeSchainObject(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

function consentFromRuntime(runtime: JsonRecord): ConsentConfig {
  const consent = isRecord(runtime.consent) ? runtime.consent : {};
  return {
    mode: consent.mode === 'contextual-test' ? 'contextual-test' : 'cmp',
  };
}

async function readState(env: ReleaseEnv, siteId: string): Promise<ConfigState> {
  if (!env.DB) throw new Error('D1 is not configured.');
  const row = await env.DB.prepare('SELECT config_json FROM publisher_configs WHERE publisher_id = ? LIMIT 1')
    .bind(siteId)
    .first<{ config_json: string }>();
  if (!row) throw new Error('Publisher config was not found.');

  const config = parseRecord(row.config_json);
  const runtime = isRecord(config.runtimeControls) ? config.runtimeControls : {};
  const savedSchain = isRecord(runtime.schain) ? normalizeSchainObject(runtime.schain) : null;
  const inherited = savedSchain ? null : await readTemplateSchain(env, config);
  const schain = savedSchain ?? inherited ?? {
    enabled: false,
    version: '1.0',
    complete: 1 as const,
    nodes: [],
  };

  return {
    config,
    inheritedFromTemplate: !savedSchain && Boolean(inherited),
    integrations: {
      schain: {
        configured: Boolean(savedSchain),
        ...schain,
      },
      consent: consentFromRuntime(runtime),
    },
  };
}

function validateAsi(value: string): boolean {
  return value.length <= 253
    && /^[a-z0-9.-]+$/i.test(value)
    && !value.includes('..')
    && !value.startsWith('.')
    && !value.endsWith('.');
}

function validateDomain(value: string): boolean {
  return !value || validateAsi(value);
}

function validateInput(body: JsonRecord): RuntimeIntegrations | Response {
  const schainInput = isRecord(body.schain) ? body.schain : {};
  const consentInput = isRecord(body.consent) ? body.consent : {};

  const enabled = schainInput.enabled === true;
  const version = String(schainInput.version ?? '1.0').trim();
  if (!/^\d+\.\d+$/.test(version)) {
    return apiError('SChain version must use a value such as 1.0.', 422);
  }

  const completeNumber = Number(schainInput.complete);
  if (![0, 1].includes(completeNumber)) {
    return apiError('SChain complete must be 0 or 1.', 422);
  }

  if (!Array.isArray(schainInput.nodes)) {
    return apiError('SChain nodes must be an array.', 422);
  }
  if (schainInput.nodes.length > 20) {
    return apiError('SChain supports at most 20 nodes in this dashboard.', 422);
  }

  const nodes: SchainNode[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < schainInput.nodes.length; index += 1) {
    const candidate = schainInput.nodes[index];
    if (!isRecord(candidate)) return apiError(`SChain node ${index + 1} must be an object.`, 422);
    const asi = String(candidate.asi ?? '').trim().toLowerCase();
    const sid = String(candidate.sid ?? '').trim();
    const hp = Number(candidate.hp);
    const rid = String(candidate.rid ?? '').trim();
    const name = String(candidate.name ?? '').trim();
    const domain = String(candidate.domain ?? '').trim().toLowerCase();

    if (!asi || !validateAsi(asi)) {
      return apiError(`SChain node ${index + 1} has an invalid ASI domain.`, 422);
    }
    if (!sid || sid.length > 128) {
      return apiError(`SChain node ${index + 1} must have a SID up to 128 characters.`, 422);
    }
    if (![0, 1].includes(hp)) {
      return apiError(`SChain node ${index + 1} HP must be 0 or 1.`, 422);
    }
    if (domain && !validateDomain(domain)) {
      return apiError(`SChain node ${index + 1} has an invalid domain.`, 422);
    }
    const key = `${asi}|${sid}`;
    if (seen.has(key)) return apiError(`Duplicate SChain node ${asi} / ${sid}.`, 422);
    seen.add(key);

    const node: SchainNode = { asi, sid, hp: hp as 0 | 1 };
    if (rid) node.rid = rid;
    if (name) node.name = name;
    if (domain) node.domain = domain;
    nodes.push(node);
  }

  if (enabled && nodes.length === 0) {
    return apiError('At least one SChain node is required while SChain is enabled.', 422);
  }

  const mode = consentInput.mode === 'contextual-test' ? 'contextual-test' : 'cmp';
  return {
    schain: {
      configured: true,
      enabled,
      version,
      complete: completeNumber as 0 | 1,
      nodes,
    },
    consent: { mode },
  };
}

function responsePayload(state: ConfigState) {
  return {
    ok: true,
    integrations: state.integrations,
    inheritedFromTemplate: state.inheritedFromTemplate,
    consentGuard: {
      contextualTestIsStagingOnly: true,
      contextualTestDisablesDeviceAccess: true,
      contextualTestDisablesUserSync: true,
    },
  };
}

export async function getRuntimeIntegrations(env: ReleaseEnv, siteId: string): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured yet.', 503);
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);
  try {
    return json(responsePayload(await readState(env, siteId)));
  } catch (error) {
    return apiError(
      'Supply-chain and consent settings could not be loaded.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function updateRuntimeIntegrations(
  request: Request,
  env: ReleaseEnv,
  siteId: string,
): Promise<Response> {
  if (!env.DB) return apiError('D1 database binding is not configured yet.', 503);
  if (!(await siteExists(env.DB, siteId))) return apiError('Site not found.', 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('JSON body could not be read.');
  }
  if (!isRecord(body)) return apiError('Supply-chain and consent settings must be a JSON object.', 422);

  const validated = validateInput(body);
  if (validated instanceof Response) return validated;

  let state: ConfigState;
  try {
    state = await readState(env, siteId);
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'Publisher config could not be read.', 422);
  }

  const runtime = isRecord(state.config.runtimeControls) ? state.config.runtimeControls : {};
  const previous = state.integrations;
  runtime.schain = {
    enabled: validated.schain.enabled,
    version: validated.schain.version,
    complete: validated.schain.complete,
    nodes: validated.schain.nodes,
  };
  runtime.consent = validated.consent;
  state.config.runtimeControls = runtime;

  const actor = getActor(request);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE publisher_configs SET config_json = ?, updated_at = ? WHERE publisher_id = ?')
        .bind(JSON.stringify(state.config), now, siteId),
      env.DB.prepare(`INSERT INTO audit_log (
        id, actor, action, publisher_id, entity_type, entity_id, details_json, created_at
      ) VALUES (?, ?, 'runtime_integrations.updated', ?, 'runtime_integrations', ?, ?, ?)`) 
        .bind(
          crypto.randomUUID(),
          actor,
          siteId,
          siteId,
          JSON.stringify({ previous, next: validated }),
          now,
        ),
    ]);
  } catch (error) {
    return apiError(
      'Supply-chain and consent settings could not be saved.',
      500,
      error instanceof Error ? error.message : String(error),
    );
  }

  return json(responsePayload({
    config: state.config,
    integrations: validated,
    inheritedFromTemplate: false,
  }));
}
