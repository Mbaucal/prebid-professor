# Tessera creative templates v1 — MBA-88

The global Creative templates section sits next to Prebid builds and API integracije. The shared component also has a TEST route at `/creative-templates`. It offers Image banner, Responsive image, InCorner and Side branding, editable dimensions/position defaults, individual `.json` exports, instructions, and a ZIP containing all four JSON files. A ZIP must be extracted before GAM import.

## GAM import contract

GAM documents JSON export/import at https://support.google.com/admanager/answer/1138308?hl=en. The native UI schema was checked against a real published vendor export: https://developers.jeeng.com/docs/publisher-adserve-native-templates and its https://cdn.jeengapis.com/gam/templates/jeeng-native-2.0.zip attachment (retrieved 2026-09-22). Only structural field names/types were used. Every Tessera creative body is newly authored.

The UI format uses `formatter`, `variableType: ASSET/URL/STRING`, `uniqueName`, `label`, `isRequired`, and template flags. It is different from the SOAP `CreativeTemplate.snippet` representation. Each custom macro occurs once and is URI-encoded in a double-quoted JavaScript string before decoding. The click macro is separately URL-escaped. Asset and destination URLs must use HTTPS. No publisher, GAM network, order, advertiser or line-item identifiers are embedded.

Import through Delivery → Creatives → Creative templates → New creative template → Import → Submit → Save. Then create a creative from the imported template, upload its image and enter the destination URL. Imports do not create campaigns. No paid/vendor template implementation is copied or required.

## Display ownership

InCorner and Branding require explicit selection of runtime `3.11.0-tessera.preview.1` and a newly generated site package. The previous runtime versions and hashes remain bundled, unchanged, and selected until the user changes the exact site pin. The new entry is deliberately not an implicit upgrade.

InCorner targets the existing bottom Sticky unit. Use a normal display creative size already requested by that unit, e.g. 320×50; the overlay dimensions come from the template defaults. No mandatory 1×1 map change and no Out-of-page slot setup. Branding targets its own regular branding unit. Both require friendly iframes (SafeFrame off for these creatives only); standard image templates are SafeFrame-compatible.

A friendly frame registers with `__tesseraCreativesV1.mount`. The wrapper verifies that the frame currently belongs to a configured GPT slot; InCorner must belong to the configured sticky slot, and Branding must not. Only a bounded HTTPS image/click payload is accepted. There is no arbitrary HTML or postMessage receiver. The bridge creates an accessible close button, hides the original host, clears sticky/body reservation and old close controls, and prevents sticky refresh/retry and general per-slot refresh while it owns the display. Image load gates visibility; error/timeout, frame removal, pagehide and a subsequent GPT request release it. Old frame documents cannot reclaim display after refresh. User close disables sticky for the page.

This explicit contract solves the Tessera template case without treating `hb_bidder` request targeting as evidence of the actual winner. Unrelated third-party InCorner creatives do not automatically implement this contract and are not claimed fixed.

## Delivery and measurement gate

Actual GAM import, macro expansion, clicks, delivery, mobile/desktop layouts and SafeFrame behavior still require a test creative in the user's network. The overlay is drawn in the publisher document while the seed iframe is hidden: **GAM Active View may measure the original slot rather than the visible overlay. Do not use these overlay templates for viewability-guaranteed campaigns without a verified measurement integration.** A normal display impression is not proof that the image became visible. OOP/viewed-impression templates require a distinct slot/measurement design and are not silently enabled here. UI labels these as test candidates.

## Inventory on TEST — MBA-87

The existing TEST editor now has inline CSV imports beside Ad units and Size maps. Shared defaults supply 11 maps / 27 breakpoint rows and 36 positions. Preview reuses production's flexible map parser, including fluid and empty breakpoints, and performs no write. “Add to draft” merges listed items while retaining other rows and display/loading settings. The existing review checkbox and revision-checked Save site settings transaction apply the entire draft. DRAFT TakeOver rows are retained without entering the runtime or colliding with the dormant legacy TakeOver. Saving a stale draft remains rejected.

## Verification

- Native JSON field/macro contracts, parser-valid macro expansion including quotes and script-closing text, unsafe URL rejection and missing-bridge behavior.
- Runtime ownership/load/error/close/refresh/removal/resize checks and generation of readable/minified complete candidates.
- TEST auth and route isolation, no-write CSV preview, full generic inventory save/reload, stale-save rejection.
- Existing runtime selection, ad-position compiler, draft transaction and old immutable package tests.
- Build and TEST Worker dry-run before delivery; history checker verifies all historical entries and the exact new source closure.

The public TEST response header `x-tessera-test-feature: creative-templates-v1` identifies deployment of these routes without revealing authentication or configuration. A GitHub push/CI result alone is not deployment or real GAM import evidence. Production promotion is a separate owner-approved step.
