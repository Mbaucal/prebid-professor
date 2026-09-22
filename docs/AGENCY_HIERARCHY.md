# Agency → Publisher → Site

MBA-65 adds an organizational level above publisher accounts. The global
**Agencies** section creates or edits an agency's name and optional logo, and
assigns existing publishers. A publisher can be moved to another agency or back
to **Without agency**. Existing accounts are not automatically assigned to SMN
or any other agency.

The publisher sidebar groups accounts by agency, shows publisher/site counts,
and searches agency names, publisher names/IDs and site names/domains/IDs.
Agency and publisher groups collapse independently without selecting another
site. The overview includes an agency filter and an Agency / Publisher / Site
breadcrumb. Empty agencies are valid.

## Storage and compatibility

`worker/organization/service.mjs` manages three additive tables defined in
`worker/organization/schema.mjs`: agencies, publisher links and mutation events.
A read against an installation without these tables returns an empty agency
list without writing anything. The first validated mutation initializes the
complete schema atomically. Partial or unexpected organization schemas are
rejected; they are not repaired automatically. Do not run historical seeded
migrations to enable this feature.

Publisher links include the publisher creation timestamp, so deleting and later
reusing a publisher ID does not inherit its previous agency. Assignment does
not update publisher/site identifiers, site configuration, release rows or R2
objects. Existing unassigned publishers remain available. No agency names or
logos are added to public scripts or GAM keys.

The API receives the authenticated actor from the application wrapper. Mutations
require a matching Origin and JSON body. Updates and assignments require an
expected revision; stale writes return 409. The write and audit event commit in
the same D1 batch. If a save response cannot be confirmed, reload before retrying.
Logos are client-resized PNGs (maximum 256 px); the server accepts bounded PNG
data only, not arbitrary URLs or SVG. Initials provide the no-logo fallback.

| Route | Method | Body |
| --- | --- | --- |
| `/api/organization` | GET | Returns agencies and memberships |
| `/api/organization/agencies` | POST | `name`, `logo` (PNG data URL or null) |
| `/api/organization/agencies/:id` | POST | `name`, `logo`, `expectedRevision` |
| `/api/organization/publishers/:id/agency` | POST | `agencyId` (or null), `expectedRevision` |

## TEST and acceptance

PR #81 adds `/agencies` to the isolated TEST Worker; PR #80 is the production
candidate. TEST uses fixed, clearly labeled example publishers/sites with real
persistent agency names, logos and assignments under `/test-api/organization`.
Prepare the existing TEST workspace from Home if its database is still empty.
The strict base schema and identity marker remain unchanged; the exact complete
organization extension is the only additional accepted schema. No production
publisher records are copied into TEST.

Automated coverage includes legacy reads, logo persistence, assignment and
unassignment, stale revisions, ID reuse, atomic audit, invalid input, auth,
Origin checks, strict TEST schema checks and preservation of site/release data.
The compiled production Worker is exercised with local workerd/D1. The real
React dashboard and shared TEST UI are exercised in Chromium at desktop/mobile
sizes for create/edit, upload, move, reload, search, collapse, filter and fixed
scroll regions. All browser test traffic is local and uses synthetic data.

Owner acceptance: create an agency, add a logo, assign and move an example
publisher, open its site through the hierarchy, and reload to confirm saved
changes. Production promotion requires acceptance of this TEST implementation.
Agency-specific permissions, billing and agency deletion are outside this change.
