# MAIN locked-toolchain adoption candidate

This document describes the PR137 MAIN candidate, not active hosted settings. MAIN activation, publication and remote D1 changes have not been authorized or executed by this implementation round. Live TEST already uses its separately reviewed isolated hosted setup; neither this plan nor the historical MAIN-copy TEST READMEs requests reconfiguration of it.

## Fixed root commands

After the MAIN bootstrap (`node scripts/builtin-toolchain.mjs bootstrap`), the reviewed npm mappings select only dedicated tools. No command accepts arbitrary flags, configurations, profiles or database identifiers.

| npm entry point | Fixed behavior |
| --- | --- |
| `deploy` | Rebuild once, validate source and generated target configuration, then deploy the Vite output. This is a remote mutation when intentionally invoked with suitable authorization. |
| `deploy:dry-run` | Same rebuild/validation, then Wrangler dry-run to `.generated/admin-deploy-dry-run`; no publish. |
| `cf-typegen` | Locked Wrangler types with the explicit original root configuration; writes `worker-configuration.d.ts` locally. |
| `db:migrate:local` | Apply migrations to the existing local `prebid-professor-db` simulation using the explicit root configuration. |
| `db:migrate:remote` | Apply migrations to the configured production D1 identity, only as a separately authorized remote operation. No implicit migration accompanies build or deploy. |

The input configuration remains byte-identical: Worker `prebid-professor`, D1 `prebid-professor-db` / `7ef68f78-0fd8-4937-a774-d2fd1d5353e6`, R2 `prebid-professor-builds`, original cron and assets settings. Deployment cannot use the input config directly: Vite supplies the compiled `index.js`, client assets directory and deployment configuration under `dist/prebid_professor`. The helper checks the entire generated object against the locked-tool build, normalizing only the two absolute checkout paths. Changed or extra bindings, cron, vars, environments and paths fail closed. Updating the reviewed configuration or tool versions requires reviewing this contract again.

Typegen and migration commands deliberately use the input configuration and ignore incidental Vite redirects. Deployment uses the freshly built explicit output configuration. MAIN/TEST profile, original source/lock, installed dependency, argument, dotenv/environment override and output path checks happen before the relevant process. A failed build cannot invoke deployment. The default Wrangler account selection remains unchanged: root configuration has no `account_id`; name/resource checks do **not** independently verify the authenticated account. Before any authorized adoption, confirm that the existing credentials select the original production account. No account was inferred from TEST or newly pinned.

Generated type declarations are local outputs. Wrangler may suggest installing root `@types/node`; the candidate already has locked types in the dedicated tools package. Do not follow that suggestion by altering the historical root dependency lock.

## Pending hosted MAIN handoff

The current MAIN dashboard settings have not been inspected or changed here. A future explicitly authorized handoff must first review the exact commit/CI result, original Worker/account/D1/R2 identity and existing rollback version. Preserve the current resource configuration and credentials; do not replace them with TEST settings.

The candidate command contract for a Linux x64 Workers Build rooted at the repository is:

| Setting | Candidate value, not an applied setting |
| --- | --- |
| Dependency auto-install | `SKIP_DEPENDENCY_INSTALL=1`, so the historical full dev lock is not installed before the explicit bootstrap |
| Node | `NODE_VERSION=22.23.3` |
| Build command | `node scripts/builtin-toolchain.mjs bootstrap && npm run typecheck` |
| Deploy command | `npm run deploy` (includes the single fresh App build) |

This split avoids building twice and retains strict checking before the deployment step. A credential-free local review uses bootstrap, `npm run typecheck` and `npm run deploy:dry-run` instead. There is no dashboard activation, new workflow dispatch, token change or production publication in this proposal. Actual hosted build provenance, selected account and effective deployed bindings must be checked after any separately approved handoff; local dry-run/CI success is not hosted proof.

References checked 7 October 2026: [Cloudflare Vite input/output configuration](https://developers.cloudflare.com/workers/vite-plugin/reference/migrating-from-wrangler-dev/), [Wrangler configuration redirects](https://developers.cloudflare.com/workers/wrangler/configuration/), [Workers Build image overrides](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/). The exact installed Wrangler 4.131.0 implementation resolves an explicit `--config` before redirect discovery; this candidate also exercises the real CLI dry-run.
