# Tessera

Cloudflare-hosted AdOps control plane and release manager for custom publisher integrations.

> The technical repository, Worker, database, bucket, and deployment identifiers remain `prebid-professor` for compatibility.

## Project source of truth

Product scope, architecture, current status, acceptance tests, safety rules, and the working backlog are maintained in [`PROJECT.md`](./PROJECT.md).

Update that document whenever a feature is completed, a product decision changes, or a requirement is recovered from earlier planning.

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
