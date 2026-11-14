# Type checking

Run `npm ci`, then `npm run typecheck`. The existing CI build job runs this gate
before the production build. A diagnostic in any target fails the job.

| Command | Source | Environment |
| --- | --- | --- |
| `npm run typecheck:app` | `src` and imported shared contracts | Browser DOM and Vite client |
| `npm run typecheck:worker` | `worker` and imported shared contracts | Cloudflare Workers, without browser DOM |
| `npm run typecheck:tooling` | `vite.config.ts` | ES2022 and the imported Vite/plugin module contracts |

The aggregate command is the project gate. Bare `tsc` checks the browser target
only. All three targets retain `strict`, `noEmit`, and the existing
`skipLibCheck` policy. There are no production source exclusions. The tooling
configuration does not assume an uninstalled `@types/node` dependency.

Browser `HTMLElement` and the Workers HTMLRewriter `Element` must not share an
ambient declaration scope. The two fetch implementations also have different
`Request.clone()` and `Response.json()` types. Keep the browser and Worker
configurations separate when adding source files.

Native `.mjs` modules remain native JavaScript. Adjacent `.d.mts` files describe
their TypeScript-facing entrypoints; `worker/runtime/contracts.ts` describes the
saved database snapshot, runtime descriptor and pin. Update these declarations
with their implementations. Declarations do not validate external JSON or
statically check JavaScript function bodies. The existing runtime validation and
regression tests remain necessary.

The affected browser API calls declare their response shapes at the JSON
boundary. These annotations add compile-time checks to consumers; they do not
replace server validation. Shared experiment settings reuse the compiler's
contract, including the required maximum age for cached bidding.

Type checking does not execute runtime generators or need `.generated` files.
The production build and existing runtime tests still need their normal prep:

```sh
npm ci
npm run typecheck
npm run build
node scripts/prepare-test-workspace.mjs
node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test tests/runtime/site-runtime-service.test.mjs tests/runtime/site-package-flow.test.mjs tests/runtime/prebid-preflight-service.test.mjs tests/runtime/builtin-preview.test.mjs tests/runtime/browser-package-download.test.mjs tests/runtime/script-library.test.mjs tests/runtime/ab-editor.test.mjs tests/runtime/organization.test.mjs tests/runtime/size-map-csv-template.test.mjs
```

The CI job failure gate and repository branch protection are separate settings.
This change does not alter GitHub branch protection or deploy an environment.
