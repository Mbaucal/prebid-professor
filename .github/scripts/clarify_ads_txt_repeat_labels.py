from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if new in source:
        print(f"{label}: already applied")
        return
    if old not in source:
        raise SystemExit(f"{label} anchor was not found in {path}.")
    file_path.write_text(source.replace(old, new, 1), encoding="utf-8")
    print(f"{label}: applied")


replace_once(
    "src/components/AdsTxtPanel.tsx",
    "<span>Duplicates</span>",
    "<span>Repeated live entries</span>",
    "summary label",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "{check.duplicateLineCount ? (showDuplicates ? 'Hide lines' : 'View lines') : 'None found'}",
    "{check.duplicateLineCount ? (showDuplicates ? 'Hide repeats' : 'View repeats') : 'None found'}",
    "summary action",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "<h4>Duplicate ads.txt lines</h4>",
    "<h4>Repeated live ads.txt entries</h4>",
    "panel title",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "<strong>{check.duplicateLineCount} extra cop{check.duplicateLineCount === 1 ? 'y' : 'ies'}</strong>",
    "<strong>{check.duplicateLineCount} extra occurrence{check.duplicateLineCount === 1 ? '' : 's'}</strong>",
    "panel count",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "<p>Only duplicate lines from the live publisher file are shown below. Tessera remains read-only; remove the extra copies in the source ads.txt file.</p>",
    "<p>Each card is a different ads.txt record that appears more than once in the live publisher file. The cards are not duplicates of one another. Tessera remains read-only; review the listed live line numbers in the source ads.txt file.</p>",
    "panel explanation",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    ">Find in saved list</button>",
    ">Search saved requirement</button>",
    "saved-list button",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    "<div className=\"ads-txt-empty\"><strong>Duplicate details unavailable</strong><span>Run Check now again after the latest preview deployment.</span></div>",
    "<div className=\"ads-txt-empty\"><strong>Repeat details unavailable</strong><span>Run Check now again after the latest preview deployment.</span></div>",
    "empty state",
)
replace_once(
    "PROJECT.md",
    "| Saved ads.txt requirement search and live duplicate-line inspection | Staged on the current feature branch |",
    "| Saved ads.txt requirement search and repeated-live-entry inspection | Staged on the current feature branch |",
    "project module wording",
)
replace_once(
    "PROJECT.md",
    "- [ ] Clicking the live duplicate count shows only duplicate lines, occurrence counts, and live line numbers.",
    "- [ ] Clicking the repeated-live-entry count shows each independently repeated record, its occurrence count, and live line numbers.",
    "project acceptance wording",
)
replace_once(
    "PROJECT.md",
    "- [ ] Duplicate inspection clearly remains read-only and does not imply Tessera edits the publisher file.",
    "- [ ] Repeated-entry inspection clearly remains read-only and does not imply the displayed records are duplicates of one another or that Tessera edits the publisher file.",
    "project safety wording",
)
replace_once(
    "PROJECT.md",
    "- Added saved-requirement search and read-only live duplicate inspection before the Monitoring branch is promoted.",
    "- Added saved-requirement search and read-only repeated-live-entry inspection before the Monitoring branch is promoted; clarified that each card is a separate record repeated within the live file.",
    "decision log wording",
)

print("Ads.txt repeated-entry labels clarified.")
