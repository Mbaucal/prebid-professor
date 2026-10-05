# Dashboard navigation (MBA-98)

The dashboard keeps its selected site, publisher, global workspace, site tab and
agency filter in the URL. For example:

`/?section=publishers&publisher=example&site=example-news&tab=config&agency=example-agency`

Site and publisher IDs are checked against the loaded hierarchy before any site
editor is mounted. Agency links also require the matching agency membership.
Unknown, deleted, mismatched or ambiguous selections show **Selection
unavailable**, preserve the requested URL and let the operator choose a new
destination or reload the hierarchy. They never silently select the first site.
Changing an agency filter that excludes the current site clears the selection;
the operator chooses a site in that agency explicitly.

An initial URL without dashboard parameters keeps the existing first-publisher,
first-site default and replaces that initial history entry with its canonical
URL. Subsequent site, tab and workspace choices add history entries; choosing the
same destination again does not. Reload, direct links and browser Back/Forward
restore the selection. Other query parameters, fragments and existing entry
paths are preserved. Authentication continues using its existing validated
`next` destination, including the query; there is no router/backend change.
Canonical replacement is tied to the request's original query and current
navigation identity, so a delayed render cannot overwrite a newer browser URL
before its `popstate` callback restores the selection.

Navigation belongs to the document URL, not local/session storage. Publisher
edit/delete keeps its existing reload flow without the old session-storage
override. A pending save, move or delete may refresh the hierarchy after
completion, but may only change selection if the navigation that initiated it
is still current. In-tab form drafts and Config subsections are not URL state.

Verification uses the actual production React build with intercepted synthetic
API responses. `scripts/verify-dashboard-navigation.py` covers desktop and 390 px
reload/deep-link/history, agency selection, invalid/deleted identities,
hierarchy/agency failures and retry, publisher edit/delete reload, delayed save
followed by site selection or Back, delayed delete, a global Open site callback,
keyboard recovery and late initial data. Synthetic writes are intercepted in
memory; no hosted data or ad request is involved. Its screenshots and JSON go to
`.generated/navigation-evidence/`, uploaded by the existing dashboard layout CI.
The history regression deliberately holds the App's `popstate` callback after
real browser Back, then delivers an outstanding organization response. The old
implementation overwrote Config with Settings under that controlled ordering;
the new guard preserves Config and restores it when the callback is released.
History traces record this test-controlled schedule; they do not claim to
capture the original CI scheduler interleaving.

The isolated hosted TEST Worker serves a separate workspace, not this React
dashboard. A TEST branch adaptation and its CI/local dashboard evidence do not
claim that hosted TEST exposes or exercises this dashboard. No new TEST endpoint,
fallback or authorization bypass is included.
