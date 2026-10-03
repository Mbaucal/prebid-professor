# MBA-101: strict TypeScript gate

Base: `main` at `3d56708`. Local verification used Node 24.19.0 and the unchanged
checked-in lockfile via `npm ci`. CI continues to use Node 22.

## Baseline

The original `npx tsc --noEmit` reported **63 diagnostics**, while the production
Vite build could still pass. See [the captured diagnostics](baseline-typecheck.txt).
These were not 63 demonstrated runtime failures.

- 25 missing native `.mjs` boundary declarations.
- Browser JSON responses with undeclared shapes.
- Browser and Workers ambient types mixed in one program.
- Empty-array group inference, an unknown reducer accumulator and the nonexistent
  global `D1Value` alias.

## Change

- Add `npm run typecheck` for all browser, Worker and Vite configuration targets.
- Run that command before the build in the existing CI job; use `npm ci` there.
- Separate browser/Worker ambient types without weakening strictness or excluding
  production TypeScript files.
- Describe native module entrypoints and shared runtime data structures with
  concrete types. Keep original JavaScript implementation files unchanged.
- Type affected JSON responses and saved-package state. Reuse shared experiment
  settings rather than assert an untyped module result.
- Correct collection accumulator, CSV grouping and D1 binding parameter types.
- Narrow the Workers library's `TextEncoder` buffer type to the actual
  freshly allocated `ArrayBuffer`; no bytes or persistence behavior change.

## Evidence

- All three typecheck targets pass with **zero diagnostics**.
- The aggregate check also passes with the `.generated` directory absent.
- Deliberately invalid assignments in the app, Worker and Vite scopes each caused
  the respective command to fail with `TS2322`, exit 2. Temporary probes were
  removed before committing.
- The production build passed with the existing large-client-chunk advisory.
- **89 existing regression tests passed** across the nine suites listed in
  [the typechecking guide](../../typechecking.md). The first attempt found two
  suites missing generated TEST workspace modules; after the documented
  `prepare-test-workspace.mjs` step, both suites passed. This was test setup,
  not a suppressed failure.
- TypeScript emission with comments removed is identical to the baseline for
  all **15 modified existing TS/TSX files**, including every edited UI component.
  Labels, components, styling, event behavior and layout are unchanged; no new
  visual acceptance pass is required for these type-only UI edits.
- No dependency/lockfile, frozen runtime source/hash, saved package, database
  schema, published channel or production setting was changed.

## Limits

This is local evidence, not hosted TEST or production verification. The new CI
step needs its remote PR run. JavaScript module bodies and runtime JSON payloads
remain covered by their existing validators/tests; a declaration file alone is
not proof of their behavior. GitHub branch protection was not changed.
