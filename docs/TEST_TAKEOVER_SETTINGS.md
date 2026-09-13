# TakeOver site settings on TEST

The existing built-in TakeOver module is configured under **Site and ad positions
→ TakeOver**. Save the site once, then Generate reads that saved choice. The
Generate screen shows ON/OFF and links back to the settings; it has no separate
temporary checkbox.

The editor exposes enablement, the GAM ad unit code, the desktop breakpoint,
desktop and mobile/tablet dimensions, separate auto-close timers and countdown.
Defaults remain those of reference 3.9.1: OFF, `TakeOver`, 1024px, 800×600,
300×250, 10 desktop seconds, 5 mobile seconds, countdown ON. Zero seconds means
manual close only. Disabling the module retains the other values.

TakeOver remains GPT-only, without Prebid or refresh. GAM targeting controls
delivery. The close button is available immediately, the timer pauses in hidden
tabs, and the Interstitial fallback uses the saved site's GAM path. The overlay
ad unit must be separate from regular positions and the Interstitial fallback.
Existing behavior and runtime engine source are unchanged; this exposes and
persists already-supported configuration, not a new engine version.

Settings are stored in `runtimeControls.takeOver` through the existing atomic
site editor write and included in snapshot/review validation. Reads do not
initialize them. Older editor payloads without the field preserve saved values.
An older Generate request cannot override a configured value. Previously reviewed
legacy requests remain reproducible when no saved setting has changed. Saved
ZIPs are never regenerated or modified.

This does not migrate or reset a database, change any saved runtime/Prebid pin,
publish to production or run an ad in the Tessera editor. A new user package with
the returned original Prebid file and an eventual real ad pilot remain separate
checks.
