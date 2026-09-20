## 2026-09-20 — Confirmed script deletion and clean import preparation

Added named Yes/No deletion dialogs across saved scripts/tests, old A/B packages, built-in and legacy releases, Prebid history, and legacy generator profiles. Named and older A/B packages can be restored from deleted lists without altering their original bytes or existing tests. Release/Prebid APIs require the exact confirmation ID and retain active-version protections. No hosted records are removed by deployment. User requested cleaning test data and rebuilding the inventory from the actual per-site ads.js/prebid.js files; inventory/cleanup needs authenticated access, and source files are still to be supplied. Preserve existing site settings and live delivery while reconciling.

# Tessera — Product and Project Source of Truth

_Last updated: 2026-07-29_

## Update — 2026-09-20: Named scripts before A/B tests

Marko clarified that cache is a script setting and A/B is optional. The new
**Scripts and A/B tests** panel implements that model on the reviewed Tanjug
baseline: give each script a name, save a standalone version, then choose exact
saved versions A and B in a separately named test. The same version can be reused
in multiple tests or used alone. Standalone delivery has no Variant key; A/B keeps
Variant=A/B. Debug includes script name/version and delivery mode.

Names and settings identify immutable script versions. Changing either creates a
new version; existing tests keep their original references and runtime bytes.
Download filenames use the chosen name and a short version suffix. Earlier A/B
packages remain available without modification. Activation still uses a manual
whole-ZIP Pages upload. Adaptive refresh, other site baselines and current Config
integration remain follow-up work. Details: docs/experiments/named-script-library.md.

## Update — 2026-09-20: Configurable Tanjug A/B packages

**Tanjug → Releases → A/B testing** now connects the editor to authenticated
generation, immutable R2 storage and verified whole-ZIP download. Both variants
have independent fresh-auction/cache modes, cache age limits and standard refresh
intervals; the traffic split is configurable. Reusing the same inputs returns the
same release. Debug reports the configured interval and allocation.

This first editor uses the reviewed Tanjug 19-position baseline and Prebid 11.34.0.
It does not incorporate unrelated Config changes. Activation remains a manual
whole-ZIP upload to the existing Pages project; generating a package changes no
live script. A/A 1.0.2 stays available as a fallback. Other sites, adaptive ready-bid
refresh and direct publication remain follow-up work (MBA-57/59/63/66).

Verification covers schema/storage faults, bundled Worker parity with the offline
compiler, real React generation/download/history and the minified downloaded
package with synthetic GPT/TCF and native Prebid. Existing release bytes remain
unchanged. Agency → Publisher → Site with agency logos is tracked in MBA-65.

## Update — 2026-09-19: A/B and cache diagnostics

PR #64 adds **Debug → Runtime → A/B and bid cache inspect** to the main dashboard.
Copy command, Preview command and Download .js use one self-contained, page-wide
inspector. It reads the selected release/variant/hash, per-slot Variant labels,
duplicate starts, fresh/cache/none selections, rejected offers and fallback counts.
Fresh-only, waiting, unavailable and stopped instrumentation are distinct states.
Targeting decisions are not evidence of rendered ads or earned revenue.

Validation: 14 targeted read-only inspector tests and the production dashboard/Worker
build pass. The main CI runs the inspector tests. This change has no database,
authentication, Worker route, generated publisher script or refresh-setting changes.
The command is available once this dashboard change is deployed; release status is
tracked in MBA-62 and PR #64.

Product status: the Tanjug A/A split and GAM Variant labels were accepted by Marko.
The full `tanjug-cache-1.0.1` package is prepared, but cache revenue improvement is
not established. The main A/B configuration editor, per-variant refresh controls,
new-package generation and additional reporting labels remain development work
(MBA-57/58/63). Bidder parameter forms are recorded in MBA-64. Existing immutable
publisher packages are preserved; editing a future draft must create a new release.

This document is the durable source of truth for the Tessera product. It should be updated whenever a feature is completed, a product decision changes, or a new requirement is recovered from earlier planning.

