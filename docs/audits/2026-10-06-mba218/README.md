# MBA-218 — bounded main CI adoption candidate

This continues PR137 from `d49377ada3b5de03aef9374292da159a5fa798fd`. It adopts its existing locked MAIN bootstrap in five validation workflows only. No main merge, default command migration, production deployment or publisher action is included. The older opt-in report describes the earlier PR137 state; this document records the new bounded adoption scope.

`ci.yml` now runs one isolated build job instead of duplicating the original and opt-in builds. It retains strict browser/Worker/tooling checks, 63 historical output verification, nine isolation rejection tests, actual compiled HTTP ZIP parity, local Wrangler packaging, dependency audits, experiment diagnostics, minimum-height tests and both existing evidence directories. Artifact candidate, stored draft and built-in preview workflows retain every existing test, browser command, branch trigger and artifact path while installing through the same MAIN bootstrap. All five workflows pin Node 22.23.3. MAIN wrappers on this branch are intentionally profileless; no TEST receipt is used.

## Fresh advisory and tools patch

The fresh audit initially blocked the candidate: active tools had four high package nodes, rooted in sharp 0.35.4; root production had zero. The reviewed primary advisory [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w), updated 6 October 2026, marks sharp below 0.35.5 affected by a librsvg memory vulnerability. The patched prebuilt dependency is sharp 0.35.5 with librsvg 2.63.2. Potential exploitation depends on processing SVG and runtime conditions; this finding is not evidence that the application was compromised.

Miniflare 5.20260910.0-alpha pins sharp 0.35.4; Wrangler 4.131.0 and the Cloudflare Vite plugin reach it transitively. A tools-only exact override selects sharp 0.35.5. The tools lock changes only sharp and its platform/libvips closure (libvips package 1.3.3 → 1.3.4). Sharp requires Node >=20.9.0, compatible with the selected Node 22.23.3. Wrangler, Vite, historical esbuild 0.28.1 and the root compiler dependency closure are unchanged. No `audit fix --force`, root-lock update or vulnerability suppression was used.

Clean bootstrap followed by an actual native load reports sharp 0.35.5, librsvg 2.63.2 and libvips 8.18.7. A benign 2×2 SVG produces a PNG with the expected signature. The core CI job repeats that native check; it is not an exploit probe.

The dependency-report workflow preserves `dependency-audit/all.json`, `production.json`, their stderr files, summary and artifact name. It adds `active-tools.json` and explicit scope labels. Historical full-lock findings remain visible inventory; only active production and active tools are required to have zero findings. Reports are written before that gate. The final fresh audit is historical **7 high / 0 critical**, active root-production **0**, active tools **0**. This is not global repository audit-zero or remediation of historical development dependencies.

## Local validation

[Machine-readable receipt](validation.json) records:

- Clean locked bootstrap, three strict TypeScript targets, App/Worker build, all 63 fixed historical outputs, nine rejection tests and credential-free Wrangler dry-run: PASS.
- Actual compiled Worker HTTP generator: identical nine-file ZIP versus the original root compiler for the same synthetic SQL snapshot and captured timestamp; authentication/origin boundaries and zero external requests: PASS. This is the existing legacy GAM-only + TakeOver case, not every runtime/configuration.
- All 188 source tests selected by the five workflows: PASS. Artifact generation 12 and persistent SQLite/simulated-R2 restart/read-back 12: PASS.
- Candidate readable/minified browser tests 20 each and CSS/layout 4; stored/reopened readable/minified 20 each and CSS/layout 4: PASS. GPT/Prebid and creatives are synthetic, external requests blocked.
- Exact dependency-audit workflow script: PASS after patch, retaining all historical findings. No active advisory exception.

Local Node was 24.19.0; exact Node 22.23.3 CI is a separate gate. Local timezone was Eastern: two existing ZIP tests initially returned 422 because their fixed 1980 UTC date becomes local 1979, below ZIP's range. Running the unchanged commands with `TZ=UTC`, matching CI/workerd, passes all 188. No runtime or test was changed to hide this timezone limitation. The earlier suspicion of overlapping mutation tests was disproved by the serial failure and explicit date check.

The browser runner hardcodes `/usr/bin/chromium`. Full pinned Chromium 1187 could not create its singleton Unix socket under the local managed sandbox. Local verification therefore used the same Playwright 1.55 / Chromium 1187 headless-shell binary through that local-only path; repository browser commands are unchanged. CI retains its full Chromium install. No sandbox escalation or hosted fallback was used.

Root lock SHA stays `7d9787650ad10fcafee21db223ce2bb76b2e9dc6ac6b943404b260e3b7f47280`. Final tools lock is `4849ee2954ed15420ef62d0d8da76cfef6c949a5fa48dd552c8e622e664190d6`. Compiled Worker SHA is identical before/after the sharp patch: `fc460844a6943bff2ebc99a9a3350177fc3eb762c26d2c860abb831608a6a8a0`. All frozen sources, manifest/ZIP hashes, default versions and root scripts remain unchanged. No App/runtime source was edited; no unrelated UI matrix was repeated.

Remaining shared workflows, root/default development commands and real deployment paths remain outside this candidate. Source-only foundation/bridge checks and Python SChain patch verification were not relabeled as npm migrations. The identical tools patch is separately reviewed on TEST; its 66-output receipt is not interchangeable with MAIN's 63-output receipt.
