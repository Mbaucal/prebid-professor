# MBA-238 MAIN administrative entrypoints

Base `5b0cd90c66350800c77cd8c555f9b4da1f00004b`; owner code `6ca5fca0a7af2268d4f6189bac640116a2107a73`. Worker1 owns the matching root npm script edits. This owner adds `scripts/admin-toolchain.mjs`, the normalized actual generated-config fixture and focused tests; no lock, runtime, default version, frozen source or Wrangler input bytes change.

Local Node **24.19.0**, `TZ=UTC`, locked root-production/tools bootstrap:

- Five synthetic admin test groups PASS: exact deploy/typegen/local/remote migration argv; argument rejection before preparation; foreign source profile, process/dotenv overrides, wrong dependency/config rejection; modified generated resources/cron/vars/paths/additional bindings; failed build, changed source during build and output symlink refusal. Remote deploy and both migration paths use only an injected recording executor—no remote operation or database migration ran.
- Real `node scripts/admin-toolchain.mjs deploy-dry-run`: PASS. Fresh locked Vite build, **63 identical historical outputs**, exact generated config accepted, Wrangler **4.131.0**, **8 client asset files** read, intended DB/R2/ASSETS declarations, final `--dry-run: exiting now`. No deployment. The original generic production dry-run remains unchanged.
- Real `node scripts/admin-toolchain.mjs types`: PASS with explicit input config despite existing Vite redirect. Generated `worker-configuration.d.ts` was not committed. Wrangler's root `@types/node` suggestion did not trigger installation or lock changes.
- `node scripts/isolated-toolchain.mjs typecheck`: App/Worker/tooling strict configurations PASS. Initial locked build also PASS. Node 22.23.3 combined CI is a separate gate.

Unchanged SHA256: root config `23baa00fd65291177e5719db106a3c5ea6eb83324c312bd4b24c7724767a3df5`; root lock `7d9787650ad10fcafee21db223ce2bb76b2e9dc6ac6b943404b260e3b7f47280`; tools lock `4849ee2954ed15420ef62d0d8da76cfef6c949a5fa48dd552c8e622e664190d6`. Complete generated config canonical hash after normalizing only its two checkout paths: `b1c402c1bc57f679919dfa73d1ad4d93ff81ce0f47e630f9e0e111050549d14d`.

See [pending MAIN adoption plan](../../ops/main-toolchain-adoption.md). Existing account-selection semantics remain; these resource/config checks do not prove the authenticated account. Live TEST's previously accepted hosted settings were not modified. No production credentials, hosted resources, account settings or publisher configuration were read or changed, and no main merge/publish occurred.
