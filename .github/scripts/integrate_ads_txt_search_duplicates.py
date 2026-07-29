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
    if marker in source:
        print(f"{label}: already applied")
        return
    file_path.write_text(source.rstrip() + "\n\n" + content.rstrip() + "\n", encoding="utf-8")
    print(f"{label}: appended")


def require(path: str, *needles: str) -> None:
    source = Path(path).read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle not in source]
    if missing:
        raise SystemExit(f"Validation failed in {path}: {missing}")


replace_once(
    "worker/ads-txt.ts",
    """function actualAdsEntries(text: string): {
  canonical: Set<string>;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
} {
  const canonical = new Set<string>();
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const rawLine of text.split(/\\r?\\n/)) {
    const line = lineWithoutComment(rawLine);
    if (!line) continue;
    try {
      const parsed = parseAdsEntry(line);
      validCount += 1;
      if (canonical.has(parsed.canonical)) duplicateCount += 1;
      canonical.add(parsed.canonical);
    } catch {
      invalidCount += 1;
    }
  }

  return { canonical, validCount, invalidCount, duplicateCount };
}""",
    """function actualAdsEntries(text: string): {
  canonical: Set<string>;
  validCount: number;
  invalidCount: number;
  duplicateCount: number;
  duplicateEntries: Array<{
    entry: string;
    occurrences: number;
    lineNumbers: number[];
  }>;
} {
  const canonical = new Set<string>();
  const occurrences = new Map<string, { entry: string; lineNumbers: number[] }>();
  let validCount = 0;
  let invalidCount = 0;
  let duplicateCount = 0;

  text.split(/\\r?\\n/).forEach((rawLine, index) => {
    const line = lineWithoutComment(rawLine);
    if (!line) return;
    try {
      const parsed = parseAdsEntry(line);
      validCount += 1;
      const current = occurrences.get(parsed.canonical);
      if (current) {
        duplicateCount += 1;
        current.lineNumbers.push(index + 1);
      } else {
        occurrences.set(parsed.canonical, {
          entry: parsed.display,
          lineNumbers: [index + 1],
        });
      }
      canonical.add(parsed.canonical);
    } catch {
      invalidCount += 1;
    }
  });

  const duplicateEntries = Array.from(occurrences.values())
    .filter((item) => item.lineNumbers.length > 1)
    .map((item) => ({
      entry: item.entry,
      occurrences: item.lineNumbers.length,
      lineNumbers: item.lineNumbers,
    }))
    .sort((left, right) => right.occurrences - left.occurrences || left.entry.localeCompare(right.entry));

  return { canonical, validCount, invalidCount, duplicateCount, duplicateEntries };
}""",
    "live duplicate detail collection",
)

