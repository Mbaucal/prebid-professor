# Tessera

Cloudflare-hosted AdOps control plane and release manager for custom publisher integrations.

> The technical repository, Worker, database, bucket, and deployment identifiers remain `prebid-professor` for compatibility.

## Project source of truth

Start with the current [Linear PM checkpoint](https://linear.app/mbaucal/document/tessera-start-here-aktuelni-pm-rad-57156b7568fa) for priorities, owners and current evidence. [`AGENTS.md`](./AGENTS.md) defines parallel work, UX review and delivery expectations.

[`PROJECT.md`](./PROJECT.md) preserves product scope, decisions, acceptance criteria and historical implementation notes. Confirm older statuses against the current issue and code before repeating work. Keep the PM checkpoint short; record detailed evidence in the relevant issue or feature document.

## Current platform

- React and TypeScript dashboard
- Cloudflare Worker API
- Cloudflare D1 configuration and operational state
- Cloudflare R2 release artifacts and manifests
- Publisher, site, ad-unit, size-map, bidder, rule, build, release, ads.txt, and audit workflows
- Gmail-connected ads.txt notifications
- Staged read-only Monitoring and daily ads.txt scheduler

## Local development

```bash
node scripts/bootstrap-toolchain.mjs
npm run dev
```

The reviewed isolated toolchain currently supports **Linux x64** with Node 22.23.3. The bootstrap runs the checked-in locks with `npm ci`: historical root production dependencies plus the separate tools installation. Do not substitute a full root `npm install`/`npm ci`; root development dependencies would shadow the isolated installation and the guards reject them. Root dependency declarations and the historical lock remain for artifact reproducibility.

Open the loopback URL printed by Vite. The dashboard calls the Worker API through the local Cloudflare runtime. `npm run dev -- --port 5174` selects a different port; dev and preview bind only `127.0.0.1` and fail if the port is occupied. Other host, config, profile or tool arguments are rejected before preparation. No automatic install occurs when running these commands. Named `CLOUDFLARE_ENV` values from the process or Vite dotenv files are rejected, and Vite remote bindings are forced off for local commands.

`npm run typecheck` checks App, Worker and tooling with the locked strict configs. The individual `typecheck:app`, `typecheck:worker` and `typecheck:tooling` aliases remain available. `npm run test:builtin` prepares and verifies the historical runtime outputs, then runs the existing builtin preview tests.

## Build

```bash
npm run build
npm run preview
```

The build uses the locked tools configuration and verifies all 63 MAIN historical outputs. Preview serves the existing build on loopback port 4173 (or `npm run preview -- --port 4174`). There are no separate `predev`/`prebuild` hooks: each command validates arguments and installation before its own required preparation.

## Deploy

```bash
npm run deploy
```

`npm run deploy:dry-run` rebuilds and validates the exact generated MAIN Worker configuration and client assets, then performs only a local Wrangler dry-run. `npm run deploy` uses that same fresh validated build for the original MAIN target and requires the normal explicit production authorization and Cloudflare authentication. This draft command migration is not evidence of a production deployment.

`npm run cf-typegen` and `npm run db:migrate:local` use fixed locked Wrangler commands. `npm run db:migrate:remote` remains an explicitly remote operation against the original database; it is not part of local setup. Extra arguments and target overrides are rejected.

## Resources

- D1 database: `prebid-professor-db`
- R2 bucket: `prebid-professor-builds`
- Worker: `prebid-professor`

## Safety

Never commit Cloudflare API tokens, OAuth secrets, encryption keys, account credentials, passwords, or production secrets. Use Wrangler, Cloudflare, or GitHub secrets instead.

Do not merge preview work to `main` until the relevant acceptance checklist in [`PROJECT.md`](./PROJECT.md) is complete and production deployment is explicitly approved.
