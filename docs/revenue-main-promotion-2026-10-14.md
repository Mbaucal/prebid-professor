# Revenue preview promotion to MAIN

Marko approved MAIN publication on 14 October 2026 after accepting the generated
TEST package. Further manual TEST repetition is not a prerequisite for this round.
Actual partner-player delivery and revenue remain follow-up verification.

This extends existing PR146 from MAIN `915e2eb` with only the completed revenue
changes from TEST PR148/149/150. It does not merge the entire TEST branch. MAIN's
locked tools, bindings, migrations, existing runtime choices and cache guards are
preserved.

## Available behavior

- Site Deals settings retain string IDs, dates and position scope. Returned native
  bidder deal/adId targeting determines eligibility; the package includes a
  separate GAM setup plan and never writes GAM configuration.
- Formats support Banner, Outstream and Banner + Outstream. PubMatic with checked
  Prebid 11.34.0 is the video pilot; other configured bidders remain banner-only.
- Preview.2 fixes false global TakeOver/Sticky blocking for standard positions.
- Preview.3 derives video dimensions from each size-map row. One eligible size is
  automatic; multiple sizes need a saved choice; empty rows disable the position.
- Existing fixed settings remain fixed until Use size map is explicitly saved.
- Native MAIN Size maps can save a changed draft, show required Formats review,
  and open the appropriate position in the same site. Generation remains blocked
  until missing or stale choices are repaired.
- Both the browser download and native complete-release reader accept the known
  twelve-file revenue package, including deals-plan.json, while retaining identity,
  file/path, byte-size and checksum guards.

New releases include Deals/Outstream guidance in README.txt. Existing stored
release bytes are never rewritten. Preview status and site selections are not
automatically promoted to stable or switched by the admin deployment.

## MAIN operator path

Open the intended publisher/site, then Config → Script → Script setup → Change
version → 3.16.0-revenue.preview.3 → Save script setup. Formats is under Config →
Inventory → Ad units. Deals is under Config → Demand → Bidders.

For existing video settings, open Formats → Use size map → Save format settings.
Generate a new package from the saved settings when ready. Selecting a version or
publishing the admin app does not replace a publisher's existing script.

## Source identity

The previously recorded MAIN/PR146 history is unchanged; preview.2 and preview.3
are prepended as exact TEST records:

| Runtime | Frozen source commit | Source SHA-256 |
| --- | --- | --- |
| 3.16.0-revenue.preview.2 | e62e9da1ff1914f5a173d58bf5162a53068214a9 | 8c664ce5f92d2d3f070b740659b88aebede2b4703615b089cfbf5554098b5e37 |
| 3.16.0-revenue.preview.3 | 5bddbca1fca3c0926c44e24c9a1e3aa965772a60 | c257412bbcfa4e004a4e56dd320b4c043bdfc4b755bde7cdfa32b09ce4a189da |

## Verification and limits

Promotion gates include locked build/typecheck, all eight recorded source
identities, all 63 historical outputs, native consent/Deals/Outstream checks,
and desktop/narrow MAIN map-edit/repair and complete-package download checks.
Exact-head CI results and Cloudflare deployment identity are recorded in PR146
and the Linear START HERE document at delivery.

Synthetic tests intercept demand and vendor bootstrap. Real PubMatic activation,
compatible GAM/PUC creative, player layout/lifecycle and paid delivery are not
established by the generated ZIP or by the admin deployment. Sticky/TakeOver
video, additional video partners and automatic video refresh remain outside this
pilot.
