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


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f"Integration validation failed in {path}: {missing}")


replace_once(
    "src/components/AdsTxtPanel.tsx",
    """  const filteredRequirements = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return requirements;
    return requirements.filter((requirement) =>
      `${requirement.sourceLabel} ${requirement.entry}`.toLowerCase().includes(query),
    );
  }, [requirements, searchQuery]);
""",
    """  const filteredRequirements = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return requirements;
    return requirements.filter((requirement) =>
      `${requirement.sourceLabel} ${requirement.entry}`.toLowerCase().includes(query),
    );
  }, [requirements, searchQuery]);
  const liveSearchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query || !check?.duplicateEntries?.length) return [];
    return check.duplicateEntries
      .flatMap((duplicate) => {
        const canonicalMatches = duplicate.entry.toLowerCase().includes(query);
        return (duplicate.rawOccurrences ?? [])
          .filter((occurrence) => canonicalMatches || occurrence.line.toLowerCase().includes(query))
          .map((occurrence) => ({
            canonicalEntry: duplicate.entry,
            occurrences: duplicate.occurrences,
            lineNumber: occurrence.lineNumber,
            line: occurrence.line,
          }));
      })
      .sort((left, right) => left.lineNumber - right.lineNumber);
  }, [check, searchQuery]);
""",
    "live search matches",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """            <p>Each card is a different ads.txt record that appears more than once in the live publisher file. Inline comments after # are ignored for ads.txt matching, but the exact raw live lines are shown below. The saved list intentionally contains one canonical requirement. Tessera remains read-only.</p>
            {check.duplicateEntries?.length ? (
              <div className="ads-txt-duplicate-list">
                {check.duplicateEntries.map((duplicate) => (
                  <div key={`${duplicate.entry}-${duplicate.lineNumbers.join('-')}`}>
                    <div>
                      <strong>{duplicate.occurrences} occurrences</strong>
                      <span>Live lines {duplicate.lineNumbers.join(', ')}</span>
                    </div>
                    <code>{duplicate.entry}</code>
                    {duplicate.rawOccurrences?.length ? (
                      <div className="ads-txt-raw-occurrences">
                        {duplicate.rawOccurrences.map((occurrence) => (
                          <div key={`${occurrence.lineNumber}-${occurrence.line}`}>
                            <span>Live line {occurrence.lineNumber}</span>
                            <code>{occurrence.line}</code>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    <button className="button secondary" onClick={() => findSavedRequirement(duplicate.entry)} type="button">Show canonical saved requirement</button>
                  </div>
                ))}
              </div>
""",
    """            <p>Each card is a different canonical ads.txt record that appears more than once in the live publisher file. Use the button to show every matching live occurrence together with the saved requirement below. Tessera remains read-only.</p>
            {check.duplicateEntries?.length ? (
              <div className="ads-txt-duplicate-list">
                {check.duplicateEntries.map((duplicate) => (
                  <div key={`${duplicate.entry}-${duplicate.lineNumbers.join('-')}`}>
                    <div>
                      <strong>{duplicate.occurrences} occurrences</strong>
                      <span>Live lines {duplicate.lineNumbers.join(', ')}</span>
                    </div>
                    <code>{duplicate.entry}</code>
                    <button className="button secondary" onClick={() => findSavedRequirement(duplicate.entry)} type="button">Show all matches in search</button>
                  </div>
                ))}
              </div>
""",
    "compact repeated entry cards",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """            <span className="panel-kicker">Saved requirements</span>
            <h3>{filteredRequirements.length}{searchQuery.trim() ? ` of ${requirements.length}` : ''} entr{filteredRequirements.length === 1 ? 'y' : 'ies'}</h3>
""",
    """            <span className="panel-kicker">Ads.txt search</span>
            <h3>
              {searchQuery.trim()
                ? `${liveSearchMatches.length} live match${liveSearchMatches.length === 1 ? '' : 'es'} · ${filteredRequirements.length} saved`
                : `${requirements.length} entr${requirements.length === 1 ? 'y' : 'ies'}`}
            </h3>
""",
    "search result counts",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """            <div className="ads-txt-list-toolbar">
              <input
                aria-label="Search saved ads.txt requirements"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search source, domain, seller ID or complete line…"
                type="search"
                value={searchQuery}
              />
              {searchQuery ? <button className="button secondary" onClick={() => setSearchQuery('')} type="button">Clear</button> : null}
            </div>
            {filteredRequirements.length ? (
""",
    """            <div className="ads-txt-list-toolbar">
              <input
                aria-label="Search saved and repeated live ads.txt entries"
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Search source, domain, seller ID, comment or complete line…"
                type="search"
                value={searchQuery}
              />
              {searchQuery ? <button className="button secondary" onClick={() => setSearchQuery('')} type="button">Clear</button> : null}
            </div>

            {searchQuery.trim() && liveSearchMatches.length ? (
              <div className="ads-txt-live-search-panel">
                <div className="ads-txt-live-search-heading">
                  <div>
                    <span className="panel-kicker">Live publisher file</span>
                    <h4>{liveSearchMatches.length} matching live line{liveSearchMatches.length === 1 ? '' : 's'}</h4>
                  </div>
                  <a className="button secondary" href={check?.finalUrl || check?.url || adsTxtUrl} rel="noreferrer" target="_blank">Open live ads.txt</a>
                </div>
                <p>These lines exist in the live publisher file. To remove an extra occurrence, edit the source ads.txt. Do not delete the single saved requirement below unless Tessera should stop monitoring that record.</p>
                <div className="ads-txt-live-search-list">
                  {liveSearchMatches.map((match) => (
                    <div key={`${match.lineNumber}-${match.line}`}>
                      <div>
                        <strong>Live line {match.lineNumber}</strong>
                        <span>{match.occurrences} occurrences for this canonical record</span>
                      </div>
                      <code>{match.line}</code>
                      <em>LIVE FILE · READ ONLY</em>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="ads-txt-saved-search-heading">
              <strong>Saved requirements</strong>
              {searchQuery.trim() ? <span>{filteredRequirements.length} match{filteredRequirements.length === 1 ? '' : 'es'}</span> : null}
            </div>
            {filteredRequirements.length ? (
""",
    "live matches in search",
)

