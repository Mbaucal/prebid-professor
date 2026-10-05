# Approved 3.9.1 builder archive

These four text parts concatenate to one Base64-encoded Brotli archive of the exact `buildScript(st)` function from Marko's supplied `Pasted text(2).txt`. They are not encrypted credentials and are not an operator-uploaded template.

Original complete attachment SHA-256: `40e1ac4e546f0786fff95e236d9fd5fab36fcdf57ff3ff22ce8198c4751aea57` (236326 bytes). Only its builder function is vendored here, not the SpreadsheetApp/Drive UI.

Builder: 173840 bytes, SHA-256 `2f0e5c93a9c1dc2137fac63e08d0b0f493f74b91c5df4419a8403886d28b91ec`.

`node scripts/prepare-builtin-runtime.mjs` validates the archive, materializes readable `.generated/reference391-original.js`, changes only the build-time clock/export adapter and emits `.generated/reference391.mjs`. Its SHA-256 must equal the previously verified module `80a5e8259a579891043e0d49bb47e18fb4c3b8319cfd73af49a1461c18447639`.

Vite statically imports the generated module into the Worker. There is no network download, Brotli unpacking, eval, new Function, or source upload on a production request. The separate bridge's behavior changes are reviewed/tested in ordinary source files. The manifest hashes the complete generating source closure listed by the preparation script; it is a source-identity pin, not a claim about Vite's output bytes. Generated ads.js also has its own checksum.

This first candidate is Preview only. It does not activate any existing site, create release records, or publish files. Do not change the archive in place for an upgrade; introduce an explicitly versioned candidate.
