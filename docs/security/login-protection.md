# MBA-173: login protection and verified audit actor

## Behavior

A credential attempt uses the existing `DB` D1 binding. One atomic D1 batch creates
its small auth table/index if absent, prunes expired keys, and consumes the budget.
There are five attempts per source in a 60-second window starting at the first
attempt. Successful attempts count too. A blocked retry does not extend expiry;
there is no email/account lockout or password/session-secret change.

The key is an HMAC of Cloudflare's `CF-Connecting-IP`, using the existing session
secret with a separate purpose prefix. Equivalent IPv6 spellings are normalized.
No raw IP, attempted email or password is stored. Missing/invalid source addresses
share one conservative `unknown-source` bucket; they do not bypass the limit.
`X-Forwarded-For`, `X-Real-IP` and entered email never choose the bucket.

This relies on direct Cloudflare Worker ingress. A same-zone Worker relay is part
of the trusted deployment boundary because Cloudflare permits such Workers to
influence `CF-Connecting-IP`. Do not deploy this Worker behind an untrusted relay
or expose a direct non-Cloudflare origin that accepts caller-set CF headers.
Distributed IP attacks and shared-NAT contention remain limitations of a per-source
limiter; this is not an account-wide lockout or replacement for edge DDoS controls.

D1 failure, invalid/missing result or a three-second database operation deadline
returns 503 with `Retry-After: 30`, never a session. A denied budget returns 429
with the remaining seconds. Existing authenticated sessions remain usable during
a limiter outage. Both forms preserve email, clear password and allow retry.
The main form also preserves its validated internal `next` destination.

The isolated TEST adapter first verifies the existing schema/identity read-only,
with its own three-second deadline, before any limiter write. A truly empty
workspace or the precisely recognized auth extension is allowed. Foreign or
altered schemas are not initialized or repaired. Thus TEST's worst-case two
sequential storage stages can take up to about six seconds.

Audit identity comes from the validated signed session. An internal Symbol on the
Request carries the actor; caller-supplied Access/email headers do not. Shared
copy/clone helpers carry it through legacy adapters and rollback operations.
Scheduled work attaches its explicit server actor. No Access JWT authentication,
RBAC redesign or session revocation system is claimed here.

## TEST activation and rollback

1. Review the exact commit, checks and independent review before TEST promotion.
   Keep `ops/runtime-test/wrangler.active.jsonc`'s existing isolated `DB` and
   separate `TEST_*` credentials. No additional binding, secret or migration is
   required. No production resource IDs, credentials or publishing capability
   should be copied into the TEST Worker.
2. Deploy through the existing TEST pipeline. On the first valid login POST, after
   the read-only identity/schema guard, the limiter atomically bootstraps only
   `auth_login_limits` and `auth_login_limits_expiry`. Existing workspace rows and
   schema fingerprints are untouched. A failed batch cannot partially bootstrap.
3. Hosted verification must explicitly check a real TEST login, a controlled
   five-attempt burst from one source, 429 + Retry-After, recovery after the window,
   and existing workspace access. Do not report local SQLite/workerd evidence as
   proof that hosted D1 or the hosted entrypoint has activated this code.
4. A code-only rollback to the pre-MBA-173 TEST schema guard is **not sufficient**:
   that old guard rejects the new auth extension. Prefer a compatibility rollback
   retaining recognition of this exact extension. If a pre-change code rollback
   is required, first stop the new login writer, then remove only the ephemeral
   TEST auth table (`DROP TABLE IF EXISTS auth_login_limits`; its index drops with
   it), then restore the old TEST Worker. Never delete workspace/audit/site tables.
   Do not run this against production as an incidental test action.

Main's auth table also bootstraps on first login and needs no secret/config change.
The old production entrypoint has no TEST schema guard, so it ignores a retained
auth table after a code rollback. Production promotion remains PM-owned and follows
TEST verification. This file describes setup; it is not deployment evidence.

## Reproducible local verification

Use the lockfile with `npm ci`, then:

```sh
npm run typecheck
npm run build
node scripts/prepare-test-workspace.mjs
TZ=UTC node --experimental-strip-types --experimental-loader ./tests/support/ts-extension-loader.mjs --test tests/runtime/auth-redirect.test.mjs tests/runtime/login-rate-limit.test.mjs tests/runtime/test-login-security.test.mjs tests/runtime/test-workspace.test.mjs tests/runtime/test-workspace-schema-guards.test.mjs
node scripts/verify-auth-boundaries.mjs
node scripts/verify-login-logo.mjs
python -m pip install playwright==1.55.0
python -m playwright install chromium
python scripts/verify-login-recovery.py
python scripts/verify-login-recovery.py --test-workspace
```

The SQLite tests use separate database connections to the same on-disk store for
shared budget evidence. The compiled Worker check uses local workerd/D1 and actual
publisher/site/size-map create and duplicate endpoints, then reads persisted audit
records. It also verifies successful session access during limiter unavailability.
The browser fixture uses the actual compiled login form and handler at 1440px and
390px, keyboard submission, 401/429/503 states, and recovery with preserved internal
redirect. It intercepts only the final post-login destination after the real 303.
The TEST form is also exercised at both widths through the actual isolated
Worker adapter with local SQLite over loopback TLS. The fixture translates only
its loopback request URL/Origin to the isolated TEST boundary, and all browser
traffic stays on loopback; this does not prove hosted CF ingress behavior.
All outbound HTTP is denied. Screenshot evidence is generated under
`.generated/login-recovery-evidence/`.

References consulted 2026-10-01:
- https://developers.cloudflare.com/d1/worker-api/d1-database/
- https://developers.cloudflare.com/d1/worker-api/prepared-statements/
- https://developers.cloudflare.com/fundamentals/reference/http-headers/
- https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
