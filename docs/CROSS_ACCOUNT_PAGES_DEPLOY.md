# Cross-account Cloudflare Pages deployments

Prebid Professor does not expose Cloudflare API tokens to the browser and does not store them in D1.

The dashboard records only non-secret destination metadata. A private GitHub Actions workflow downloads an immutable release from the Prebid Professor CDN and runs Wrangler against the selected Cloudflare account and Pages project.

## Secret model

### Worker secrets

Add these to the `prebid-professor` Worker:

- `GITHUB_ACTIONS_TOKEN` — fine-grained GitHub token limited to `Mbaucal/prebid-professor`, with repository Actions read/write permission.
- `DEPLOY_CALLBACK_SECRET` — random shared secret used only for the GitHub Actions status callback.

Optional Worker variables:

- `GITHUB_DEPLOY_REPOSITORY` — defaults to `Mbaucal/prebid-professor`.
- `GITHUB_DEPLOY_REF` — defaults to `main`.

### GitHub repository secrets

Repository path:

`Settings → Secrets and variables → Actions → Repository secrets`

Add:

- `PREBID_PROFESSOR_CALLBACK_SECRET` — exactly the same value as Worker secret `DEPLOY_CALLBACK_SECRET`.
- one Cloudflare token secret for every independently scoped target account, for example:
  - `CLOUDFLARE_API_TOKEN_POLITIKA`
  - `CLOUDFLARE_API_TOKEN_K1INFO`
  - `CLOUDFLARE_API_TOKEN_TANJUG`

The target form field currently named `GitHub Environment` stores the repository secret name, not the token value. Example: `CLOUDFLARE_API_TOKEN_POLITIKA`.

Each Cloudflare token should be scoped to only the required account and should have Cloudflare Pages edit/write access.

Never commit a token, paste it into site configuration, store it in D1, or send it as a workflow input.

## D1 migration

Run once against `prebid-professor-db`:

`migrations/0003_external_deployments.sql`

It creates:

- `deployment_targets`
- `external_deployments`

## Dashboard target example

- Target name: `Politika Pages production`
- Cloudflare Account ID: target account ID
- Pages project name: `politika`
- GitHub Environment: `CLOUDFLARE_API_TOKEN_POLITIKA`
- Production branch: `main`
- Preview branch: `staging`
- Public base URL: optional custom domain

## Deployment flow

1. Generate an immutable release in Prebid Professor.
2. Publish it internally to staging and test it.
3. For an external staging deploy, select the target and release and click `Deploy staging`.
4. For external production, the release must already be the internal production release.
5. The Worker dispatches `.github/workflows/deploy-pages-release.yml`.
6. GitHub Actions downloads the immutable release package.
7. The workflow creates `_headers` with:

   ```text
   /*
     Access-Control-Allow-Origin: *
     X-Content-Type-Options: nosniff
   ```

8. Wrangler deploys the folder to the target Pages project.
9. GitHub Actions calls the signed callback endpoint.
10. The dashboard updates deployment status and displays GitHub and Pages URLs.

## Pages project requirement

The destination Pages project must already exist in the target Cloudflare account. Its configured production branch must match the target's `Production branch` value. A different branch is used for preview/staging deployments.

## Health check

`/api/health` reports:

```json
{
  "externalDeploy": {
    "github": "configured",
    "callback": "configured"
  }
}
```

Both values must be `configured` before the dashboard can dispatch a deployment.
