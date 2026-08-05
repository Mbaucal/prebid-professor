from pathlib import Path

panel_path = Path('src/components/AdsTxtPanel.tsx')
panel = panel_path.read_text()

label_marker = """function labelFromEntry(entry: string): string {
  return lineWithoutComment(entry).split(',')[0]?.trim() || 'Ads.txt';
}

"""
label_replacement = label_marker + """function exactSourceKey(value: string): string {
  const raw = value.replace(/^\\uFEFF/, '').trim();
  const commentIndex = raw.indexOf('#');
  const record = (commentIndex >= 0 ? raw.slice(0, commentIndex) : raw).trim();
  const comment = (commentIndex >= 0 ? raw.slice(commentIndex + 1) : '').trim().toLowerCase();
  const equalsIndex = record.indexOf('=');
  const commaIndex = record.indexOf(',');
  const normalizedRecord = equalsIndex > 0 && (commaIndex < 0 || equalsIndex < commaIndex)
    ? `${record.slice(0, equalsIndex).trim().toLowerCase()}=${record.slice(equalsIndex + 1).trim().toLowerCase()}`
    : record.split(',').map((field) => field.trim().toLowerCase()).join(',');
  return comment ? `${normalizedRecord}#${comment}` : normalizedRecord;
}

function sourceLabelFromLiveLine(value: string): string {
  const raw = value.replace(/^\\uFEFF/, '').trim();
  const commentIndex = raw.indexOf('#');
  const inlineComment = (commentIndex >= 0 ? raw.slice(commentIndex + 1) : '').trim();
  if (inlineComment) return inlineComment;

  const record = lineWithoutComment(raw);
  const equalsIndex = record.indexOf('=');
  const commaIndex = record.indexOf(',');
  if (equalsIndex > 0 && (commaIndex < 0 || equalsIndex < commaIndex)) {
    return record.slice(0, equalsIndex).trim().toUpperCase() || 'Live ads.txt';
  }
  return record.split(',')[0]?.trim() || 'Live ads.txt';
}

"""
if label_marker not in panel:
    raise SystemExit('labelFromEntry insertion point not found')
panel = panel.replace(label_marker, label_replacement, 1)

state_marker = """  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
"""
state_replacement = """  const [saving, setSaving] = useState(false);
  const [addingLiveKey, setAddingLiveKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
"""
if state_marker not in panel:
    raise SystemExit('state insertion point not found')
panel = panel.replace(state_marker, state_replacement, 1)

live_start = panel.index('  const liveSearchMatches = useMemo(() => {')
live_end = panel.index('\n\n  const load = useCallback', live_start)
new_live = """  const liveSearchMatches = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query || !check?.duplicateEntries?.length) return [];

    const savedExactCounts = new Map<string, number>();
    requirements.forEach((requirement) => {
      const key = exactSourceKey(requirement.entry);
      savedExactCounts.set(key, (savedExactCounts.get(key) ?? 0) + 1);
    });

    const seenLiveCounts = new Map<string, number>();
    const matches: Array<{
      canonicalEntry: string;
      occurrences: number;
      lineNumber: number;
      line: string;
      exactKey: string;
      saved: boolean;
    }> = [];

    check.duplicateEntries.forEach((duplicate) => {
      const canonicalMatches = duplicate.entry.toLowerCase().includes(query);
      (duplicate.rawOccurrences ?? []).forEach((occurrence) => {
        const exactKey = exactSourceKey(occurrence.line);
        const occurrenceNumber = (seenLiveCounts.get(exactKey) ?? 0) + 1;
        seenLiveCounts.set(exactKey, occurrenceNumber);
        if (!canonicalMatches && !occurrence.line.toLowerCase().includes(query)) return;
        matches.push({
          canonicalEntry: duplicate.entry,
          occurrences: duplicate.occurrences,
          lineNumber: occurrence.lineNumber,
          line: occurrence.line,
          exactKey,
          saved: occurrenceNumber <= (savedExactCounts.get(exactKey) ?? 0),
        });
      });
    });

    return matches.sort((left, right) => left.lineNumber - right.lineNumber);
  }, [check, requirements, searchQuery]);"""
panel = panel[:live_start] + new_live + panel[live_end:]

