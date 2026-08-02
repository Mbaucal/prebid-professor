from pathlib import Path
import re


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if new in source:
        print(f"{label}: already applied")
        return
    if old not in source:
        raise SystemExit(f"{label}: expected source was not found in {path}")
    file_path.write_text(source.replace(old, new, 1), encoding="utf-8")
    print(f"{label}: applied")


def remove_once(path: str, value: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if value not in source:
        print(f"{label}: already absent")
        return
    file_path.write_text(source.replace(value, "", 1), encoding="utf-8")
    print(f"{label}: removed")


def regex_remove_once(path: str, pattern: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    next_source, count = re.subn(pattern, "\n", source, count=1, flags=re.S)
    if count == 0:
        print(f"{label}: already absent or pattern not present")
        return
    file_path.write_text(next_source, encoding="utf-8")
    print(f"{label}: removed")


# Until a publisher CMS/API connector is configured, the product remains a
# checker plus canonical Monitoring requirements. Do not mount a managed live
# source working-copy UI that cannot publish its changes.
remove_once(
    "src/main.tsx",
    "import AdsTxtSourceEditorPortal from './components/AdsTxtSourceEditorPortal';\n",
    "managed source portal import",
)
remove_once(
    "src/main.tsx",
    "    <AdsTxtSourceEditorPortal />\n",
    "managed source portal render",
)

# Keep the canonical requirement search focused on platform data. Live content
# remains visible through Check now and repeated-entry diagnostics.
regex_remove_once(
    "src/components/AdsTxtPanel.tsx",
    r"\n  const liveSearchMatches = useMemo\(\(\) => \{.*?\n  \}, \[check, searchQuery\]\);\n",
    "combined live-search computation",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """            <p>Each card is a different canonical ads.txt record that appears more than once in the live publisher file. Use the button to show every matching live occurrence together with the saved requirement below. Tessera remains read-only.</p>""",
    """            <p>These are repeated records detected in the publisher's live ads.txt. Until an authenticated CMS/API connector is configured, Tessera only checks the live file against canonical Monitoring requirements and does not edit or sync the publisher source.</p>""",
    "repeated-entry explanation",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    """<button className=\"button secondary\" onClick={() => findSavedRequirement(duplicate.entry)} type=\"button\">Show all matches in search</button>""",
    """<button className=\"button secondary\" onClick={() => findSavedRequirement(duplicate.entry)} type=\"button\">Search monitoring requirement</button>""",
    "repeated-entry search action",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    """            <span className=\"panel-kicker\">Ads.txt search</span>
            <h3>
              {searchQuery.trim()
                ? `${liveSearchMatches.length} live match${liveSearchMatches.length === 1 ? '' : 'es'} · ${filteredRequirements.length} saved`
                : `${requirements.length} entr${requirements.length === 1 ? 'y' : 'ies'}`}
            </h3>""",
    """            <span className=\"panel-kicker\">Monitoring requirements</span>
            <h3>
              {searchQuery.trim()
                ? `${filteredRequirements.length} saved requirement match${filteredRequirements.length === 1 ? '' : 'es'}`
                : `${requirements.length} entr${requirements.length === 1 ? 'y' : 'ies'}`}
            </h3>""",
    "requirements search heading",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    """                aria-label=\"Search saved and repeated live ads.txt entries\"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder=\"Search source, domain, seller ID, comment or complete line…\"
                type=\"search\"
                value={searchQuery}""",
    """                aria-label=\"Search canonical monitoring requirements\"
                autoComplete=\"off\"
                onChange={(event) => setSearchQuery(event.target.value)}
                onInput={(event) => setSearchQuery(event.currentTarget.value)}
                onPaste={(event) => {
                  const pasted = event.clipboardData.getData('text');
                  if (!pasted) return;
                  event.preventDefault();
                  setSearchQuery(pasted.replace(/\\r?\\n/g, ' ').trim());
                }}
                placeholder=\"Search source, domain, seller ID or complete requirement…\"
                type=\"search\"
                value={searchQuery}""",
    "paste-safe requirements search",
)

regex_remove_once(
    "src/components/AdsTxtPanel.tsx",
    r"\n            \{searchQuery\.trim\(\) && liveSearchMatches\.length \? \(\n              <div className=\"ads-txt-live-search-panel\">.*?\n            \) : null\}\n",
    "combined read-only live search panel",
)

# Record the corrected product boundary.
replace_once(
    "PROJECT.md",
    "| Managed raw ads.txt source editor with per-occurrence Edit/Delete | Product requirement confirmed; not implemented |",
    "| Managed raw ads.txt source editor with per-occurrence Edit/Delete | Deferred until an authenticated CMS/API publishing connector is configured |",
    "source editor module status",
)
replace_once(
    "PROJECT.md",
    "Confirm the publishing mode for the managed ads.txt source editor: Tessera draft plus Download/Copy export, or direct publication through an authenticated publisher integration. Do not merge the current Ads.txt workspace UX as the final source-management experience.",
    "Finish the Monitoring rollout using live checks against canonical platform requirements. Keep managed-source Sync/Edit/Delete hidden until the site has an authenticated CMS/API publishing connector that can safely publish and verify an approved ads.txt version.",
    "current next action",
)
replace_once(
    "PROJECT.md",
    "- Confirmed that direct live changes require an explicit authenticated publishing mechanism; otherwise changes remain a Tessera draft/export.\n",
    "- Confirmed that direct live changes require an explicit authenticated publishing mechanism; otherwise changes remain a Tessera draft/export.\n- Decided not to expose managed-source Sync/Edit/Delete before a CMS/API publishing connector is configured; until then Tessera only compares the live file with canonical platform requirements.\n",
    "connector-gated source editor decision",
)

# Basic source validation.
main_source = Path("src/main.tsx").read_text(encoding="utf-8")
panel_source = Path("src/components/AdsTxtPanel.tsx").read_text(encoding="utf-8")
if "AdsTxtSourceEditorPortal" in main_source:
    raise SystemExit("Managed source portal is still mounted.")
if "liveSearchMatches" in panel_source:
    raise SystemExit("Legacy combined live-search state is still referenced.")
for required in (
    "onPaste={(event) => {",
    "Search canonical monitoring requirements",
    "Search monitoring requirement",
):
    if required not in panel_source:
        raise SystemExit(f"Missing expected search hardening marker: {required}")

print("Ads.txt pre-connector alignment complete.")
