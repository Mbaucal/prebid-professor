# Deployment callback URL boundary (MBA-186)

`POST /api/deployments/callback` still requires the existing callback secret.
Before its single D1 UPDATE, the handler now validates every effective URL,
including previously stored values retained by an omitted field. Invalid input
returns 422 without changing status, message, timestamps or links. Validation
makes no network requests and does not prove that a deployment succeeded; the
existing runner/public-byte verifier remains responsible for that evidence.

## Accepted links and authority

- `githubRunUrl`: HTTPS `github.com/<repository>/actions/runs/<positive ID>`.
  The ID must agree with `githubRunId` and the already recorded run. A first
  URL-only report establishes the ID. ID-only and status-only reports remain
  supported. A valid legacy URL with no ID also binds subsequent reports.
- Repository and branch come from the existing
  `external_deployment.dispatched` audit event when available. Historical rows
  without that event (including the short interval before dispatch audit is
  written) use the configured repository and selected target branch. The fallback
  repository remains `Mbaucal/prebid-professor`. No audit/schema migration occurs.
- `deploymentUrl`: the runner's immutable HTTPS origin,
  `<8–32 lowercase hex characters>.<selected project>.pages.dev`. It cannot be a
  different project, a branch alias, a file path or an arbitrary custom domain.
- `aliasUrl`: the selected branch's Pages origin, or the project's root Pages
  origin for a production deployment, or the target's explicitly saved HTTPS
  `publicBaseUrl`. Custom aliases compare exact origin and base path; the one
  optional trailing slash is normalized away. Nested paths, sibling paths and
  host suffix matches are not allowed. A saved base such as
  `https://cdn.example.invalid/assets/wrapper` remains supported.
- Branch aliases follow the [Pages documented transformation](https://developers.cloudflare.com/pages/configuration/preview-deployments/):
  lowercase, with non-alphanumeric characters replaced by hyphens. This supports
  existing branch names such as `Fix/API_v2` → `fix-api-v2`. The provider's
  [28-character limit is described in the Cloudflare SDK discussion](https://github.com/cloudflare/workers-sdk/discussions/13547)
  quoting its maintainer explanation. The callback accepts only the finite
  branch-derived spellings: hyphen replacement, collapsed/trimmed hyphens, and
  each spelling's 28-character prefix, subject to DNS label shape. This preserves
  long and repeated-separator names without allowing arbitrary project aliases.
  The pinned Wrangler consumes the provider's alias rather than generating it;
  Workers preview hash rules are not used here. A label collision after Pages
  normalization/truncation cannot be resolved offline by this callback.
  A truncated label ending in a hyphen is excluded by the DNS shape check; a
  provider-generated random label for an unusable branch cannot be derived
  offline. An otherwise valid provider alias outside the finite set requires
  its exact HTTPS URL as the target's `publicBaseUrl` or explicit reconciliation.
  Not every Pages branch spelling has been empirically verified here; the original
  maintainer forum link was unavailable during review.

All links reject non-HTTPS schemes, userinfo (including an empty userinfo marker),
nondefault ports, query strings/fragments, raw whitespace/control characters,
encoded ASCII controls, encoded authority characters and backslashes. HTTPS's
default port 443 and hostname casing normalize safely. URLs are stored in their
canonical form; no redirect is followed.

## Compatibility and failure behavior

`running`, `success` and `failed` remain valid statuses. Missing, null or empty
optional fields retain earlier values; the runner uses empty strings when no
deployment was confirmed. No URL becomes mandatory for a failure/status-only
report. Invalid retained links block the entire report; a caller may supply an
explicit valid replacement to repair a legacy invalid link, but cannot replace
an established Actions run identity. There is no blanket grandfathering of old
URLs and no deletion of historical records.

The target's project/public base is mutable and is not snapshotted in the current
schema. An old project/custom URL reported or retained after a target change is
rejected against the current target. The audit preserves repo/branch authority
where present; for older rows without it, a repository/branch change can likewise
reject the earlier links. Operators must reconcile those records/configuration;
the callback does not silently broaden its allowlist. This change does not make
the legacy model a full immutable dispatch snapshot.

Legacy HTTP `publicBaseUrl` values remain untouched but confer no callback URL
authority: neither their HTTP link nor an automatically upgraded HTTPS custom
link is accepted. The selected project's valid HTTPS Pages links still work.
Correct the target explicitly if an HTTPS custom alias is needed.

An optimistic UPDATE compares the previously read run identity, URLs and update
timestamp. A racing callback that changed those values causes 409 with retry
guidance; two concurrent first callbacks cannot establish different run IDs.
An existing audit event with missing, mistyped or malformed repo/branch also
returns 503; only an absent event allows the legacy fallback. Callback
authentication, schema, secrets, target data and runner deployment permissions
are unchanged.

## Verification and TEST boundary

`tests/runtime/deployment-callback.test.mjs` calls the actual callback handler
with synthetic requests and real SQLite using the existing production migrations.
It checks persisted values, zero writes on rejection, runner success/failure,
omitted/inconsistent fields, source provenance, custom paths and one concurrent
first-report race. Its fetch stub refuses every network request. The existing
Pages deployment CI runs it alongside package/runner and draft-barrier tests.

The isolated TEST Worker uses a different R2-backed report endpoint, with its own
strict immutable URL checks. This patch does not expose the legacy callback or
production-shaped tables inside that workspace. A TEST branch carry can compile
and test the legacy handler, but the current hosted TEST entrypoint cannot prove
this route's live behavior. Hosted legacy-route validation would need a separately
approved isolated harness; no TEST permission expansion or real A→B deployment
is part of this change. Parent MBA-46 stays open for cross-account acceptance.
