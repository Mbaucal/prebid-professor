# Standard Outstream positions and site display settings

The Formats editor previously rejected every video position when legacy global
TakeOver was enabled. It also treated a position named `Sticky` as sticky even
after bottom Sticky was explicitly disabled. Neither message established that
the selected position was actually Sticky or TakeOver.

`3.16.0-revenue.preview.2` scopes the check to the configured position. Standard
positions can use the existing PubMatic pilot alongside a separate TakeOver.
Actual bottom/top Sticky, TakeOver overlays and the active Interstitial fallback
remain excluded. Errors identify the saved display. This does not add video
support to Sticky, TakeOver or additional bidders.

The version must be explicitly selected in Script setup. An older selected
version receives a specific upgrade message for these cases; saving Formats
does not change the selection. Preview.1 source, its history entry, default
selection and existing package bytes remain unchanged. The compiler and native
rendering functions are reused unchanged; only input validation is corrected.

## Evidence

- 65 local unit and real SQLite HTTP tests: save/reload, unrelated edits,
  generate, save/reopen/download, exact old selection retention, actual Sticky
  rejection and explicit Sticky OFF. Tests use synthetic demand and UTC.
- 30 additional Deals, history and toolchain regressions passed. Historical
  receipt verifies 66 fixed generated outputs and unchanged dependency bytes.
- Isolated TEST toolchain typecheck and production build passed.
- The existing revenue workspace browser test now covers the same legacy
  TakeOver scenario at 1440px and 390px, including actual Sticky rejection,
  retained form values, Standard recovery and save/reload. Local Chromium is
  blocked by the execution environment's socket restriction; CI must run and
  provide its screenshots before TEST integration.

This is local/synthetic evidence. A successful TEST deployment and the user's
authenticated Formats/package flow are separate checks. Live partner delivery
and revenue remain outside this regression test.
