from pathlib import Path

path = Path('src/components/AdsTxtPanel.tsx')
source = path.read_text(encoding='utf-8')


def replace_once(old: str, new: str, label: str) -> None:
    global source
    if new in source:
        return
    if old not in source:
        raise SystemExit(f'{label} anchor was not found.')
    source = source.replace(old, new, 1)


replace_once(
    """function statusForRequirement(check: AdsTxtCheck | null, requirementId: string): 'found' | 'missing' | 'unchecked' {""",
    """function manualEntryCount(value: string): number {
  return value
    .replace(/^\\uFEFF/, '')
    .split(/\\r?\\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .length;
}

function statusForRequirement(check: AdsTxtCheck | null, requirementId: string): 'found' | 'missing' | 'unchecked' {""",
    'manual entry counter',
)

replace_once(
    """  const sourceSites = useMemo(
    () => accounts.flatMap((account) => account.sites.map((candidate) => ({
      id: candidate.id,
      label: `${account.name} · ${candidate.name} (${candidate.domain})`,
    }))).filter((candidate) => candidate.id !== site.id),
    [accounts, site.id],
  );
""",
    """  const sourceSites = useMemo(
    () => accounts.flatMap((account) => account.sites.map((candidate) => ({
      id: candidate.id,
      label: `${account.name} · ${candidate.name} (${candidate.domain})`,
    }))).filter((candidate) => candidate.id !== site.id),
    [accounts, site.id],
  );
  const manualCount = useMemo(() => manualEntryCount(entry), [entry]);
""",
    'manual count memo',
)

replace_once(
    """  async function saveRequirement(): Promise<void> {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
""",
    """  async function saveRequirement(): Promise<void> {
    const entryCount = manualEntryCount(entry);
    if (!entryCount) {
      setError('Paste at least one valid ads.txt line.');
      return;
    }
    if (editingId && entryCount !== 1) {
      setError('Edit mode accepts one ads.txt line. Cancel the edit to add multiple new lines.');
      return;
    }

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
""",
    'save requirement validation',
)

replace_once(
    """      setMessage(editingId ? 'Ads.txt requirement updated.' : 'Ads.txt requirement added.');""",
    """      setMessage(
        editingId
          ? 'Ads.txt requirement updated.'
          : entryCount === 1
            ? 'Ads.txt requirement added.'
            : `${entryCount} ads.txt requirements added.`,
      );""",
    'multiline success message',
)

replace_once(
    """          <label><span>Source label</span><input onChange={(event) => setSourceLabel(event.target.value)} placeholder="Criteo" value={sourceLabel} /></label>
          <label><span>Full ads.txt entry</span><textarea onChange={(event) => setEntry(event.target.value)} placeholder="criteo.com, 12345, RESELLER, 9fac4a4a87c2a44f" rows={3} value={entry} /></label>
          <label className="ads-txt-checkbox"><input checked={required} onChange={(event) => setRequired(event.target.checked)} type="checkbox" /><span>Required entry</span></label>
          <button className="button primary" disabled={saving || !entry.trim()} onClick={() => void saveRequirement()} type="button">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add entry'}
          </button>""",
    """          <label>
            <span>Source label</span>
            <input
              onChange={(event) => setSourceLabel(event.target.value)}
              placeholder="Google, Criteo… (optional when # headings are pasted)"
              value={sourceLabel}
            />
          </label>
          <label>
            <span>{editingId ? 'Full ads.txt entry' : 'Full ads.txt entries'}</span>
            <textarea
              onChange={(event) => setEntry(event.target.value)}
              placeholder={'#Google\\ngoogle.com, pub-123, DIRECT, f08c47fec0942fa0\\ngoogle.com, pub-456, DIRECT, f08c47fec0942fa0'}
              rows={editingId ? 3 : 8}
              value={entry}
            />
            <small>
              {editingId
                ? 'Edit one ads.txt line.'
                : 'Paste one or many lines. Blank lines are ignored. A # heading can set the label for the lines below it. Maximum 100 entries at once.'}
            </small>
          </label>
          <label className="ads-txt-checkbox"><input checked={required} onChange={(event) => setRequired(event.target.checked)} type="checkbox" /><span>Required {editingId || manualCount <= 1 ? 'entry' : 'entries'}</span></label>
          <button className="button primary" disabled={saving || manualCount === 0} onClick={() => void saveRequirement()} type="button">
            {saving
              ? 'Saving…'
              : editingId
                ? 'Save changes'
                : manualCount > 1
                  ? `Add ${manualCount} entries`
                  : 'Add entry'}
          </button>""",
    'multiline editor controls',
)

path.write_text(source, encoding='utf-8')
print('Ads.txt multiline manual-entry UI applied.')
