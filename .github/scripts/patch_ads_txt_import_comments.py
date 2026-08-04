from pathlib import Path

path = Path('src/components/AdsTxtPanel.tsx')
source = path.read_text()

start = source.index('function importRowsFromText(text: string): ImportRow[] {')
end = source.index('\nfunction manualEntryCount(value: string): number {', start)

replacement = r'''function importRowsFromText(text: string): ImportRow[] {
  const rows = csvRows(text);
  if (!rows.length) return [];

  const header = rows[0].map((value) => value.trim().toLowerCase().replace(/[ -]+/g, '_'));
  const entryIndex = header.findIndex((value) => ['entry', 'ads_txt_entry', 'ads.txt_entry'].includes(value));
  const sourceIndex = header.findIndex((value) => ['source_label', 'source', 'label', 'partner'].includes(value));
  const requiredIndex = header.findIndex((value) => ['required', 'mandatory'].includes(value));

  if (entryIndex >= 0) {
    return rows
      .slice(1)
      .map((row) => {
        const entry = String(row[entryIndex] ?? '').replace(/^\uFEFF/, '').trim();
        return {
          entry: entry.startsWith('#') ? '' : entry,
          sourceLabel: sourceIndex >= 0 ? String(row[sourceIndex] ?? '').trim() : '',
          required: requiredIndex >= 0 ? parseBoolean(row[requiredIndex] ?? '', true) : true,
        };
      })
      .filter((row) => row.entry);
  }

  const imported: ImportRow[] = [];
  let activeLabel = '';
  for (const row of rows) {
    const joined = row.length >= 3 && /^(direct|reseller)$/i.test(row[2] ?? '')
      ? row.slice(0, 4).join(', ')
      : row.join(', ');
    const entry = joined.replace(/^\uFEFF/, '').trim();
    if (!entry) continue;
    if (entry.startsWith('#')) {
      const heading = entry.replace(/^#+\s*/, '').trim();
      if (heading) activeLabel = heading;
      continue;
    }
    imported.push({ entry, sourceLabel: activeLabel, required: true });
  }
  return imported;
}
'''

path.write_text(source[:start] + replacement + source[end:])