replace_once(
    "src/ads-txt.css",
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
}

""",
    """.ads-txt-live-search-panel {
  display: grid;
  gap: 13px;
  border: 1px solid #fdba74;
  border-radius: 11px;
  background: #fffaf5;
  padding: 15px;
}

.ads-txt-live-search-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
}

.ads-txt-live-search-heading h4 {
  margin: 2px 0 0;
  color: #172033;
}

.ads-txt-live-search-panel > p {
  margin: 0;
  color: #7c2d12;
}

.ads-txt-live-search-list {
  display: grid;
  gap: 9px;
}

.ads-txt-live-search-list > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px 12px;
  border: 1px solid #fed7aa;
  border-radius: 10px;
  background: #fff;
  padding: 11px 12px;
}

.ads-txt-live-search-list > div > div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ads-txt-live-search-list span {
  color: #64748b;
  font-size: 12px;
}

.ads-txt-live-search-list code {
  grid-column: 1 / -1;
  white-space: normal;
  overflow-wrap: anywhere;
  color: #334155;
}

.ads-txt-live-search-list em {
  grid-column: 1 / -1;
  color: #c2410c;
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.ads-txt-saved-search-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  border-top: 1px solid #e2e8f0;
  padding-top: 14px;
  color: #172033;
}

.ads-txt-saved-search-heading span {
  color: #64748b;
  font-size: 12px;
  font-weight: 700;
}

""",
    "search live match styles",
)

replace_once(
    "src/ads-txt.css",
    """  .ads-txt-duplicate-heading,
  .ads-txt-duplicate-list > div > div {
    align-items: flex-start;
    flex-direction: column;
  }

  .ads-txt-duplicate-list > div,
  .ads-txt-list-toolbar {
    grid-template-columns: 1fr;
  }
""",
    """  .ads-txt-duplicate-heading,
  .ads-txt-duplicate-list > div > div,
  .ads-txt-live-search-heading,
  .ads-txt-live-search-list > div > div {
    align-items: flex-start;
    flex-direction: column;
  }

  .ads-txt-duplicate-list > div,
  .ads-txt-list-toolbar,
  .ads-txt-live-search-list > div {
    grid-template-columns: 1fr;
  }
""",
    "mobile live match layout",
)

replace_once(
    "PROJECT.md",
    """- [ ] Saved requirements can be searched by source label, ad-system domain, seller ID, or full line.
- [ ] Clicking the repeated-live-entry count shows each independently repeated record, occurrence count, line numbers, and exact raw live lines including inline comments.
- [ ] Repeated-entry inspection clearly remains read-only and does not imply the displayed records are duplicates of one another or that Tessera edits the publisher file.
""",
    """- [ ] Search shows every matching repeated live occurrence, including inline-comment variants such as `#Smato`, together with the matching canonical saved requirement.
- [ ] The repeated-entry summary remains compact and links directly into the combined live-and-saved search results.
- [ ] Live occurrences are clearly marked read-only, while Delete remains available only for actual saved requirements.
""",
    "project search acceptance criteria",
)

replace_once(
    "worker/app-deploy.ts",
    "const RUNTIME_BUILD = '2026-07-29-ads-txt-raw-repeats-v32';",
    "const RUNTIME_BUILD = '2026-07-29-ads-txt-combined-search-v33';",
    "runtime marker",
)

require(
    "src/components/AdsTxtPanel.tsx",
    "const liveSearchMatches = useMemo",
    "Show all matches in search",
    "matching live line",
    "LIVE FILE · READ ONLY",
    "Saved requirements",
)
require(
    "src/ads-txt.css",
    ".ads-txt-live-search-panel",
    ".ads-txt-live-search-list",
    ".ads-txt-saved-search-heading",
)
require(
    "worker/app-deploy.ts",
    "2026-07-29-ads-txt-combined-search-v33",
)
print("Ads.txt combined live and saved search integration passed.")
