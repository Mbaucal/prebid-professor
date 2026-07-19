# Release Diff

The site-level **Releases** tab compares two immutable `config.json` snapshots.

It reports changes in:

- demand mode and GAM path;
- generator profile and Prebid build;
- ad units, bidders and bidder overrides;
- size maps and unit rules;
- sticky, floors and output controls;
- SChain, consent, User ID and user sync;
- compiler behavior and required runtime modules.

The comparison is read-only. It does not mutate either release, D1 configuration or R2 artifacts.
