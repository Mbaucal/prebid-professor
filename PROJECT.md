## 2026-09-22 — Sticky inspection on the Test page (MBA-94)

Owner confirmed Test startup works and requested visible Sticky placement and
real state while inspecting GAM. The test now keeps real Sticky directly under
body with its original runtime CSS, reports computed placement/visibility and
GAM response, and captures real state before a page console button opens.
An optional labelled preview uses archived sticky.css in an isolated shadow
tree and a current size-map size; it never changes the real slot or fakes fill.
It closes before console opening, on resize or when real Sticky becomes visible.
The report includes the snapshot and separately identifies active CSS previews.
Compiled-Worker CI covers desktop/mobile empty/fill/close/scroll/preview and
before/live comparison. Hosted Google console UI remains an owner check.
Existing packages need reopening only. TEST first; main is not authorized here.

## 2026-09-22 — Test page Worker bootstrap correction (MBA-94)

The first hosted test page failed before initialization because Function#toString
lost helpers added during Worker compilation. Build the complete browser client
as a separate bundle and preserve it as text. Regression coverage now checks
both Worker bundling/minification and the actual compiled Worker's HTML in
Chromium. Existing packages/settings and ad scripts are unchanged; TEST first.

## 2026-09-22 — Saved-package Test page (MBA-94)

Sites now have a Test page tab and each saved built-in package has a direct test
link. An authenticated, isolated HTTPS page runs the original archived scripts
after Start and checks DIVs, GPT slots/GAM paths, responsive sizes and request
events. It includes lazy scrolling, Publisher Console and a copied report.
Empty ads are acceptable. No settings, package bytes or channels change.
TEST first; main promotion requires owner acceptance. Automated browser checks
use synthetic GPT; live Google console/demand need owner verification.
Details: `docs/site-test-page.md`.

## 2026-09-22 — Complete size maps and GAM → Site sync (MBA-91)

The supplied 7 maps / 25 breakpoints are the single source for CSV templates,
manual Add 7 default maps and GAM preset size unions. Confirmed GAM inventory
can now populate a selected Tessera site, preserving existing units/maps and
configuration. GAM-only history can be attached after review; failed local saves
can recover without replaying Google creates. TEST first; main candidate awaits
owner acceptance. Details: `docs/gam-site-inventory.md`.

## 2026-09-22 — Agency overview appearance (MBA-90)

The Agency label and name now stack vertically beside a padded logo surface.
The filter has its own label and space; narrow layouts stack it below the
identity. Dashboard and TEST use the same AgencyOverview component so their
reviewed presentation matches. This is a visual follow-up to MBA-65, with no
storage, assignment or runtime changes. TEST review precedes production.

## 2026-09-22 — Bounded dashboard layout (MBA-89)

The dashboard now shares an AppFrame with the authenticated TEST `/layout-preview`.
The viewport stays fixed; site header/tabs, navigation and account keep their own
space. Workspace content and the publisher list scroll independently. Narrow
screens have a collapsible menu; short windows can scroll the header/navigation
in their bounded regions. This changes no runtime, site configuration or storage.
TEST review uses generic examples. Production promotion awaits owner acceptance.

# Tessera — Product and Project Source of Truth

_Last updated: 2026-09-22_

## Current checkpoint — GAM line items (MBA-86)

The owner has now accepted ordinary line-item creation in live GAM and requested an untouched source-script Prebid preset. `feature/prebid-script-defaults` adds **Pokreni i napravi**: advertiser `Prebid`, placement `Prebid placement`, trafficker `marko.baucal@smn.rs`, order prefix `SMN - Programmatic HB - Prebid`, EUR 0.01–20.00/0.01, hb_pb, 20 CPM-named creatives per price, original @latest creative.js tag and all 14 size overrides. Exact read-only discovery pre-fills IDs in the selected connection; no random user/inventory fallback. Advanced edits remain available, and one explicit click runs review then creation with existing recovery semantics. TEST first; main still requires owner approval.

The owner authorized adding both a single ordinary line item and the full Prebid generator to **API integracije → Line itemi**, with existing/new advertiser and order selection, inventory, sizes, key-values and creative copies with size overrides. The ad-unit module (MBA-85) was accepted in real GAM and promoted through PR #73.

MBA-86 was merged to TEST in PR #76. The follow-up on `fix/prebid-price-naming` matches the source-script naming: numbered orders with CPM ranges, `HB €18.03` line items and distinct `HB €18.03, #1`… creatives. The default 2,000-price script now produces five orders, 40,000 creatives and 40,000 associations. It retains read-only review, explicit creation, resumable batches, uncertain-write reconciliation, history and CSV export, and adds a live naming/CPM/key-value preview. The trafficker query uses the supported `status = 'ACTIVE'` filter. Previously saved jobs keep their original shared layout and recovery semantics. Details and acceptance scope: `docs/gam-line-items.md`.

Automated API, full-range, native Worker SOAP and desktop/mobile checks pass using synthetic Google data. Publish to the existing TEST Worker for the owner's live GAM acceptance; promotion of this new module to main requires approval. Existing site/runtime/settings artifacts and D1 records are unchanged.

## Previous checkpoint — API integrations (MBA-85)

The user's confirmed entry point is a separate global **API integracije** tab. Its first module connects Google Ad Manager and creates ad units from editable presets or pasted names. Prebid line items are now covered by MBA-86 above.

Development is based on `feature/isolated-runtime-workspace-v1` and targets the isolated `prebid-professor-test` Worker at `https://prebid-professor-test.mbaucal.workers.dev/api-integrations`. Production promotion still requires the owner's approval. The older environment/milestone sections below are historical context.

Implemented: eight source-script presets (26 positions), custom templates, encrypted service-account connection, parent browsing/creation, read-only review, explicit batch creation and immutable GAM ID/path history. Existing site runtime/configuration records are not rewritten. See `docs/gam-api-integrations.md` for the exact scope, credential setup and remaining live-GAM acceptance check.

Automated API and TEST-boundary tests pass, as do the client/Worker build, preserved-runtime history gate and synthetic desktop/mobile browser flow. No real Google inventory has been created during development.

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