replace_once(
    "worker/ads-txt.ts",
    """        duplicateLineCount: actual.duplicateCount,
        requirementCount: requirements.length,""",
    """        duplicateLineCount: actual.duplicateCount,
        duplicateEntries: actual.duplicateEntries,
        requirementCount: requirements.length,""",
    "duplicate details response",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """type RequirementResult = Requirement & { found: boolean };

type AdsTxtCheck = {""",
    """type RequirementResult = Requirement & { found: boolean };

type DuplicateEntry = {
  entry: string;
  occurrences: number;
  lineNumbers: number[];
};

type AdsTxtCheck = {""",
    "duplicate entry type",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """  duplicateLineCount?: number;
  requirementCount?: number;""",
    """  duplicateLineCount?: number;
  duplicateEntries?: DuplicateEntry[];
  requirementCount?: number;""",
    "duplicate response typing",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """  const [check, setCheck] = useState<AdsTxtCheck | null>(null);
  const [loading, setLoading] = useState(true);""",
    """  const [check, setCheck] = useState<AdsTxtCheck | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showDuplicates, setShowDuplicates] = useState(false);
  const [loading, setLoading] = useState(true);""",
    "ads.txt search state",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """  const manualCount = useMemo(() => manualEntryCount(entry), [entry]);

  const load = useCallback(async () => {""",
    """  const manualCount = useMemo(() => manualEntryCount(entry), [entry]);
  const filteredRequirements = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return requirements;
    return requirements.filter((requirement) =>
      `${requirement.sourceLabel} ${requirement.entry}`.toLowerCase().includes(query),
    );
  }, [requirements, searchQuery]);

  const load = useCallback(async () => {""",
    "saved requirement filtering",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """  useEffect(() => {
    setAdsTxtUrl(site.adsTxtUrl || `https://${site.domain}/ads.txt`);
    setCheck(null);
    void load();
  }, [load, site.adsTxtUrl, site.domain]);""",
    """  useEffect(() => {
    setAdsTxtUrl(site.adsTxtUrl || `https://${site.domain}/ads.txt`);
    setCheck(null);
    setSearchQuery('');
    setShowDuplicates(false);
    void load();
  }, [load, site.adsTxtUrl, site.domain]);""",
    "reset ads.txt filters after site switch",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """      setCheck(payload.check);
    } catch (checkError) {""",
    """      setCheck(payload.check);
      setShowDuplicates(false);
    } catch (checkError) {""",
    "reset duplicate panel after check",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """  if (loading) return <div className="config-loading">Loading ads.txt requirements…</div>;
""",
    """  function findSavedRequirement(duplicateEntry: string): void {
    setSearchQuery(duplicateEntry);
    window.requestAnimationFrame(() => {
      document.getElementById('ads-txt-saved-requirements')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  if (loading) return <div className="config-loading">Loading ads.txt requirements…</div>;
""",
    "duplicate-to-search helper",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """          <div className="ads-txt-check-facts">
            <div><span>Checked</span><strong>{formatTime(check.fetchedAt)}</strong></div>
            <div><span>HTTP</span><strong>{check.httpStatus ?? '—'}</strong></div>
            <div><span>Live entries</span><strong>{check.actualEntryCount ?? 0}</strong></div>
            <div><span>Invalid lines</span><strong>{check.invalidLineCount ?? 0}</strong></div>
            <div><span>Duplicates</span><strong>{check.duplicateLineCount ?? 0}</strong></div>
          </div>
        ) : null}

        {check?.optionalMissing.length ? (""",
    """          <div className="ads-txt-check-facts">
            <div><span>Checked</span><strong>{formatTime(check.fetchedAt)}</strong></div>
            <div><span>HTTP</span><strong>{check.httpStatus ?? '—'}</strong></div>
            <div><span>Live entries</span><strong>{check.actualEntryCount ?? 0}</strong></div>
            <div><span>Invalid lines</span><strong>{check.invalidLineCount ?? 0}</strong></div>
            <button
              className={`ads-txt-check-fact-button ${showDuplicates ? 'active' : ''}`}
              disabled={!check.duplicateLineCount}
              onClick={() => setShowDuplicates((current) => !current)}
              type="button"
            >
              <span>Duplicates</span>
              <strong>{check.duplicateLineCount ?? 0}</strong>
              <small>{check.duplicateLineCount ? (showDuplicates ? 'Hide lines' : 'View lines') : 'None found'}</small>
            </button>
          </div>
        ) : null}

        {check && showDuplicates && (check.duplicateLineCount ?? 0) > 0 ? (
          <div className="ads-txt-duplicate-panel">
            <div className="ads-txt-duplicate-heading">
              <div>
                <span className="panel-kicker">Live file cleanup</span>
                <h4>Duplicate ads.txt lines</h4>
              </div>
              <strong>{check.duplicateLineCount} extra cop{check.duplicateLineCount === 1 ? 'y' : 'ies'}</strong>
            </div>
            <p>Only duplicate lines from the live publisher file are shown below. Tessera remains read-only; remove the extra copies in the source ads.txt file.</p>
            {check.duplicateEntries?.length ? (
              <div className="ads-txt-duplicate-list">
                {check.duplicateEntries.map((duplicate) => (
                  <div key={`${duplicate.entry}-${duplicate.lineNumbers.join('-')}`}>
                    <div>
                      <strong>{duplicate.occurrences} occurrences</strong>
                      <span>Live lines {duplicate.lineNumbers.join(', ')}</span>
                    </div>
                    <code>{duplicate.entry}</code>
                    <button className="button secondary" onClick={() => findSavedRequirement(duplicate.entry)} type="button">Find in saved list</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="ads-txt-empty"><strong>Duplicate details unavailable</strong><span>Run Check now again after the latest preview deployment.</span></div>
            )}
          </div>
        ) : null}

        {check?.optionalMissing.length ? (""",
    "clickable duplicate inspection",
)

