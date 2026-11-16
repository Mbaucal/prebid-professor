# MBA-420: bounded 3.22.2 TEST port

Base: `feature/isolated-runtime-workspace-v1` at `52d51ff4f6841f9b35f353c65fdde7a054103e60`.

Only the new lazy-auction version and its catalog, package allow-lists and regression checks are carried to TEST. The TEST creative/demand previews, runtime ordering, default, stable recommendation, toolchain profile, Cloudflare bindings, schema and existing release controls are preserved. All 24 previous TEST registry records remain exact and ordered; 3.22.2 is prepended as preview.

All 150 files in the new source closure are byte-identical to the MAIN source commit `16d5023`; the source SHA-256 is `4f3c90621dab520b671cb2def75deedc94f22f2b0eed1ef707c799635ae32f06`. The exact new release record retains that original source commit. As with the previous TEST account port, source provenance therefore depends on the MAIN source branch or its eventual merge retaining that commit. Keep the source branch available until then. No old frozen sources or registry records are rewritten.

Verification uses the explicit TEST toolchain profile. Strict app/worker/tooling checks, build, 25-record provenance and the 64-case full-script lazy Chromium matrix passed locally. The loopback Worker/SQLite/fake-R2 browser verifier passed 30 checks, including 25 history records and 24 selectable builds. Targeted runtime, package and selection checks passed after updating the historical 3.22.1 test to compare its own original history slice when newer previews precede it.

The existing sealed-TEST-Worker generation parity runner retains all its previous cases and now exercises both 3.22.1 and 3.22.2 account packages. Local evidence is stored under `.generated`; no hosted deployment, publisher traffic or production change is implied.