> The product name is **Tessera**. The repository, Worker, database, bucket, and deployment identifiers may continue to use `prebid-professor` for compatibility.

## 1. Product goal

Tessera is a Cloudflare-hosted AdOps control plane and release manager for creating, configuring, publishing, and monitoring custom publisher ad wrappers.

The product should let an AdOps user manage multiple publisher companies and sites, define each site's advertising configuration, generate versioned runtime artifacts, publish those artifacts safely, and monitor whether the deployed integration remains healthy.

The main product principles are:

- one central dashboard for publisher and site configuration;
- reusable global defaults with site-specific overrides;
- deterministic, versioned wrapper builds;
- safe preview and production release workflows;
- clear audit history and rollback capability;
- monitoring that detects problems without modifying publisher files automatically;
- strict isolation between sites, preview environments, and production.

## 2. Repository and environments

| Purpose | Value |
| --- | --- |
| Repository | `Mbaucal/prebid-professor` |
| Production branch | `main` |
| Current development branch | `feature/monitoring-readonly-v1` |
| Current pull request | `#19` |
| Production Worker | `https://prebid-professor.mbaucal.workers.dev/` |
| Current branch preview | `https://feature-monitoring-readonly-v1-prebid-professor.mbaucal.workers.dev/` |
| Cloudflare Worker name | `prebid-professor` |
| D1 database | `prebid-professor-db` |
| R2 bucket | `prebid-professor-builds` |

### Environment boundary

- Branch previews are used for development and acceptance testing.
- `main` is the production source.
- A feature must not be merged to `main` until its preview checklist is complete.
- A Cron trigger included on a feature branch becomes operational only after that configuration is deployed to the production Worker.
- Production secrets must never be committed to GitHub.

## 3. Architecture

### Frontend

- React dashboard
- TypeScript
- Vite
- Cloudflare-served static assets

### Backend

- Cloudflare Worker API
- Cloudflare Access-backed authenticated administrative actions
- Same-origin protection for state-changing requests
- Scheduled Worker handler for recurring jobs

### Persistence and artifacts

- Cloudflare D1 stores publisher data, site configuration, releases, audit history, Gmail connection data, monitoring settings, monitoring state, and notification history.
- Cloudflare R2 stores generated release artifacts, manifests, uploaded Prebid builds, and current-channel files.

### External integrations

- GitHub is the source repository and Cloudflare deployment source.
- Gmail OAuth is used for ads.txt email notifications with the minimum required identity and send scopes.
- Cloudflare Cron is used for the daily monitoring schedule.
- A future publishing-connector layer will support CMS/API delivery of approved ads.txt versions without coupling Tessera core logic to one CMS vendor.

## 4. Product model

The intended hierarchy is:

```text
Publisher company/account
└── Site/domain
    ├── General configuration
    ├── Ad units
    ├── Size mappings
    ├── Unit rules
    ├── Bidders
    ├── Bidder overrides
    ├── Prebid mode/build configuration
    ├── ads.txt requirements
    ├── Releases and artifacts
    ├── Monitoring settings and state
    └── Audit history
```

Site-specific data must never leak into another site's form, build, email template, recipient list, release, or notification state.

### Ads.txt data model distinction

Tessera must treat these as two separate concepts:

1. **Monitoring requirements** — canonical unique ads.txt records used only to decide whether a required seller entry is present. Inline comments are ignored for canonical matching.
2. **Managed ads.txt source lines** — every physical line of an editable ads.txt working copy, preserving exact text, order, comments, blank lines, headings, and repeated occurrences.

The current `ads_txt_requirements` list is concept 1. It must not be presented as though it were the publisher's editable source file.

The requested source-editor workflow is:

