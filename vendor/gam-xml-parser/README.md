# Isolated XML parser

`parser.mjs` is an unminified, tree-shaken ESM bundle exposing only XMLParser from `fast-xml-parser@5.11.1`. It was built with the repository's esbuild using `bundle:true`, `platform:browser`, `format:esm`, `target:es2022`, `minify:false`, `legalComments:inline`.

Bundled transitive packages and licenses are listed in LICENSES.txt. The `@nodable/entities` package omits its license file from the npm archive; its MIT license is included from the upstream `nodable/val-parsers` repository.

This bundle is used only by the new GAM SOAP adapter. The existing runtime identity includes the entire root package-lock.json, so an unrelated API-only dependency must not rewrite that file or any existing runtime release identity. No root package or lockfile change is needed to build this module.

Rebuild independently when updating this parser, review the dependency licenses and XML-response tests, and preserve the legacy runtime source pins. Do not load code from a CDN at runtime.
