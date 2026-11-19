// The _headers file of a Pages deployment that must never be cached. It has no imports, so a
// Worker can bundle it without pulling in the Node release scripts. It must stay byte-equal to
// PAGES_HEADERS in scripts/pages-release-verification.mjs and to the archive-v1 delivery headers.
export const PAGES_HEADERS='/*\n  Access-Control-Allow-Origin: *\n  X-Content-Type-Options: nosniff\n  Cache-Control: no-store\n  X-Robots-Tag: noindex\n';
