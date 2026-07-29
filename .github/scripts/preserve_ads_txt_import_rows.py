from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
path = ROOT / 'src/components/AdsTxtPanel.tsx'
text = path.read_text(encoding='utf-8')

pattern = re.compile(
    r"function importRowsFromText\(text: string\): ImportRow\[] \{.*?\n\}\n\nfunction manualEntryCount",
    re.DOTALL,
)
replacement = r'''function importRowsFromText(text: string): ImportRow[] {
  const normalizedText = text.replace(/^\uFEFF/, '');
  const rows = csvRows(normalizedText);
  if (!rows.length) return [];

  const header = rows[0].map((value) => value.trim().toLowerCase().replace(/[ -]+/g, '_'));
  const entryIndex = header.findIndex((value) => ['entry', 'ads_txt_entry', 'ads.txt_entry'].includes(value));
  const sourceIndex = header.findIndex((value) => ['source_label', 'source', 'label', 'partner'].includes(value));
  const requiredIndex = header.findIndex((value) => ['required', 'mandatory'].includes(value));

  if (entryIndex >= 0) {
    return rows
      .slice(1)
      .map((row) => {
        const entry = String(row[entryIndex] ?? '').trim();
        return {
          entry,
          sourceLabel: (sourceIndex >= 0 ? row[sourceIndex] : '')?.trim()
            || labelFromEntry(entry),
          required: requiredIndex >= 0 ? parseBoolean(row[requiredIndex] ?? '', true) : true,
        };
      })
      .filter((row) => Boolean(lineWithoutComment(row.entry)));
  }

  const imported: ImportRow[] = [];
  let activeLabel = '';
  for (const rawLine of normalizedText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      activeLabel = line.replace(/^#+\s*/, '').trim() || activeLabel;
      continue;
    }
    if (!lineWithoutComment(line)) continue;
    imported.push({
      entry: line,
      sourceLabel: activeLabel || labelFromEntry(line),
      required: true,
    });
  }
  return imported;
}

function manualEntryCount'''

updated, count = pattern.subn(replacement, text, count=1)
if count != 1:
    raise SystemExit(f'Expected to replace one importRowsFromText function, replaced {count}.')
path.write_text(updated, encoding='utf-8')
