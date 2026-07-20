# Tessera

Cloudflare-hosted AdOps control plane and release manager for publisher integrations.

> The technical repository, Worker and deployment identifiers remain `prebid-professor` for compatibility.

## Current milestone

- React dashboard shell
- Cloudflare Worker API
- `GET /api/health`
- Publisher overview mock data
- Ready for D1 and R2 bindings in the next step

## Local development

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The dashboard calls `/api/health` through the local Cloudflare Workers runtime.

## Build

```bash
npm run build
```

## Deploy

```bash
npm run deploy
```

Wrangler will ask you to authenticate with Cloudflare if you are not already logged in.

## Planned resources

- D1 database: publisher configs, releases, audit log
- R2 bucket: generated `ads.js`, uploaded `prebid.js`, manifests and exports
- Cloudflare Access: admin dashboard protection

## Safety

Never commit Cloudflare API tokens, account keys, passwords or production secrets. Use Wrangler/GitHub secrets instead.
