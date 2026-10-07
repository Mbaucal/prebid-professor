# MBA-236: MAIN builtin TEST reverification

Base `33329f934c9ad12925a026fa25d043d808a9fd06`; owner code `ec990cd062621d98efbd8f4d96a6389bdc1253e7`. The verify/report jobs retain their existing TEST-only recipe trigger, permissions, concurrency, original receipt artifact identity/path/90-day retention, build wait and report-only retry. Only their Node pin and install command change: Node 22.23.3 and `node scripts/builtin-toolchain.mjs bootstrap` without additional arguments. This shared Node-only guard rejects TEST markers/receipts and a mismatched MAIN baseline/root lock before invoking the existing no-argument MAIN bootstrap.

## Dependency finding and validation

This path is **not Node-only**. `reverify-builtin-test.mjs` statically imports `worker/test-workspace/deployment-contract.mjs`, which imports `fflate`; its `privateCall` import also reaches that contract through `builtin-test-delivery.mjs`. The dependency is resolved before any CLI mode executes. Removing both installs would therefore break validate and report as well as verification. No import restructuring or helper behavior changes were needed.

The dedicated CLI regression copies the actual eight-file relative source closure and unchanged recipe/evidence into a clean temporary directory. It first reproduces the missing `fflate` import, then resolves only the exact installed root-production `fflate` version from the checked-in root lock. Actual CLI validate and report execute there without dev dependencies. Synthetic responses prove pending-build polling, failed-build refusal before any report, a failed report response, and retry using unchanged receipt bytes. Every report invocation may only read the exact commit check-run URL and POST the original callback; claim, package retrieval, dispatch or redeployment calls fail the test. The timer acceleration is confined to the synthetic preload, not the implementation.

Local Node **24.19.0**, `TZ=UTC`:

- Clean `node scripts/bootstrap-toolchain.mjs`: PASS (checked-in root-production/tools npm ci).
- Original builtin reverification, delivery, publisher-delivery, Pages deployment, callback and stored-draft guards plus the new CLI tests: **140 passed**, zero failures.
- `node scripts/isolated-toolchain.mjs typecheck`: all three strict configurations PASS.
- `node scripts/isolated-toolchain.mjs build`: PASS, **63 historical outputs**, 16 historical production package instances and exact esbuild 0.28.1 preserved.
- `ops/runtime-test/verify-existing.json` remains byte-identical, SHA256 `563f3b399e8921d5ce5ea0ceedf488bdc9d9c4d4f83e172215025291ca710cd0`. Reverification implementation, root/tools locks, frozen sources and runtime/UI defaults are unchanged.

Worker1 adds the new CLI suite to the existing Pages CI; combined review and actual Node 22.23.3 CI are separate gates. Tests use synthetic responses only. No real public reverification, build polling, callback, workflow dispatch, deploy or credentials were used locally. No unrelated browser suite was repeated.

## Remaining default/hosted entry points (read-only inventory)

This inventory describes the MAIN-copy documentation and defaults only, not current Cloudflare dashboard values. Live TEST already has previously accepted isolated hosted settings; this inventory does not propose reconfiguring them. These MAIN-copy commands remain unchanged; identifying them does not authorize execution or imply that current dashboard settings were inspected.

| Source | Remaining command/behavior |
| --- | --- |
| `README.md` local development | `npm install`, then `npm run dev` still selects historical root tooling. |
| Root `package.json` | `dev`, `build`, `preview`, `deploy`, `cf-typegen`, D1 migration and three `typecheck:*` scripts still resolve root CLI tools. `deploy` remains `npm run build && wrangler deploy`; predev/prebuild/test:builtin retain historical preparers. |
| `ops/runtime-test/README.md` documented connected build | From `ops/runtime-test`: `npm --prefix ../.. ci --ignore-scripts && node ../../scripts/check-test-activation.mjs && node ../../scripts/prepare-builtin-runtime.mjs && node ../../scripts/prepare-test-workspace.mjs`. |
| Same documented TEST deploy | `npx --no-install wrangler deploy --config wrangler.active.jsonc`. |
| `ops/test-worker/README.md` documented bootstrap build | From `ops/test-worker`: `npm --prefix ../.. ci && node --test ../../tests/cloudflare/test-worker-bootstrap.test.mjs`. |
| Same documented bootstrap deploy | `npx --no-install wrangler deploy --config wrangler.jsonc`. |

The companion MBA-235 owner handles the remaining three builtin delivery workflow installs in this round. Adoption of root/default and hosted entry points remains a separately reviewed next step with exact configuration/resource preservation; local CI migration does not establish hosted or production adoption. Historical full-lock audit inventory also remains distinct from active isolated-tool audits.
