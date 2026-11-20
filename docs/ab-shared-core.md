# Generic A/B shared core (MBA-416)

The generic loader, bundle composer, R2 store and API come from PR203 commit
`709b8df70507ecfd436eb68f4de58999567fd620`. The loader sources and append-only
registry retain their original bytes. No runtime, saved package or generator is
changed by importing this core.

The API caller supplies an authenticated `{email}` actor, a checked site and
origin, the R2 bucket, and complete packages from that site's `readPackage`.
The composer copies each saved `ads.min.js` to its immutable arm path; it never
rebuilds an arm. Both arms must share the same Prebid bytes, GAM path, layout and
consent settings. MAIN integration uses saved `builtin-release-*` packages.

Saving produces an immutable manual-upload ZIP and record. Live/stopped marks
are operator records and do not publish or stop delivery. Restore the approved
control package at the same public script URL, or use the host's deployment
rollback, to stop delivery. Direct publication is a later integration.

Each site's objects live under `site-experiments/v1/<site>/`. Writes use create
conditions and hash readback; the record is the final commit point. Retries with
the same inputs reuse the same identity. Deleting a test hides it; it keeps its
bytes and TestId reservation. The existing bounded lifetime cap can overshoot
under concurrent creates; it is not an atomic quota.

Historical TEST evidence is local/CI, not hosted acceptance. MBA-416's recorded
P2 note explicitly says Cloudflare delivery and real GPT were not verified.
Current MAIN package tests cover 3.25.1 saved bytes. They do not establish
publisher delivery, paid impressions or revenue. The loader retains its assigned
variant during a control fallback; measurement must distinguish assignment from
execution. Measurement and hosted acceptance remain separate work.

## Loader 1.0.2

New bundles select loader 1.0.2 and include that version and template hash in
their identity. Earlier loader bytes and registry entries remain unchanged.
Explicit internal composition with `loaderVersion: '1.0.1'` preserves historical
identities and golden ZIP checks; existing saved records and ZIPs remain readable.
The public create API always uses the current loader.

Each arm has an eight second loading deadline. Before a runtime starts, a failed
assigned arm gets one attempt at control A. Control failure is terminal in the
diagnostics. Expired elements lose their handlers and are detached. A startup
accessor makes an expired arm's existing native guard return without executing
its runtime, even if its response arrives after removal. The composer verifies
that both saved programs contain the supported immediate native guard. When the
page refuses the accessor, the loader chooses unlabelled A before inserting B.

Measured arms wait for the GPT queue to install exclusive Variant/TestId handling.
An eight second queue wait degrades to unlabelled A. Existing publisher reserved
keys exclude the page from the test; keyword maps are copied without reserved
keys, preserving the original objects and unrelated values. Existing publisher
GAM service values and later publisher updates are preserved when this loader
never assigned labels. After an assignment, later reserved writes through GPT's
service or modern `googletag.setConfig({targeting: ...})` exclude measurement, suppress the reserved write
and remove only values still matching this loader's own labels. Other targeting
calls retain their receiver, arguments, return value and error behavior.
Unpatchable GPT chooses unlabelled A. Forced QA and missing randomness remain
unlabelled. CMP authority is unchanged.

Immediately before a native refresh, the loader also verifies its page-label
ownership and checks the selected slots for reserved overrides. Missing/null
slot selection checks `getSlots()`. Initial `display` checks registered slots as
well, covering compatible runtimes that can request ads at that boundary.
Foreign slot values exclude measurement and remain publisher-owned; only matching
Tessera page values are removed. Both dispatch calls forward native arguments,
receiver, result and errors unchanged.
