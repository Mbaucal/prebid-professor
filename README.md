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
npm install
npm run dev
```

Open the local URL printed by Vite. The dashboard calls the Worker API through the local Cloudflare runtime.

## Build

```bash
npm run build
```

## Deploy

```bash
npm run deploy
```

Wrangler will ask you to authenticate with Cloudflare if you are not already logged in.

## Resources

- D1 database: `prebid-professor-db`
- R2 bucket: `prebid-professor-builds`
- Worker: `prebid-professor`

## Safety

Never commit Cloudflare API tokens, OAuth secrets, encryption keys, account credentials, passwords, or production secrets. Use Wrangler, Cloudflare, or GitHub secrets instead.

Do not merge preview work to `main` until the relevant acceptance checklist in [`PROJECT.md`](./PROJECT.md) is complete and production deployment is explicitly approved.