- fetch/import the complete current ads.txt into a managed working copy without requiring a manual full-file upload;
- preserve both physical occurrences when one canonical record appears twice, including variants such as a line with `#Smato` and one without it;
- search returns every matching physical source line as a separate row;
- every source row has its own Edit and Delete action;
- deleting one repeated source row must not delete the canonical monitoring requirement or the other occurrence;
- monitoring continues to deduplicate canonically so repeated source lines do not create duplicate missing alerts;
- source-line changes must be auditable and versioned;
- the UI must clearly state whether a change affects only a Tessera draft/export or is actually published to the site's live `/ads.txt`.

Direct publication requires an explicit delivery mechanism, such as a Tessera-hosted ads.txt route, publisher reverse proxy, CMS/API integration, Git-backed file, or another authenticated publishing channel. Without such an integration, Edit/Delete changes only the managed draft and generated export, not the publisher's live file.

### Future CMS/API publishing connector

The first managed-source release will provide **Preview, Copy and Download**. Direct CMS publication is a future optional capability and must use a generic connector contract rather than CMS-specific logic inside the editor.

Each connector should support:

- `testConnection` — verify credentials and permissions without publishing;
- `fetchCurrent` — read the publisher's currently managed ads.txt source where the CMS supports it;
- `publishVersion` — publish one explicitly approved immutable Tessera version;
- `verifyPublished` — fetch the public `/ads.txt` and verify content or checksum after publication;
- `rollback` — restore a previously approved Tessera version;
- optional cache purge after a successful publish.

The preferred first integration is a **generic authenticated REST/webhook connector**. Tessera sends the complete approved ads.txt body, version ID, checksum, timestamp, and site identifier. A publisher can implement the endpoint in any CMS. A small WordPress reference plugin can be added later, but the core connector must remain CMS-neutral.

Publisher requirements for a direct connector:

- staging and production endpoint URLs;
- an authentication method limited to ads.txt publication;
- permission to read and replace only the ads.txt resource;
- response containing publication status and resulting version/checksum;
- documented cache-purge behavior;
- rollback support or acceptance of a prior full-file version;
- a clear statement of the current ads.txt source of truth so another CMS job does not overwrite Tessera's publication.

Secrets must be stored through Cloudflare secret bindings, never in D1 plaintext, GitHub, logs, or frontend responses. Every test, publish, verification, failure, and rollback must be auditable.

## 5. Current product modules

| Module | Current state |
| --- | --- |
| Publisher companies/accounts | Implemented |
| Multiple sites per publisher | Implemented |
| Site creation, update, move, duplicate, and delete workflows | Implemented |
| Ad units | Implemented |
| Size mappings | Implemented |
| Unit rules | Implemented |
| Bidders and bidder overrides | Implemented |
| CSV/config import workflows | Implemented |
| Prebid mode and build workflows | Implemented |
| Versioned releases | Implemented |
| R2 current-channel artifacts and manifests | Implemented |
| Release deletion and rollback-related controls | Implemented |
| Audit log | Implemented |
| ads.txt requirements, import, copy, edit, delete, and live check | Implemented |
| Saved ads.txt requirement search and repeated-live-entry inspection | Staged on the current feature branch |
| Managed raw ads.txt source editor with per-occurrence Edit/Delete | Product requirement confirmed; not implemented |
| CMS-neutral ads.txt publishing connector framework | Future planned; not part of current PR |
| Read-only runtime and artifact monitoring | Staged on the current feature branch |
| Per-site Gmail templates and test sending | Staged on the current feature branch |
| Per-site ads.txt notification rules | Staged on the current feature branch |
| Daily ads.txt monitoring scheduler | Staged on the current feature branch |
| Custom production domain | Not configured |

## 6. Current milestone — ads.txt monitoring rollout

### Required production behavior

For each site whose notification rules are enabled:

1. Cloudflare Cron runs once per day at `06:00 UTC` using `0 6 * * *`.
2. Tessera fetches the site's configured ads.txt URL.
3. Tessera compares the live file with saved required entries.
4. The check and any corrected attachment use the same fetched ads.txt snapshot.
5. The result is persisted in D1.

### Notification decisions

