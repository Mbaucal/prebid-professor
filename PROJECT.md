# Tessera — Product and Project Source of Truth

_Last updated: 2026-07-29_

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

### Still required before production merge

- [ ] A newly missing required entry sends exactly one initial email.
- [ ] Re-evaluating the unchanged missing list before the reminder interval sends no email.
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

## 10. Near-term plan

### Phase A — finish the current Monitoring milestone

1. Complete the remaining acceptance tests.
2. Address any review findings.
3. Update this document with final results.
4. Merge PR `#19` only after explicit approval.
5. Verify the first production daily schedule safely.

### Phase B — recover and prioritize the wider roadmap

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

Continue the Monitoring acceptance checklist with the **initial missing required entry** scenario on the feature preview. Do not run the all-site batch endpoint until the enabled-site set and email recipients have been reviewed.

## 13. Decision log

### 2026-07-29

- Created this durable project source of truth.
- Kept the product name `Tessera` while retaining technical `prebid-professor` identifiers for compatibility.
- Configured daily ads.txt monitoring for `06:00 UTC`.
- Decided that healthy recovery closes incident memory without sending a recovery email.
- Confirmed that healthy manual evaluation is recorded as skipped and sends no email.
- Kept production unchanged while the feature branch acceptance tests continue.
