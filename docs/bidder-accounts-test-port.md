# Bidder accounts TEST port

Base: `feature/isolated-runtime-workspace-v1` at `430724b`. This port applies the reviewed account implementation as bounded feature commits; it does not merge unrelated MAIN history over TEST.

## Preserved TEST behavior

- All 23 historical runtime records and their order are retained exactly. Only 3.22.1 is prepended. Old frozen runtime source files and historical package bytes are unchanged.
- TEST still includes the creative and demand previews. Its previous default and stable recommendation remain unchanged; account behavior requires explicitly selecting a script version with bidder accounts. The account note in Prebid and bidders and the Script setup and Generate messages name the versions that apply bidder accounts together with the site's other saved options; after runtime notices that is 3.22.2 (Preview) without saved bid caching, and no corrected available choice when bid caching is saved. In that case the note says when the selected script applies bidder accounts with the other saved options, and otherwise that versions with a runtime notice in Script setup still apply them. Existing 3.23.0/3.24.0 choices and stored packages are retained; TEST does not import or recommend MAIN-only 3.25.x releases.
- TEST Cloudflare bindings, activation boundary, toolchain locks/receipts and production isolation are unchanged.
- Known old TEST databases require the explicit authenticated upgrade action. The additive `account_json` migration retains existing data; no reset, reseed or automatic upgrade is performed.
- The TEST demand preview continues to require GPID and the Rubicon module. A new mutable planner routes new account identities to base-adapter modules. TEST activation uses the same planner, preventing aliases from being incorrectly rejected after their plan was accepted.
- Existing TEST release delivery and download behavior is retained. The new account parity case goes through actual authenticated save/download routes with local D1/R2 and no outbound traffic.

## Additional verification

The TEST native CI matrix retains the three exact Prebid versions (11.11.0, 11.34.0, 11.45.0), uses the TEST toolchain profile and includes full generated wrappers, contextual signals, GEO rules and PubMatic deal aliases. Desktop and narrow UI checks cover both the administrative account editor and actual isolated TEST editor, including the explicit migration and recovery flows.

Local checks are reported separately from GitHub CI and hosted verification. System Chromium could not launch in this execution environment because its process singleton socket operation was denied; browser assertions and screenshots therefore remain CI evidence, not a local claim.