- **Healthy:** record the check, close any previous incident memory, and do not send an email.
- **First missing state:** send one missing-entry email.
- **Changed missing list:** send a new alert only when changed-list notifications are enabled.
- **Same unresolved list:** suppress duplicates until the configured reminder interval has elapsed.
- **Reminder due:** send a reminder for the unchanged unresolved list.
- **Recovered site:** do not send a recovery email.
- **Fetch error or unsupported status:** record the result and do not treat it as a missing-entry notification unless a separate rule is introduced later.

### Delivery and concurrency rules

- Notifications are sent only through the connected Gmail account.
- The email template and recipients are saved per site.
- A per-site D1 claim prevents concurrent manual and scheduled evaluations from sending duplicate emails.
- Monitoring is read-only with respect to releases, generated artifacts, and R2 objects.

### Available evaluation paths

- Per-site manual action: `Evaluate rules now`
- Authenticated batch test endpoint: `POST /api/monitoring/daily/run`
- Production recurring execution: Cloudflare Worker `scheduled()` handler

## 7. Monitoring acceptance checklist

### Completed

- [x] Healthy ads.txt state is detected as `ok`.
- [x] Healthy evaluation sends no email.
- [x] Healthy evaluation updates `Last checked`.
- [x] Healthy evaluation is written to notification history as a skipped evaluation.
- [x] Existing D1 notification-log constraints remain compatible with new evaluations.
- [x] Recovery-email control is removed from the active UI and decision engine.
- [x] Server-side decision and corrected attachment use one ads.txt snapshot.
- [x] Stale status/template responses are discarded after switching sites.
- [x] Cloudflare branch preview deploys successfully with the current monitoring code.
- [x] A newly missing required entry sends exactly one initial email.
- [x] Re-evaluating the unchanged missing list before the reminder interval sends no email.

### Ads.txt workspace additions to verify

- [x] Search can show every matching repeated live occurrence, including inline-comment variants such as `#Smato`, together with the matching canonical saved requirement.
- [ ] Replace the misleading combined read-only search UX with the confirmed managed-source editor model described above.
- [ ] Search in the managed source editor returns each physical source occurrence separately with Edit/Delete.
- [ ] Editing or deleting a source occurrence never silently changes the canonical monitoring requirement.
- [ ] The UI clearly distinguishes draft/export changes from actual live publication.

### Still required before production merge

- [ ] Re-evaluating after the reminder interval sends one reminder.
- [ ] A changed missing list follows the `notifyOnChange` setting correctly.
- [ ] Returning to a healthy state sends no email and clears the previous incident memory.
- [ ] The same entry missing again after recovery is treated as a new incident.
- [ ] Concurrent manual/scheduled evaluations do not create duplicate Gmail messages.
- [ ] The daily batch runner checks only enabled sites.
- [ ] One site's failure does not prevent other enabled sites from being checked.
- [ ] A full corrected attachment contains no `# Tessera additions` marker.
- [ ] A full corrected attachment does not duplicate an entry because of a second fetch.
- [ ] Publisher navigation, Config, Releases, Ads.txt, Monitoring, Gmail reconnect, and Gmail test delivery still work.

## 8. Release workflow

1. Develop on a feature branch.
2. Let Cloudflare create the branch preview.
3. Verify the build marker through `/api/health`.
4. Complete the feature-specific acceptance checklist.
5. Request and address code review.
6. Confirm D1 migration and legacy-schema compatibility.
7. Merge to `main` only after explicit approval.
8. Verify production health, bindings, authentication, D1, R2, and critical UI flows.
9. Monitor errors and be ready to roll back to the previous known-good Worker version.

## 9. Safety invariants

These rules should not be weakened without an explicit product decision:

