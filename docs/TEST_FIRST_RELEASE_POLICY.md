# Tessera: test first, live after approval

Marko confirmed this rule on 12 September 2026: every future feature, fix and upgrade is developed on a branch and verified in the isolated test environment before an explicitly approved live release.

- Test Worker: prebid-professor-test, with its separate D1 and R2. The 12 September metadata audit 34687700331 confirmed resource separation for bootstrap version dc6eaee4-03e0-4cff-b545-6196f67af9fc. This is version-specific evidence, not blanket approval of future code.
- Keep exact source/runtime/config/Prebid and package identities in the test result and release. Passing CI is not a hosted test or approval to publish.
- No main merge solely to expose an unfinished feature for testing. No production secret/data copy. Never widen the metadata audit token to perform writes.
- Marko approves promotion after meaningful tests. Retain the previous complete compatible release for rollback.
- Record what was implemented, what was actually tested, the tested version and remaining limits in Linear. Do not claim a feature was deployed because its code or tests exist.

MBA-19 covers isolation, MBA-44 the built-in generator, MBA-53 the first authenticated test Generate/Save workspace. The current inert bootstrap remains the deployed test version until an explicit later activation.
