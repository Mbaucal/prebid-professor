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
execution. Loader 1.0.1 has no deadline for a download that never finishes or
raises an error. Measurement and hosted acceptance remain separate work.
