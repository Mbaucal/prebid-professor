# Tessera agent workflow

Use the current Linear [START HERE](https://linear.app/mbaucal/document/tessera-start-here-aktuelni-pm-rad-57156b7568fa), the assigned issue and the actual branch diff to resume work. `PROJECT.md` preserves product decisions and historical evidence; old status paragraphs are not current blockers. User instructions take precedence.

## Coordination

- The central PM chat owns prioritization, integration and release coordination. For the approved parallel round, delegate bounded implementation and independent review tasks to subagents; two implementation owners and one reviewer are the default, not a requirement for every small task.
- One issue, one owner, one isolated worktree/branch and one reviewable change. Check current PRs before recreating a feature. Do not edit another agent's worktree or share a checked-out branch.
- Agree ownership of shared files (CI, API contracts, runtime registry) before edits. Report dependencies to the PM; do not silently expand scope.
- Return the exact commit, changed behavior, executed checks, evidence limits and remaining work. Do not mark work complete merely because compilation succeeds.

## Product and UX

- Every change needs a concrete user outcome. Preserve the existing English UI, terminology, components, spacing and responsive design. Prefer an existing control and flow over a new panel or technical switch.
- UI or interaction changes require desktop and narrow-screen visual inspection, plus a meaningful check of the changed action and its loading/error/recovery states. Record screenshots or exact findings. Type-only changes do not require a redesign or new screenshots if emitted UI code is unchanged.
- Keep operator choices understandable. Do not expose implementation details unless they help the user decide. Preserve entered values, site context and clear feedback.

## Runtime and data

- Existing frozen runtime sources, release entries, saved ZIP bytes, hashes and configuration snapshots are immutable. New behavior uses a new explicitly selected version. Never rewrite old signatures, remove lockfile inputs or auto-switch sites to make a build pass.
- Preserve CMP authority and Prebid enforcement. Unknown consent scope is not false; a timeout is not permission. Verify actual generated output and late/error paths.
- Use synthetic demand and local/isolated resources for automated checks. Do not generate live paid ad traffic, modify publisher configuration or send notifications as incidental test effects.

## Verification and delivery

- Install the checked-in lockfile with `npm ci`. Run the existing relevant regression suites and production build. When `npm run typecheck` exists on the branch, it must pass without weakening strictness, blanket `any` or excluding production files.
- Preserve important CI coverage. Extend an existing appropriate workflow rather than creating a redundant workflow. Passing CI and enforcing branch protection are separate facts.
- Distinguish local tests, CI, TEST deployment, hosted verification and production verification. Record what was actually observed.
- Development authorization includes branches and reviewable PRs. Follow the existing TEST-first release process; production promotion requires the applicable explicit user authorization. The PM owns integration, not individual workers.
- Never commit secrets, alter production data during preview tests, or repeat already accepted manual tests without a specific unresolved risk.
