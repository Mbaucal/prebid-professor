# MBA-237: root npm commands use locked MAIN tools

Base: existing PR137 candidate `5b0cd90c66350800c77cd8c555f9b4da1f00004b`. Root `package.json` is not in the generator's signed sourceFiles or the historical receipt's `sources`; root `package-lock.json` is signed. Receipt entries named package.json inside installed dependency inventories describe those dependencies, not the repository manifest. Only root script values changed: dependency declarations, both locks, frozen source bytes and all 63 historical outputs remain unchanged.

`dev`, `build`, `preview`, `typecheck`, its three component aliases and `test:builtin` now enter a small fixed local dispatcher. The old predev/prebuild hooks are removed so npm cannot run preparation before invalid user arguments are rejected, and valid commands do not prepare twice. Existing preparation, strict tools configs and builtin tests are reused. The dispatcher rejects unknown/extra arguments, checks the existing MAIN source and isolation guards, and never downloads missing tools. Dev/preview accept only an optional numeric `--port`, bind 127.0.0.1, use strict-port behavior and the fixed tools-owned Vite configuration.

Installed Cloudflare Vite plugin source shows named environment selection remains possible despite explicit config, and remote bindings otherwise default on. The dispatcher uses the locked Vite dotenv resolution to reject `CLOUDFLARE_ENV` from process/development/production files before preparation and sets `CLOUDFLARE_VITE_FORCE_LOCAL=true` for its Vite commands. The documented supported platform remains Linux x64, Node22.23.3; no Mac support is inferred.

The package owner also applied the PM/worker2-approved script mapping for deploy, deploy:dry-run, cf-typegen and local/remote database migration to worker2's separate administrative dispatcher. Those helper behavior checks and any synthetic deploy planning are worker2's evidence, not an assertion of live operations here. No predeploy hook or redundant build was added.

## Evidence

Local Linux x64 / Node24.19.0 / TZ=UTC:

- Clean checked-in bootstrap with the edited manifest: both locked `npm ci` installs and the historical closure guard pass. No root/tools lock changes.
- Five focused test cases pass, including fixed command/config plans, invalid npm arguments in a dependency-free copy (no preparer/install), missing-install guidance, dependency metadata consistency, and process/dotenv named-environment rejection with forced-local bindings.
- Actual `npm run typecheck` passes strict App/Worker/tooling checks. Actual `npm run build` passes and verifies 63 identical historical outputs, including after the local-environment guard change.
- Actual `npm run test:builtin` passes all 25 existing tests.
- Actual dev and preview attempts resolve the locked tools and fixed configs but cannot complete in this local execution environment: the Cloudflare plugin receives EPERM/ERR_SYSTEM_ERROR for `uv_interface_addresses`. No syscall monkeypatch, tool downgrade or runtime workaround was introduced, and local server success is not claimed.
- `scripts/verify-default-local-servers.mjs` supplies the real CI smoke: sequential actual root npm dev/preview commands on ephemeral loopback ports, a 45-second readiness deadline, bounded local `/login` HTML reads requiring the Tessera page, and whole-child-process-group cleanup. It performs no browser asset requests and reports its probe target, not an unmeasured count of server-originated network calls. The same helper locally exposes the syscall limitation and cleans up. Exact Linux Node22.23.3 CI must pass both server checks before acceptance.

README now directs local setup through the explicit locked bootstrap, documents the fixed command surface and separates a local deployment dry-run from an authorized real deployment. No live deployment, remote migration, hosted configuration change, production test or main merge occurred. Parent MBA-52 remains open until the remaining adoption evidence is complete.
