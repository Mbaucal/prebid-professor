# Inventory import update — MBA-87

Create-site and publisher examples use example.com and neutral publisher/network
names. Existing saved site records remain unchanged.

CSV import now lives directly inside Ad units, Size maps and Bidders. Each section
exposes only its relevant import kinds. The old Advanced → CSV import tab is
removed. Successful import reloads that section's list. Returning to the default
template invalidates the previous preview; changing sites remounts the editor.

The generic download contains 11 maps and a matching 36-position inventory:
Billboard_1–7, Leaderboard, P1–8, InFeed_1–6, InText_1–10, Sticky, Branding_Left,
Branding_Right and TakeOver. Maps also include Rectangle and Native. Branding is
disabled below 1366px. Native demonstrates fluid. TakeOver starts as DRAFT; display
behavior for it and Sticky is still selected under Display & loading.
These are editable starting values, not a claim that every size fits every site's
content width. Import maps first, then adjust and import the desired positions.

Validation: `npm run build`, then
`node --experimental-strip-types scripts/verify-inventory-imports.mjs`.
The check exercises the compiled application Worker, actual authentication and
disposable local D1. It verifies read-only preview, all map/position imports,
fluid/empty breakpoints, matching references, repeated updates, and preservation
of other records during a partial import. No hosted data is used.

The existing hosted TEST is a separate workspace rather than the full main App.
These main-panel changes are not exposed there simply by merging TSX files.
Hosted UI acceptance/deployment remains pending; no main promotion is authorized.
The cloud browser cannot open this run's localhost preview (ERR_BLOCKED_BY_CLIENT).
Do not call the build/API verification a completed browser or hosted TEST check.

## InCorner and the duplicate close button

The reference 3.9.1 sticky render handler creates its close control before
classifying the response. It treats a 1×1 response as a valid Prebid creative when
hb_bidder exists. That targeting key is an auction input, not proof of the winning
creative, so a direct InCorner response can be misclassified. Other dimensions
also enter the normal sticky path. showSticky adds the host class, minimum height,
5px bottom padding and body padding, explaining a plausible residual bar.
The current site's actual creative/template and deployed runtime must be inspected
before asserting this is the exact live failure.

Preferred solution for a known direct template: classify the rendered response
using an explicit creativeTemplateId/creativeId allowlist in the site script.
GPT documents these for reservation ads:
https://developers.google.com/publisher-tag/reference#googletag.events.SlotRenderEndedEvent

If IDs cannot reliably distinguish the creative, add a small explicit lifecycle
signal in the GAM creative template and handle it in a new runtime version.
Validate the sending frame/origin/slot and correlate each signal with the current
render so late messages cannot close a later ad.

While InCorner owns presentation, suppress only the Tessera sticky decoration and
its X, reset host/body spacing, and pause the sticky refresh/empty-retry timers.
Preserve the creative container and iframe: hiding/removing the whole slot may
also hide InCorner. Release ownership on close/replacement; restore normal sticky
behavior on a later ordinary banner. Handle late load, no-fill, repeated renders,
mobile/desktop, and SafeFrame explicitly after inspecting the actual template.

Do not implement a global hide-X CSS rule or use 1×1/hb_bidder alone to identify
InCorner. Do not alter immutable existing script packages. No runtime/GAM change
is part of this UI patch; the next input needed is the InCorner template code or
an identifiable live example and its template ID.
