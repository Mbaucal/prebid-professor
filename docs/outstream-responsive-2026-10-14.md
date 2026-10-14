# Outstream dimensions from size maps

Revenue preview.3 lets a position use different video dimensions at each size-map
breakpoint. The saved size map supplies the dimensions; operators no longer type
the same width and height again in Formats. When a row contains one eligible video
size it is automatic. Multiple eligible sizes require an explicit selection from
that row. Empty rows keep ads disabled. Page-type map variants have their own rows.
Responsive video currently supports minimum-width breakpoints with minimum height
zero, matching the TEST editor. Imported maps with nonzero minimum-height rules
need review; the preview does not silently change the existing banner selector.

For example, the mobile row can use 300x250 and a desktop row 640x360. A desktop
row may also retain 728x90 for banner demand. The existing pilot accepts video
dimensions from 144 through 1920 pixels on each axis; 728x90 and fluid alone do not
define a supported player. This is the pilot's constraint, not a universal rule
for all outstream implementations.

## Operator path from the TEST home page

1. Open **Script version**, select **3.16.0-revenue.preview.3**, check **I approve
   using this Preview version on the test site.**, then **Save runtime selection**.
2. **Back to Generate** → **Generate and releases** → **Formats** →
   **Configure formats for NewPosition** (or the intended position).
3. For a previously saved fixed-size setting, click **Use size map**. A newly
   configured video position uses map dimensions automatically in preview.3.
4. Review **Player sizes from size maps**. Select a video size only for rows with
   several available choices. The existing partner and duration fields remain.
5. Click **Save format settings**, then generate a new package when ready.

**Open size maps** goes to the existing TEST map editor. If adding/removing sizes
leaves an ambiguous or unavailable video choice, the draft map can be saved and
shows a persistent **Review format settings** notice. Generate stays blocked until
the choices are repaired in Formats. The saved releases retain their original
configuration and bytes throughout this edit/review flow.

## Runtime and evidence limits

The active dimensions are resolved when the auction actually starts, including
after consent waits and lazy entry. Banner sizes remain separate. A video bid for
dimensions that no longer match the active map is refused at rendering, including
when the vendor renderer loads late. This guard does not resize an already running
player or promise a replacement ad after a viewport change.

Preview.1/preview.2 sources, existing fixed settings, catalog default, and saved ZIPs
remain unchanged. The new version requires explicit selection. Automatic refresh
remains off for the mixed/video position; this change adds neither video bidders
nor Sticky/TakeOver support.

Automated native verification uses pinned Prebid and PUC with intercepted demand
and a synthetic vendor bootstrap. It can prove requested/bid dimensions and the
renderer handoff, but real vendor player layout and paid delivery still need the
controlled partner pilot. Browser checks exercise the shared UI on 1440/390px and
the actual isolated TEST Worker/SQLite map-edit → review → Generate flow.
