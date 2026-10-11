# MBA-230: MAIN generic Pages toolchain

Candidate base: `41f425c85a572cdab2613f89cc6a288ddc085fe1`. The generic Pages preparation, bound verification evidence, preflight and pinned-action harness carry the reviewed TEST implementation from `4e3307ff40834b378358b9338b5ce8de8bc6b084` onto the actual MAIN checkout. Builtin TEST deploy/reverify workflows and preflight are unchanged.

MAIN has no target-profile marker and uses the historical MAIN receipt. Its existing bootstrap/verifier API does not implement TEST profiles. The new Pages CLI therefore rejects TEST before bootstrap, and the resolver rejects it before invoking tools. The pure source-profile reader still recognizes TEST metadata for inspection/negative tests; this is not TEST execution support. MAIN bootstrap receives no profile flags. CLI passthrough is rejected.

Generic deploy retains the pinned action, original package bytes, target/channel validation, callback/retry/draft protections and action metadata/output contract. It adds Node 22.23.3, exact locked tools, prepared-byte/run/commit binding, and preflight before action execution. Verification/report jobs need no dependency installation. Existing six Pages check suites remain, with the additional preflight suite and action contract harness.

## Local evidence

Executed under `TZ=UTC`, Node **24.19.0**, Linux x64; Node 22.23.3 is the remote CI gate, not a local claim.

- Actual `node scripts/pages-toolchain.mjs bootstrap` with synthetic validated MAIN deployment identity: PASS; real root-production and tools npm ci, marker-absent MAIN selected.
- Seven suites in `.github/workflows/pages-deployment-checks.yml`: **171 passed**. Includes actual installed MAIN preflight resolving Wrangler **4.131.0**, foreign-profile refusal before executor calls, prepared file mutations, proof/run mismatch, original callback and draft barriers, synthetic prepare/public verification.
- `node scripts/verify-pinned-wrangler-action.mjs .generated/pinned-wrangler-action/dist/index.mjs`: PASS, six success/failure scenarios. Retained action commit `9acf94ace14e7dc412b076f2c5c20b8ce93c79cd`, bundle Git blob SHA1 `ccab30acedbf9809f60d5e8de0454a730a2a75ff`. Fake binaries and denied network verify exact argv/cwd, no install, immutable URL outputs and failure outputs. Optional GitHub metadata network publication is not exercised.
- `node scripts/isolated-toolchain.mjs typecheck`: PASS for App, Worker and tooling.
- `node scripts/isolated-toolchain.mjs build`: PASS; **63 historical outputs** verified, 16 historical production packages and exact esbuild 0.28.1 closure preserved.
- Root package/lock, tools package/lock, immutable sources and core bootstrap/verifier are unchanged. Tools lock SHA256 remains `4849ee2954ed15420ef62d0d8da76cfef6c949a5fa48dd552c8e622e664190d6`.

The first clean Pages run passed all 171 tests. A rerun after the separate App build correctly failed the installed preflight because Vite had generated `.wrangler/deploy/config.json`, an implicit Worker deployment redirect. Removing that generated local file restored the clean Pages-job state; the final run passed 171. The refusal is retained: Pages deployment must not inherit App build configuration. The actual Pages workflow never runs App build.

All fetches in package/public verification use synthetic responses. The action bundle was passively downloaded and hash-checked; no Pages publish, workflow dispatch, credentials, external callback or production action occurred. These checks establish local tool/preflight/action compatibility, not a hosted deployment or MAIN promotion.