- Never commit passwords, OAuth client secrets, encryption keys, Cloudflare API tokens, or GitHub tokens.
- Never modify production from a preview acceptance test.
- Never let Monitoring alter publisher ads.txt, releases, generated artifacts, or R2 files automatically.
- Never send an email merely because a healthy check ran.
- Never reuse another site's recipients, template, state, or configuration.
- Never send duplicate notifications for the same site because two evaluations ran concurrently.
- Never generate a corrected ads.txt attachment from a different fetch than the decision that triggered it.
- Every production-changing administrative action should be authenticated and auditable.
- Generated releases should remain versioned and reproducible.
- Never allow a CMS connector to publish automatically from an unsaved editor state; only an explicitly approved immutable version can be published.
- Never treat a successful CMS/API response as sufficient; verify the public ads.txt after publication.

## 10. Near-term plan

### Phase A — finish the current Monitoring milestone

1. Complete the remaining acceptance tests.
2. Address any review findings.
3. Update this document with final results.
4. Merge PR `#19` only after explicit approval.
5. Verify the first production daily schedule safely.

### Phase B — managed ads.txt source editor

1. Introduce a separate raw source-line model; do not overload `ads_txt_requirements`.
2. Import/sync the live file into an editable, ordered, versioned working copy.
3. Preserve raw comments, headings, blank lines, and repeated occurrences.
4. Add line-level search, Edit, Delete, undo/version history, and full-file preview.
5. Add Download and Copy export as the first publishing mode.
6. Derive canonical monitoring requirements separately from the managed source where appropriate.

### Phase C — CMS/API publishing connectors

1. Add a CMS-neutral publishing-connector interface.
2. Implement a generic authenticated REST/webhook connector first.
3. Add connection testing, approved-version publication, public verification, audit history, and rollback.
4. Store connector credentials only as Cloudflare secrets.
5. Provide publisher integration documentation and a reference WordPress plugin after the generic contract is stable.
6. Keep direct publishing optional per site; Download/Copy must continue to work without a connector.

### Phase D — recover and prioritize the wider roadmap

Requirements remembered from earlier planning or found in the previous long chat should be added below as concrete, testable backlog items. Do not rely on chat history as the only record.

## 11. Backlog to reconstruct and confirm

The following areas are known parts of the broader product direction, but their exact scope and priority must be confirmed before implementation:

- stronger release comparison, rollback, and artifact inspection;
- improved Prebid build/module management;
- reusable bidder/partner schemas and onboarding;
- richer import/export and publisher onboarding workflows;
- additional health checks beyond ads.txt;
- reporting and operational dashboards;
- user roles and permissions beyond the current administrative access model;
- custom production domain and final production hardening;
- automated validation of generated `ads.js`, Prebid, manifest, and integration files.

Add recovered requirements here using this format:

```text
Requirement:
Reason:
Expected user workflow:
Acceptance criteria:
Priority:
Dependencies:
```

## 12. Current next action

Finish the current Monitoring acceptance work and implement the managed ads.txt source editor with Download/Copy output. Keep CMS/API direct publication as the next optional integration phase; it must not block the editor or current Monitoring rollout.

## 13. Decision log

### 2026-07-29

- Created this durable project source of truth.
- Kept the product name `Tessera` while retaining technical `prebid-professor` identifiers for compatibility.
- Configured daily ads.txt monitoring for `06:00 UTC`.
- Decided that healthy recovery closes incident memory without sending a recovery email.
- Confirmed that `ads_txt_requirements` are canonical monitoring expectations, not editable physical source lines.
- Confirmed the need for a separate managed ads.txt source editor that preserves every raw line and repeated occurrence with line-level Edit/Delete.
- Confirmed that the first editor release uses Preview, Copy and Download and does not require publisher CMS access.
- Decided to add a future CMS-neutral publishing-connector framework, starting with a generic authenticated REST/webhook contract and later a reference WordPress plugin.
- Confirmed that direct live changes require an explicit authenticated publishing mechanism; otherwise changes remain a Tessera draft/export.
- Confirmed that healthy manual evaluation is recorded as skipped and sends no email.
- Confirmed that the first missing alert sends exactly once and immediate unchanged re-evaluation is suppressed.
- Kept production unchanged while the feature branch acceptance tests continue.
