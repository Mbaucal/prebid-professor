# MBA-229: MAIN local fixture adapter and editor checks

Candidate starts at `41f425c85a572cdab2613f89cc6a288ddc085fe1` on the existing draft PR137. This is a MAIN historical-profile change to local validation, not TEST profile selection, a runtime change, or deployment adoption.

The accepted TEST fixture interface is retained: `scripts/local-miniflare.mjs`, `tools/test-miniflare.mjs`, `TESSERA_TEST_TOOLCHAIN=isolated` (or `--isolated-toolchain`), and the `Miniflare`/`Headers` exports. Unknown modes fail; omission preserves legacy root resolution and never falls back to tools. The tools adapter uses the supported Miniflare 5 V4 options converter and passes `resourcePersistencePath` at the top level. MAIN uses its existing implicit `verifyIsolation(root)` API and exact dedicated lock version, without a TEST marker or receipt fallback. Unlike the original TEST adapter's truthiness check, property presence preserves explicitly invalid persistence values for native validation: `false` is rejected instead of silently becoming default storage. Valid string directories survive D1/R2 restart and remain isolated from other directories.

Only four existing import sites change: compiled A/B, script library and organization verifiers, plus the script-library browser fixture. None is a signed historical source component. Other legacy fixture imports are outside this change. The three existing workflows (`ab-editor`, `agency-hierarchy`, `app-layout`) retain their branches, original test commands and artifact paths. They install with the checked-in isolated bootstrap, run strict typechecks and the guarded build, and pin Node 22.23.3. Job-level mode selection reaches Python fixture subprocesses. Existing filtered workflows additionally watch tools, lock/config and helper inputs.

## Local evidence

Linux x64, Node v24.19.0, `TZ=UTC`; actual Node 22.23.3 and the complete GitHub workflow runs remain remote CI gates.

- Checked-in bootstrap: both locked `npm ci` installations pass; historical compiler closure and esbuild bridge validated.
- Strict App, Worker and tooling typechecks pass. Guarded App/Worker build passes, preserving all 63 MAIN historical output hashes and the signed source/root-lock contract.
- Adapter tests: 3 pass. Actual local D1/R2 write/dispose/recreate, separate storage isolation, bindings, auth/Origin checks, `Headers` export, wrong-mode/no-fallback rejection and explicit invalid persistence rejection. Normal operations make zero outbound attempts; a separate deliberate outbound probe is intercepted by the local guard and returns 503 without external access.
- Existing Node checks: 71 A/B/cache/saved-script/navigation checks plus 12 organization/schema checks pass.
- Existing compiled verifiers: A/B 8, script library 54; organization session/Origin, real D1 create/assign/CAS/audit pass. Existing external-traffic guards remain unchanged.
- Existing React/browser verifiers pass: layout 16 viewport cases, navigation 46 desktop/390 cases, agency CRUD/membership/layout, A/B editor 11 and script library 35 checks. Screenshots and JSON remain in their original `.generated/*-evidence`, `ab-editor-ui` and `script-library-ui` paths.
- Fresh audit: active root production 0, active tools 0; unchanged archived full root lock 7 high / 0 critical. This is not a claim of globally zero findings.

Reproduce with `node scripts/bootstrap-toolchain.mjs`, `node scripts/isolated-toolchain.mjs typecheck`, `node scripts/isolated-toolchain.mjs build`, then the unchanged workflow test commands with `TESSERA_TEST_TOOLCHAIN=isolated` and `TZ=UTC`. Local browser runs used Playwright 1.55.0 from `/tmp/mba212-py/bin/python`, browser assets `/tmp/mba212-browsers`; inherited proxy variables were omitted only from local synthetic child-process environments. Fixture routing and network guards were unchanged. No real ads, workflow dispatch, deployment, hosted test or main merge occurred.

Remaining scope includes other MAIN legacy workflows/fixture imports and default or hosted deployment installation paths. This bounded change does not close parent MBA-52 or assert production adoption.
