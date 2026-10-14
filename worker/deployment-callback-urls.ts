type UrlPolicy = {
  repository: string;
  projectName: string;
  branch: string;
  channel: 'staging' | 'production';
  publicBaseUrl: string | null;
};

type StoredLinks = {
  github_run_id: string | null;
  github_run_url: string | null;
  provider_deployment_url: string | null;
  provider_alias_url: string | null;
};

// Do not let WHATWG URL parsing silently remove controls or reinterpret slashes.
function httpsUrl(raw: string, field: string): URL {
  if (!/^https:\/\//i.test(raw) || /[\s\u0000-\u001f\u007f\\]/u.test(raw)
    || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(raw)) {
    throw new Error(`${field} must be a plain HTTPS URL without control characters.`);
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${field} is not a valid URL.`); }
  const authority = raw.slice(raw.indexOf('//') + 2).split(/[/?#]/, 1)[0];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || /[@%]/.test(authority)
    || url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    throw new Error(`${field} must not contain credentials, a non-HTTPS port, query or fragment.`);
  }
  return url;
}

function optionalText(value: unknown, field: string): string | null {
  // The runner uses empty strings when no Pages deployment was confirmed.
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
}

function runId(value: unknown): string | null {
  const raw = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  const id = optionalText(raw, 'githubRunId');
  if (id !== null && !/^[1-9][0-9]*$/.test(id)) throw new Error('githubRunId must be a positive decimal ID.');
  return id;
}

function githubUrl(raw: string, repository: string): { url: string; id: string } {
  const url = httpsUrl(raw, 'githubRunUrl');
  const match = /^\/([^/]+)\/([^/]+)\/actions\/runs\/([1-9][0-9]*)\/?$/.exec(url.pathname);
  if (url.hostname !== 'github.com' || !match || `${match[1]}/${match[2]}`.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('githubRunUrl must identify an Actions run in the dispatched repository.');
  }
  return { url: `https://github.com/${repository}/actions/runs/${match[3]}`, id: match[3] };
}

function immutableUrl(raw: string, project: string): string {
  const url = httpsUrl(raw, 'deploymentUrl');
  const suffix = `.${project}.pages.dev`;
  const hash = url.hostname.endsWith(suffix) ? url.hostname.slice(0, -suffix.length) : '';
  if (url.pathname !== '/' || !/^[a-f0-9]{8,32}$/.test(hash)) {
    throw new Error('deploymentUrl must be an immutable deployment on the selected Pages project.');
  }
  return url.origin;
}

function aliasUrl(raw: string, policy: UrlPolicy): string {
  const url = httpsUrl(raw, 'aliasUrl');
  // Pages docs describe hyphen replacement; the provider also limits long aliases
  // to 28 chars. Accept only these finite branch-derived spellings, not *.project.
  const branch = policy.branch.toLowerCase().replace(/[^a-z0-9]/g, '-');
  const compact = branch.replace(/-+/g, '-').replace(/^-|-$/g, '');
  const aliases = new Set([branch, compact, branch.slice(0, 28), compact.slice(0, 28)]
    .filter(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    .map(label => `${label}.${policy.projectName}.pages.dev`));
  const productionHost = `${policy.projectName}.pages.dev`;
  if (url.pathname === '/' && (aliases.has(url.hostname)
    || (policy.channel === 'production' && url.hostname === productionHost))) return url.origin;
  if (policy.publicBaseUrl) {
    // A configured custom/public base is an exact destination, never a host wildcard.
    // An old HTTP target is not authority to accept HTTP callback links.
    let base: URL | null = null;
    try { base = httpsUrl(policy.publicBaseUrl, 'publicBaseUrl'); } catch { /* No safe custom alias configured. */ }
    const path = (value: URL) => value.pathname.replace(/\/$/, '');
    if (base && url.origin === base.origin && path(url) === path(base)) return `${url.origin}${path(url)}`;
  }
  throw new Error('aliasUrl must match the selected Pages branch, production origin or configured public base URL.');
}

export function validateCallbackLinks(input: Record<string, unknown>, stored: StoredLinks, policy: UrlPolicy) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(policy.repository)
    || !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(policy.projectName)) {
    throw new Error('The stored deployment repository or project is invalid.');
  }
  let previousId = runId(stored.github_run_id);
  if (!previousId && stored.github_run_url) {
    try { previousId = githubUrl(stored.github_run_url, policy.repository).id; }
    catch { /* A valid replacement can repair a legacy invalid URL; omission cannot. */ }
  }
  const id = runId(input.githubRunId) ?? previousId;
  const rawRunUrl = optionalText(input.githubRunUrl, 'githubRunUrl') ?? stored.github_run_url;
  const run = rawRunUrl ? githubUrl(rawRunUrl, policy.repository) : null;
  if ((id && run && id !== run.id) || (previousId && (id !== previousId || (run && run.id !== previousId)))) {
    throw new Error('GitHub run ID and URL must match the deployment’s recorded run.');
  }
  // A first URL-only report establishes its ID; ID-only and status-only reports stay valid.
  const deployment = optionalText(input.deploymentUrl, 'deploymentUrl') ?? stored.provider_deployment_url;
  const alias = optionalText(input.aliasUrl, 'aliasUrl') ?? stored.provider_alias_url;
  return {
    githubRunId: id ?? run?.id ?? null,
    githubRunUrl: run?.url ?? null,
    deploymentUrl: deployment ? immutableUrl(deployment, policy.projectName) : null,
    aliasUrl: alias ? aliasUrl(alias, policy) : null,
  };
}
