# Built-in JS/CSS artifact candidate — MBA-44 / MBA-45 / MBA-48

## What this adds

Generator Profiles now offers **Download candidate ZIP** beside Generate preview. Both use the built-in reference-derived runtime; no operator template upload. Candidate output is still explicitly **not a stored or published Release**.

The ZIP includes ads.js, ads.min.js, sticky.css, min-height.css, config.json, manifest.json, div-export.csv, implementation.html and README.txt. A checked prebid.js is included only for Prebid-enabled sites. GPT-only has no placeholder Prebid file or loader.

Minification uses pinned Terser 5.44.0 with compress and mangle disabled: parser-based comment/whitespace formatting, no regex comment removal, no remote compilation. Syntax errors fail the whole bundle. The readable output honors cleanComments. The same sticky CSS source is injected by ads.js and exported as sticky.css; the stylesheet is optional in the HTML example. The existing full-width centered bar appearance is preserved. Compact/right-aligned/transparent and Flex settings remain MBA-47/MBA-24, not silently implemented here.

Responsive placeholders explicitly reset to zero at empty or fluid-only breakpoints. Selected Sticky and separate TakeOver are excluded from placeholder CSS. Height-based size-map breakpoints and duplicate widths fail rather than emit inconsistent layout.

## Consistency and safety

The authenticated same-origin POST /api/publishers/:id/builtin-runtime-bundle accepts only the reviewed config/runtime hashes, explicit Preview acknowledgement and temporary TakeOver settings. The browser cannot submit template or artifact source. The request body is streamed with a 24 KB cap.

Configuration and selected Prebid metadata come from a SELECT-only snapshot. The exact scoped R2 bytes are checked and reused, never downloaded again from a mutable latest URL. Candidate Prebid size is capped at 8 MB. A second SELECT-only snapshot rejects changes during generation. The manifest pins runtime source, configuration checksum, Prebid bytes and every output file's checksum. Only normalized public runtime settings enter config.json; arbitrary admin/connector fields are excluded.

No D1/R2 writes, stored pins, release record, channel promotion, email, CMS call or publication occurs. Source generation never executes the included Prebid file. The UI discards downloads after navigation or a newer request.

**Opening implementation.html as a served page can request real ads.** It is a publisher integration example, not the offline test page. Keep the approved CMP and use only approved isolated staging. The automated tests instead inject fake ad libraries and block external requests.

## Still not complete

Source/CSS output for the supported candidate is assembled, but production Generate integration, persisted runtime/Prebid pins, environment isolation, real staging delivery, cross-account publication and whole-release rollback remain unfinished. Top sticky, Close portal, contextual-test consent, per-slot lazy and conditional mappings remain explicitly unsupported. Do not label this Stable or merge it as production-ready. The existing production Generate path is unchanged.

## Reproducible tests

1. npm ci --ignore-scripts
2. node scripts/prepare-builtin-runtime.mjs
3. node --experimental-strip-types --test tests/runtime/artifact-candidate.test.mjs tests/runtime/artifact-bundle-service.test.mjs
4. node --experimental-strip-types scripts/verify-artifact-candidate.mjs .generated/artifact-candidate-verification
5. With Python Playwright and /usr/bin/chromium available, run scripts/verify-runtime-browser.py against both readable/ and minified/ subdirectories, then scripts/verify-artifact-layout.py against the parent directory.

The candidate suite covers syntax, hashes, deterministic output, Prebid pin checks, GPT-only behavior, shared CSS, responsive spacing, invalid config, stale snapshots and bounded ZIP requests. Browser checks exercise the actual final readable/minified output with mocked GPT/Prebid and local creatives: TakeOver sizes/close/no-fill/timeout/resize, duplicate script, GPT-only lazy, ID5/floors and mobile bidder overrides. Visibility handling uses a simulated hidden property, not native background-tab scheduling. No real auction or Cloudflare deployment is proven by these checks.

The Artifact candidate tests workflow retains its reports and screenshots. Hosted UI verification remains a separate gate, with a confirmed deployment URL required before asking the operator to test.
