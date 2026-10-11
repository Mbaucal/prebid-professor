# MBA-235: MAIN source tools, existing builtin TEST delivery

Base: draft PR137 `33329f934c9ad12925a026fa25d043d808a9fd06`. This carry uses the reviewed **MAIN historical source profile** (63 outputs) to validate the existing **TEST-only destination** delivery workflow. It does not authorize main/production delivery, change the required TEST ref/repository/destination, activate a workflow, or publish anything.

The new Node-only `builtin-toolchain.mjs bootstrap` rejects extra arguments, TEST markers/receipts, an unreviewed MAIN baseline or a changed historical root lock before invoking the existing no-argument locked bootstrap. It performs installation only, not deployment. The deploy workflow's three jobs and the separately owned reverify workflow's two jobs use this shared entry point. All jobs need installed production `fflate`: their static import chain reaches `deployment-contract.mjs`, including validate, verify and report. Input validation remains after installation and before claim/secret-bearing operations; no new claim or report service was introduced.

The accepted TEST prepared-delivery preflight is carried with the MAIN source guard and existing MAIN `verifyPagesTools`. Immediately before the retained action it binds the saved claim, input, run ID, commit, original descriptor and ZIP hash, checks the actual TEST/production-branch distinction, and compares the exact public asset inventory, every byte/hash and `_headers`. Mutation tests cover asset/header changes, extra files, symlinks, missing claims, changed run/commit/input/descriptor and production aliases. The existing builtin delivery implementation and callback/status/retry semantics are unchanged.

The pinned Wrangler action remains `9acf94ace14e7dc412b076f2c5c20b8ce93c79cd`, now with tools cwd, npm, Wrangler4.131.0 and `../.generated/builtin-delivery/dist`. Its GitHub metadata token, outputs, failure outcome and job separation remain. The existing exact-action harness validates the same six builtin/generic synthetic scenarios: matching installed version skips installation, fixed cwd/arguments, success URL outputs and failed invocation behavior. Optional GitHub deployment metadata is retained and source-reviewed, not exercised against GitHub in these synthetic tests.

## Evidence and limits

Local Linux x64 / Node24.19.0 / TZ=UTC:

- Clean shared-wrapper bootstrap passes both checked-in locked installations and MAIN isolation verification.
- Prepared-delivery/profile guard tests pass, including real no-install Wrangler resolution before the App build.
- Combined original Pages/delivery/reverify/publisher checks plus new guards: 192 pass. The independent reviewer additionally runs the final serialized 192-test command successfully on combined candidate `5cc6de6`; serialization avoids overlap between tests probing real resolver configuration paths. Original coverage is retained.
- Exact pinned-action harness: six synthetic scenarios pass, no actual Wrangler publish or network.
- Strict App/Worker/tooling typechecks and guarded build pass; all 63 historical outputs remain identical. Root/tools locks, frozen sources, runtime/default selections and `verify-existing.json` are unchanged.
- Local combined verification temporarily used worker2's accepted workflow/test bytes, then restored them; PM owns their final integration. Repeated owner runs after Vite build encountered leftover synthetic configuration probes; no guard was weakened to accept those files. The final reviewer run uses the intended clean before-build ordering and passes.

The existing Pages workflow now serializes this resolver-probing suite (`--test-concurrency=1`) and includes the new helper/test inputs in PR and push path filters without duplicate workflow entries. Node22.23.3 exact-head CI remains the remote gate. No workflow dispatch, actual Pages/Worker/publisher deployment, hosted read/write, credentials test, main merge or unrelated browser repeat was performed. Parent MBA-52 stays open for remaining default/hosted/adoption work.
