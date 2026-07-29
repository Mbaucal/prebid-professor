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


def append_once(path: str, marker: str, content: str, label: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if content.strip() in source:
        print(f"{label}: already applied")
        return
    if marker not in source:
        raise SystemExit(f"{label} marker was not found in {path}.")
    file_path.write_text(source.replace(marker, f"{content.rstrip()}\n\n{marker}", 1), encoding="utf-8")
    print(f"{label}: applied")


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f"Integration validation failed in {path}: {missing}")


replace_once(
    "worker/ads-txt.ts",
    """  duplicateEntries: Array<{
    entry: string;
    occurrences: number;
    lineNumbers: number[];
  }>;""",
    """  duplicateEntries: Array<{
    entry: string;
    occurrences: number;
    lineNumbers: number[];
    rawOccurrences: Array<{ lineNumber: number; line: string }>;
  }>;""",
    "duplicate result type",
)
replace_once(
    "worker/ads-txt.ts",
    "const occurrences = new Map<string, { entry: string; lineNumbers: number[] }>();",
    "const occurrences = new Map<string, { entry: string; lineNumbers: number[]; rawOccurrences: Array<{ lineNumber: number; line: string }> }>();",
    "duplicate occurrence map type",
)
replace_once(
    "worker/ads-txt.ts",
    """  text.split(/\\r?\\n/).forEach((rawLine, index) => {
    const line = lineWithoutComment(rawLine);
    if (!line) return;""",
    """  text.split(/\\r?\\n/).forEach((rawLine, index) => {
    const line = lineWithoutComment(rawLine);
    const rawDisplay = rawLine.replace(/^\\uFEFF/, '').trim();
    if (!line) return;""",
    "preserve raw live line",
)
replace_once(
    "worker/ads-txt.ts",
    """      if (current) {
        duplicateCount += 1;
        current.lineNumbers.push(index + 1);
      } else {
        occurrences.set(parsed.canonical, {
          entry: parsed.display,
          lineNumbers: [index + 1],
        });
      }""",
    """      if (current) {
        duplicateCount += 1;
        current.lineNumbers.push(index + 1);
        current.rawOccurrences.push({ lineNumber: index + 1, line: rawDisplay });
      } else {
        occurrences.set(parsed.canonical, {
          entry: parsed.display,
          lineNumbers: [index + 1],
          rawOccurrences: [{ lineNumber: index + 1, line: rawDisplay }],
        });
      }""",
    "collect raw live occurrences",
)
replace_once(
    "worker/ads-txt.ts",
    """    .map((item) => ({
      entry: item.entry,
      occurrences: item.lineNumbers.length,
      lineNumbers: item.lineNumbers,
    }))""",
    """    .map((item) => ({
      entry: item.entry,
      occurrences: item.lineNumbers.length,
      lineNumbers: item.lineNumbers,
      rawOccurrences: item.rawOccurrences,
    }))""",
    "return raw live occurrences",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """type DuplicateEntry = {
  entry: string;
  occurrences: number;
  lineNumbers: number[];
};""",
    """type DuplicateEntry = {
  entry: string;
  occurrences: number;
  lineNumbers: number[];
  rawOccurrences?: Array<{ lineNumber: number; line: string }>;
};""",
    "frontend duplicate type",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    """            <p>Each card is a different ads.txt record that appears more than once in the live publisher file. The cards are not duplicates of one another. Tessera remains read-only; review the listed live line numbers in the source ads.txt file.</p>""",
    """            <p>Each card is a different ads.txt record that appears more than once in the live publisher file. Inline comments after # are ignored for ads.txt matching, but the exact raw live lines are shown below. The saved list intentionally contains one canonical requirement. Tessera remains read-only.</p>""",
    "repeat explanation",
)
replace_once(
    "src/components/AdsTxtPanel.tsx",
    """                    <code>{duplicate.entry}</code>
                    <button className=\"button secondary\" onClick={() => findSavedRequirement(duplicate.entry)} type=\"button\">Search saved requirement</button>""",
    """                    <code>{duplicate.entry}</code>
                    {duplicate.rawOccurrences?.length ? (
                      <div className=\"ads-txt-raw-occurrences\">
                        {duplicate.rawOccurrences.map((occurrence) => (
                          <div key={`${occurrence.lineNumber}-${occurrence.line}`}>
                            <span>Live line {occurrence.lineNumber}</span>
                            <code>{occurrence.line}</code>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <button className=\"button secondary\" onClick={() => findSavedRequirement(duplicate.entry)} type=\"button\">Show canonical saved requirement</button>""",
    "raw occurrence rendering",
)

append_once(
    "src/ads-txt.css",
    "@media (max-width: 760px) {",
    """.ads-txt-raw-occurrences {
  grid-column: 1 / -1;
  display: grid;
  gap: 7px;
  border-top: 1px solid #fed7aa;
  padding-top: 9px;
}

.ads-txt-raw-occurrences > div {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  align-items: start;
  gap: 10px;
}

.ads-txt-raw-occurrences span {
  color: #9a3412;
  font-size: 11px;
  font-weight: 800;
}

.ads-txt-raw-occurrences code {
  white-space: normal;
  overflow-wrap: anywhere;
  color: #334155;
}""",
    "raw occurrence styles",
)

replace_once(
    "worker/app-deploy.ts",
    "const RUNTIME_BUILD = '2026-07-29-monitoring-review-hardening-v31';",
    "const RUNTIME_BUILD = '2026-07-29-ads-txt-raw-repeats-v32';",
    "runtime build marker",
)

replace_once(
    "PROJECT.md",
    "- [ ] Clicking the repeated-live-entry count shows each independently repeated record, its occurrence count, and live line numbers.",
    "- [ ] Clicking the repeated-live-entry count shows each independently repeated record, occurrence count, line numbers, and exact raw live lines including inline comments.",
    "project acceptance detail",
)
replace_once(
    "PROJECT.md",
    "- Added saved-requirement search and read-only repeated-live-entry inspection before the Monitoring branch is promoted; clarified that each card is a separate record repeated within the live file.",
    "- Added saved-requirement search and read-only repeated-live-entry inspection before the Monitoring branch is promoted; exact raw live occurrences are shown so comment variants such as `#smato` remain visible while matching one canonical requirement.",
    "project decision detail",
)

require(
    "worker/ads-txt.ts",
    "rawOccurrences: Array<{ lineNumber: number; line: string }>",
    "current.rawOccurrences.push",
    "rawOccurrences: item.rawOccurrences",
)
require(
    "src/components/AdsTxtPanel.tsx",
    "ads-txt-raw-occurrences",
    "Inline comments after # are ignored",
    "Show canonical saved requirement",
)
require(
    "worker/app-deploy.ts",
    "2026-07-29-ads-txt-raw-repeats-v32",
)
print("Ads.txt raw repeated-line visibility integration passed.")