replace_once(
    "src/components/AdsTxtPanel.tsx",
    """      <article className="ads-txt-list-card">
        <div className="ads-txt-card-heading">
          <div><span className="panel-kicker">Saved requirements</span><h3>{requirements.length} entr{requirements.length === 1 ? 'y' : 'ies'}</h3></div>
          <button className="button secondary" onClick={() => void load()} type="button">Refresh</button>
        </div>

        {requirements.length ? (
          <div className="ads-txt-requirement-list">
            {requirements.map((requirement) => {
              const status = statusForRequirement(check, requirement.id);
              return (
                <div className={`ads-txt-requirement ${status}`} key={requirement.id}>
                  <div className="ads-txt-requirement-status" title={status === 'found' ? 'Found in live ads.txt' : status === 'missing' ? 'Missing from live ads.txt' : 'Not checked'}>
                    {status === 'found' ? '✓' : status === 'missing' ? '×' : '—'}
                  </div>
                  <div className="ads-txt-requirement-main">
                    <div><strong>{requirement.sourceLabel}</strong><span className={requirement.required ? 'required' : 'optional'}>{requirement.required ? 'required' : 'optional'}</span></div>
                    <code>{requirement.entry}</code>
                  </div>
                  <div className="ads-txt-requirement-actions">
                    <button className="button secondary" onClick={() => editRequirement(requirement)} type="button">Edit</button>
                    <button className="button danger subtle" disabled={saving} onClick={() => void deleteRequirement(requirement)} type="button">Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="ads-txt-empty"><strong>No saved requirements</strong><span>Add a line manually, import a CSV, or copy requirements from another site.</span></div>
        )}
      </article>""",
    """      <article className="ads-txt-list-card" id="ads-txt-saved-requirements">
        <div className="ads-txt-card-heading">
          <div>
            <span className="panel-kicker">Saved requirements</span>
            <h3>{filteredRequirements.length}{searchQuery.trim() ? ` of ${requirements.length}` : ''} entr{filteredRequirements.length === 1 ? 'y' : 'ies'}</h3>
          </div>
          <button className="button secondary" onClick={() => void load()} type="button">Refresh</button>
        </div>

        {requirements.length ? (
          <>
            <div className="ads-txt-list-toolbar">
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
              <div className="ads-txt-requirement-list">
                {filteredRequirements.map((requirement) => {
                  const status = statusForRequirement(check, requirement.id);
                  return (
                    <div className={`ads-txt-requirement ${status}`} key={requirement.id}>
                      <div className="ads-txt-requirement-status" title={status === 'found' ? 'Found in live ads.txt' : status === 'missing' ? 'Missing from live ads.txt' : 'Not checked'}>
                        {status === 'found' ? '✓' : status === 'missing' ? '×' : '—'}
                      </div>
                      <div className="ads-txt-requirement-main">
                        <div><strong>{requirement.sourceLabel}</strong><span className={requirement.required ? 'required' : 'optional'}>{requirement.required ? 'required' : 'optional'}</span></div>
                        <code>{requirement.entry}</code>
                      </div>
                      <div className="ads-txt-requirement-actions">
                        <button className="button secondary" onClick={() => editRequirement(requirement)} type="button">Edit</button>
                        <button className="button danger subtle" disabled={saving} onClick={() => void deleteRequirement(requirement)} type="button">Delete</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="ads-txt-empty"><strong>No matching requirements</strong><span>Try a source name, ad-system domain, seller ID, or part of the complete line.</span></div>
            )}
          </>
        ) : (
          <div className="ads-txt-empty"><strong>No saved requirements</strong><span>Add a line manually, import a CSV, or copy requirements from another site.</span></div>
        )}
      </article>""",
    "saved requirement search UI",
)

replace_once(
    "src/ads-txt.css",
    """.ads-txt-check-facts > div {
  display: grid;""",
    """.ads-txt-check-facts > div,
.ads-txt-check-facts > button {
  display: grid;""",
    "duplicate fact card base style",
)