check_marker = """  async function importRequirements(): Promise<void> {
"""
add_function = """  async function addLiveOccurrence(match: {
    lineNumber: number;
    line: string;
    exactKey: string;
  }): Promise<void> {
    const pendingKey = `${match.lineNumber}:${match.exactKey}`;
    if (saving || addingLiveKey) return;
    setSaving(true);
    setAddingLiveKey(pendingKey);
    setError(null);
    setMessage(null);
    try {
      await requestJson(
        `/api/publishers/${encodeURIComponent(site.id)}/ads-txt/requirements`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sourceLabel: sourceLabelFromLiveLine(match.line),
            entry: match.line,
            required: true,
          }),
        },
      );
      await load();
      setMessage(`Live line ${match.lineNumber} added to the managed list.`);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'The live ads.txt line could not be added.');
    } finally {
      setAddingLiveKey(null);
      setSaving(false);
    }
  }

""" + check_marker
if check_marker not in panel:
    raise SystemExit('addLiveOccurrence insertion point not found')
panel = panel.replace(check_marker, add_function, 1)

paragraph_old = """                <p>These lines exist in the live publisher file. To remove an extra occurrence, edit the source ads.txt. Do not delete the single saved requirement below unless Tessera should stop monitoring that record.</p>
"""
paragraph_new = """                <p>The orange cards are the current live file and remain read-only. Add any unsaved occurrence to Tessera's managed list; it will then appear below with its own Edit and Delete actions. Publishing the managed file back to the website still requires a CMS connection.</p>
"""
if paragraph_old not in panel:
    raise SystemExit('live search explanation target not found')
panel = panel.replace(paragraph_old, paragraph_new, 1)

map_old = """                  {liveSearchMatches.map((match) => (
                    <div key={`${match.lineNumber}-${match.line}`}>
                      <div>
                        <strong>Live line {match.lineNumber}</strong>
                        <span>{match.occurrences} occurrences for this canonical record</span>
                      </div>
                      <code>{match.line}</code>
                      <em>LIVE FILE · READ ONLY</em>
                    </div>
                  ))}
"""
map_new = """                  {liveSearchMatches.map((match) => {
                    const pendingKey = `${match.lineNumber}:${match.exactKey}`;
                    return (
                      <div key={`${match.lineNumber}-${match.line}`}>
                        <div>
                          <strong>Live line {match.lineNumber}</strong>
                          <span>{match.occurrences} occurrences for this canonical record</span>
                        </div>
                        <code>{match.line}</code>
                        <div className="ads-txt-live-search-actions">
                          <em>LIVE FILE · READ ONLY</em>
                          {match.saved ? (
                            <span className="ads-txt-live-search-managed">SAVED IN TESSERA</span>
                          ) : (
                            <button
                              className="button secondary"
                              disabled={saving || Boolean(addingLiveKey)}
                              onClick={() => void addLiveOccurrence(match)}
                              type="button"
                            >
                              {addingLiveKey === pendingKey ? 'Adding…' : 'Add to managed list'}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
"""
if map_old not in panel:
    raise SystemExit('live search card render target not found')
panel = panel.replace(map_old, map_new, 1)
panel_path.write_text(panel)

css_path = Path('src/ads-txt.css')
css = css_path.read_text()
css_old = """.ads-txt-live-search-list em {
  grid-column: 1 / -1;
  color: #c2410c;
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
  letter-spacing: 0.04em;
}
"""
css_new = """.ads-txt-live-search-actions {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ads-txt-live-search-actions em {
  color: #c2410c;
  font-size: 10px;
  font-style: normal;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.ads-txt-live-search-managed {
  border: 1px solid #9ee2b8;
  border-radius: 999px;
  background: #ecfdf3;
  color: #166534 !important;
  padding: 5px 8px;
  font-size: 10px !important;
  font-weight: 900;
  letter-spacing: 0.04em;
}

.ads-txt-live-search-actions .button {
  min-height: 34px;
  padding: 7px 10px;
}
"""
if css_old not in css:
    raise SystemExit('live search CSS target not found')
css = css.replace(css_old, css_new, 1)

mobile_old = """  .ads-txt-duplicate-heading,
  .ads-txt-duplicate-list > div > div,
  .ads-txt-live-search-heading,
  .ads-txt-live-search-list > div > div {
"""
mobile_new = """  .ads-txt-duplicate-heading,
  .ads-txt-duplicate-list > div > div,
  .ads-txt-live-search-heading,
  .ads-txt-live-search-list > div > div,
  .ads-txt-live-search-actions {
"""
if mobile_old not in css:
    raise SystemExit('mobile live search CSS target not found')
css = css.replace(mobile_old, mobile_new, 1)
css_path.write_text(css)
