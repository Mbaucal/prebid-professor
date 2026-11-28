# Compiled Worker parity boundary

`node --experimental-strip-types tools/verify-compiled-parity.mjs` loads the actual
modern Vite output `dist/prebid_professor/index.js` into tools-owned Miniflare.
It calls the existing authenticated HTTP `builtin-runtime-bundle` route using
local D1 populated from the repository schema and synthetic saved settings. Missing
authentication returns 401; foreign Origin returns 403. All outbound requests are
blocked. No route, compiler, storage implementation, or generated JS is replaced.

The compiler internally chooses a timestamp. The harness captures that exact
value from the response filename and supplies the identical SQL snapshot,
timestamp, runtime pin and takeover configuration to the unchanged root compiler.
All nine extracted files and the complete ZIP match byte for byte. The Node
reference uses UTC, matching workerd's ZIP timestamp environment; no artifact
bytes or clocks in the Worker are patched. This exercises the legacy built-in preview runtime in GAM-only mode with TakeOver.
It does not prove every selected runtime variant, native Prebid, publisher
integration, or paid ad delivery. Static historical package comparisons
are a separate check owned by the isolation verifier.

The receipt records the actual outer Worker hash separately from the frozen
runtime descriptor. Updated App/Worker bundlers may legitimately produce different
outer bundle hashes; those are not interchangeable with runtime source identity.
The receipt's timestamp-dependent ZIP hash changes on a new run, but every run
requires exact same-input equality between the two execution environments.

Observed locally on Node 24.19.0: modern App/Worker build, three strict typechecks,
Wrangler 4.131.0 `deploy --dry-run`, and this HTTP parity check pass. Dedicated
package audit all/omit-dev reports zero; the historical root all-dependency
inventory retains its prior six high package nodes. Node 22 CI and adoption of
new entrypoints are separate gates. This evidence alone does not migrate any
existing hosted build setting or retire historical CI/deploy entrypoints.