append_once(
    "src/ads-txt.css",
    ".ads-txt-duplicate-panel",
    """.ads-txt-check-fact-button {
  box-sizing: border-box;
  width: 100%;
  text-align: left;
  font: inherit;
  cursor: pointer;
}

.ads-txt-check-fact-button:hover:not(:disabled),
.ads-txt-check-fact-button.active {
  border-color: #fb923c;
  background: #fff7ed;
}

.ads-txt-check-fact-button:disabled {
  cursor: default;
  opacity: 0.75;
}

.ads-txt-check-fact-button small {
  color: #c2410c;
  font-size: 10px;
  font-weight: 800;
}

.ads-txt-duplicate-panel {
  display: grid;
  gap: 14px;
  margin-top: 14px;
  border: 1px solid #fdba74;
  border-radius: 11px;
  background: #fffaf5;
  padding: 16px;
}

.ads-txt-duplicate-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.ads-txt-duplicate-heading h4 {
  margin: 2px 0 0;
  color: #172033;
}

.ads-txt-duplicate-heading > strong {
  border-radius: 999px;
  background: #ffedd5;
  color: #c2410c;
  padding: 6px 10px;
  font-size: 12px;
}

.ads-txt-duplicate-panel > p {
  margin: 0;
}

.ads-txt-duplicate-list {
  display: grid;
  gap: 10px;
}

.ads-txt-duplicate-list > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px 12px;
  border: 1px solid #fed7aa;
  border-radius: 10px;
  background: #fff;
  padding: 12px;
}

.ads-txt-duplicate-list > div > div {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ads-txt-duplicate-list span {
  color: #64748b;
  font-size: 12px;
}

.ads-txt-duplicate-list code {
  grid-column: 1 / -1;
  white-space: normal;
  overflow-wrap: anywhere;
  color: #334155;
}

.ads-txt-list-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
}

.ads-txt-list-toolbar input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #cbd5e1;
  border-radius: 9px;
  background: #fff;
  color: #172033;
  font: inherit;
  padding: 10px 12px;
}

@media (max-width: 760px) {
  .ads-txt-duplicate-heading,
  .ads-txt-duplicate-list > div > div {
    align-items: flex-start;
    flex-direction: column;
  }

  .ads-txt-duplicate-list > div,
  .ads-txt-list-toolbar {
    grid-template-columns: 1fr;
  }

  .ads-txt-duplicate-list .button {
    justify-self: start;
  }
}""",
    "ads.txt search and duplicate styles",
)

replace_once(
    "PROJECT.md",
    """| ads.txt requirements, import, copy, edit, delete, and live check | Implemented |""",
    """| ads.txt requirements, import, copy, edit, delete, and live check | Implemented |
| Saved ads.txt requirement search and live duplicate-line inspection | Staged on the current feature branch |""",
    "project module status",
)

replace_once(
    "PROJECT.md",
    """- [x] Cloudflare branch preview deploys successfully with the current monitoring code.

### Still required before production merge""",
    """- [x] Cloudflare branch preview deploys successfully with the current monitoring code.

### Ads.txt workspace additions to verify

- [ ] Saved requirements can be searched by source label, ad-system domain, seller ID, or full line.
- [ ] Clicking the live duplicate count shows only duplicate lines, occurrence counts, and live line numbers.
- [ ] Duplicate inspection clearly remains read-only and does not imply Tessera edits the publisher file.

### Still required before production merge""",
    "ads.txt acceptance checks",
)

replace_once(
    "PROJECT.md",
    """- Decided that healthy recovery closes incident memory without sending a recovery email.""",
    """- Decided that healthy recovery closes incident memory without sending a recovery email.
- Added saved-requirement search and read-only live duplicate inspection before the Monitoring branch is promoted.""",
    "project decision log",
)

require(
    "worker/ads-txt.ts",
    "duplicateEntries: actual.duplicateEntries",
    "lineNumbers: number[]",
)
require(
    "src/components/AdsTxtPanel.tsx",
    "Search saved ads.txt requirements",
    "Duplicate ads.txt lines",
    "Find in saved list",
    "filteredRequirements.map",
)
require(
    "src/ads-txt.css",
    ".ads-txt-duplicate-panel",
    ".ads-txt-list-toolbar",
)
print("Ads.txt search and duplicate inspection integration validated.")
